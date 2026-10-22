import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import path from "node:path"
import { resolveOptions } from "./config.ts"
import { resolveKratos } from "./kratos.ts"
import type { Kratos } from "./kratos.ts"
import { translateToolEvent } from "./translate.ts"
import { FlushScheduler } from "./summary.ts"
import { memoryCommandPrompt } from "./command.ts"
import { createDebugLogger } from "./log.ts"

const CONTEXT_CACHE_MAX = 100

/** Test-only seam: when set (even to null), setup uses this client instead of
 * resolving one. Undefined means "production mode". */
let kratosOverride: Kratos | null | undefined = undefined

export function __setKratosForTests(client: Kratos | null): void {
  kratosOverride = client
}

/** Test-only seam: overrides the plugin's state directory (~/.kratos/opencode-kratos
 * — flush locks and debug log) so unit tests never touch ~/.kratos (a crashed
 * test run would otherwise leave a stale lock that silences flushes for 60s).
 * Undefined means "production mode". */
let stateDirOverride: string | undefined = undefined

export function __setStateDirForTests(dir: string | null): void {
  stateDirOverride = dir ?? undefined
}

/** Resolves a session's project directory, or undefined when the session
 * cannot be resolved. Never throws. */
export async function sessionCwd(
  get: (...args: any[]) => Promise<unknown>,
  sessionID: string,
): Promise<string | undefined> {
  try {
    const info = await get({ sessionID })
    if (typeof info === "object" && info !== null) {
      const location = (info as { location?: { directory?: unknown } }).location
      if (typeof location?.directory === "string") return location.directory
    }
  } catch {
    // Session unresolvable — callers skip gracefully.
  }
  return undefined
}

/** Runs fn, swallowing any error. Hook callbacks must never break a session. */
export async function wrap(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    // Deliberately silent: see design doc, graceful degradation rules.
  }
}

