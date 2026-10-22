import { Plugin } from "@opencode/plugin"
import { resolveOptions } from "./config.ts"
import { resolveKratos } from "./kratos.ts"
import type { Kratos } from "./kratos.ts"
import { translateToolEvent } from "./translate.ts"

const CONTEXT_CACHE_MAX = 100

/** Test-only seam: when set (even to null), setup uses this client instead of
 * resolving one. Undefined means "production mode". */
let kratosOverride: Kratos | null | undefined = undefined

export function __setKratosForTests(client: Kratos | null): void {
  kratosOverride = client
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
    const log = opts.debug ? (msg: string) => console.log(`[kratos] ${msg}`) : () => {}

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

    return async () => {
      for (const registration of registrations) {
        await registration.dispose()
      }
    }
  },
})