export default Plugin.define({
  id: "kratos",
  async setup(ctx) {
    const opts = resolveOptions(ctx.options)
    // OpenCode v2 swallows plugin console.log output, so debug lines go to a
    // file under the plugin state dir instead.
    const stateDir = stateDirOverride ?? path.join(homedir(), ".kratos", "opencode-kratos")
    const log = createDebugLogger(opts.debug, stateDir)

    // Resolve kratos in the background: server startup must not block on the
    // probe (npx can take up to 60s on a cold cache). Hook handlers await
    // this promise, bounded by the probe timeouts inside resolveKratos.
    const kratosPromise: Promise<Kratos | null> =
      kratosOverride !== undefined ? Promise.resolve(kratosOverride) : resolveKratos(opts.binary, log)

    const registrations: { dispose(): Promise<void> }[] = []

    // --- Session context injection (Claude Code SessionStart equivalent) ---
    // Fires on every model call; the kratos context block is fetched once per
    // session and cached, then pushed as a system part on each call.
    const contextCache = new Map<string, string>()
    if (opts.context) {
      registrations.push(
        await ctx.session.hook("context", (event) =>
          wrap(async () => {
            const kratos = await kratosPromise
            if (!kratos) return
            const sessionID = event.sessionID
            let block = contextCache.get(sessionID)
            if (block === undefined) {
              const cwd = await sessionCwd(ctx.session.get, sessionID)
              if (!cwd) return
              block = await kratos.context({ cwd, budget: opts.contextBudget })
              if (block.length > 0) {
                if (contextCache.size >= CONTEXT_CACHE_MAX) {
                  const oldest = contextCache.keys().next().value
                  if (oldest !== undefined) contextCache.delete(oldest)
                }
                contextCache.set(sessionID, block)
              }
            }
            if (block !== undefined && block.length > 0) {
              event.system.push({ type: "text", text: `<kratos-context>\n${block}\n</kratos-context>` })
            }
          }),
        ),
      )
      log("context injection hook registered")
    }

    // --- Per-prompt memory recall (Claude Code UserPromptSubmit equivalent) ---
    // kratos's own gating applies inside the CLI: prompts under 12 chars,
    // slash commands, and sub-threshold matches produce no output.
    if (opts.recall) {
      registrations.push(
        await ctx.session.hook("prompt", (event) =>
          wrap(async () => {
            const kratos = await kratosPromise
            if (!kratos) return
            const text = event.prompt.text
            if (typeof text !== "string" || text.length === 0) return
            const cwd = await sessionCwd(ctx.session.get, event.sessionID)
            if (!cwd) return
            const recall = await kratos.capture("user-prompt", { prompt: text }, { cwd })
            if (recall.length > 0) {
              event.prompt.text = `${text}\n\n<kratos-recall>\n${recall}\n</kratos-recall>`
              log(`recall injected into prompt for ${event.sessionID}`)
            }
          }),
        ),
      )
      log("prompt recall hook registered")
    }

    // --- Tool-event capture (Claude Code PostToolUse equivalent) ---
    // Fire-and-forget: never block the agent loop on buffering. Failed tool
    // calls are skipped; kratos buffers completed ones for the session summary.
    if (opts.capture) {
      registrations.push(
        await ctx.tool.hook("execute.after", (event) => {
          if (event.status !== "completed") return
          void wrap(async () => {
            const kratos = await kratosPromise
            if (!kratos) return
            const cwd = await sessionCwd(ctx.session.get, event.sessionID)
            if (!cwd) return
            const payload = translateToolEvent(event.tool, event.input)
            kratos
              .capture("post-tool-use", payload, { cwd, timeoutMs: 5000 })
              .catch((err) => log(`capture failed: ${err instanceof Error ? err.message : String(err)}`))
          })
        }),
      )
      log("tool capture hook registered")
    }

    // --- Session summaries (Claude Code Stop/SessionEnd equivalent) ---
    // `session.idle` events arm a per-session debounce; compaction (context
    // rollover) flushes immediately. Flushes are serialized per project via a
    // lock file so parallel OpenCode instances never double-summarize.
    let cleanupSummary: (() => Promise<void>) | undefined
    if (opts.summary) {
      const scheduler = new FlushScheduler({
        debounceMs: opts.idleDebounceMinutes * 60_000,
        lockDir: stateDirOverride ?? path.join(homedir(), ".kratos", "opencode-kratos", "locks"),
        onFlush: async (sessionID, cwd, source) => {
          log(`session summary flush (${source}) for ${sessionID}`)
          const kratos = await kratosPromise
          if (!kratos) return
          await kratos.capture("session-end", {}, { cwd, timeoutMs: 30_000 })
        },
      })

      registrations.push(
        await ctx.session.hook("compaction", (event) => {
          // Fire-and-forget: compaction must never block on the 30s capture.
          void wrap(async () => {
            const cwd = await sessionCwd(ctx.session.get, event.sessionID)
            if (!cwd) return
            await scheduler.flushNow(event.sessionID, cwd, "compaction")
          })
        }),
      )

      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if ((event as { type?: string }).type !== "session.idle") continue
            const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
            if (typeof sessionID !== "string") continue
            const cwd = await sessionCwd(ctx.session.get, sessionID)
            if (cwd) scheduler.onIdle(sessionID, cwd)
          }
        } catch {
          // Stream aborted or failed — summaries just stop arming.
        }
      })()

      cleanupSummary = async () => {
        controller.abort()
        await scheduler.flushPending("cleanup")
        scheduler.dispose()
      }
      log("session summary scheduler armed")
    }

    // --- /memory command ---
    // Not gated by a feature flag: it only runs when the user invokes it.
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "memory",
          description: "Review kratos project memory (status + recent)",
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({
              sessionID,
              ...prompt,
              text: memoryCommandPrompt(),
              delivery,
            })
          },
        })
      }),
    )

    return async () => {
      await cleanupSummary?.()
      for (const registration of registrations) {
        await registration.dispose()
      }
    }
  },
})
