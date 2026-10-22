import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

export interface ExecOptions {
  cwd: string
  timeoutMs?: number
  stdin?: string
}

export interface ExecOutcome {
  stdout: string
  code: number
}

export interface DetachedSpawnOptions {
  cwd: string
  /** File the child's stderr is appended to (debugging). Optional. */
  stderrPath?: string
}

/** Fire-and-forget detached spawn: runs a command in a new process group
 * with no stdio, so it survives this process's exit. Used for session-end
 * captures — the OpenCode server only grants ~1-2s of shutdown grace, which
 * is too short for a capture to be awaited reliably. */
export type DetachedSpawner = (command: string[], opts: DetachedSpawnOptions) => void

export type Runner = (command: string[], opts: ExecOptions) => Promise<ExecOutcome>

export type CaptureEvent = "user-prompt" | "post-tool-use" | "session-end"

export interface CaptureArgs {
  cwd: string
  timeoutMs?: number
  /** Fire-and-forget: the capture runs in a detached child that survives
   * this process. The payload is not delivered (kratos defaults it to `{}`,
   * which is what session-end takes) and timeoutMs is ignored. */
  detached?: boolean
  /** Passed through to the detached child's stderr (see DetachedSpawnOptions). */
  stderrPath?: string
}

export interface Kratos {
  /** Trimmed stdout, or null when execution failed (the caller can retry). */
  context(args: { cwd: string; budget?: number; timeoutMs?: number }): Promise<string | null>
  capture(event: CaptureEvent, payload: unknown, args: CaptureArgs): Promise<string>
}

const CONTEXT_TIMEOUT_MS = 10_000
const CAPTURE_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_NPX_MS = 60_000
const EXEC_DEFAULT_TIMEOUT_MS = 30_000

/** Runs a command, resolving with its stdout and exit code. Rejects on spawn
 * error or timeout (SIGKILL after timeoutMs). Never throws for non-zero exits. */
export function execCommand(command: string[], opts: ExecOptions): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    // If the child exits (or is killed) before consuming a large stdin
    // payload, pending writes fail with EPIPE on this stream. An unhandled
    // 'error' event would crash the process — and plugins run in-process
    // inside the OpenCode server. The command's outcome is governed by
    // 'close'/'error' on the child itself; a failed stdin delivery only
    // means the child never got the payload, so the error is swallowed.
    child.stdin.on("error", () => {})
    const timeoutMs = opts.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS
    let stdout = ""
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`timeout after ${timeoutMs}ms: ${command.join(" ")}`))
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8")
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, code: code ?? 0 })
    })

    if (opts.stdin !== undefined) child.stdin.write(opts.stdin)
    child.stdin.end()
  })
}

/** Spawns a fire-and-forget child that survives this process's exit (new
 * process group, no stdio, unref'd). Never throws: spawn errors are swallowed
 * via an error handler (an unhandled 'error' event would crash the process).
 * When stderrPath is given and openable, the child's stderr is appended to
 * that file for post-mortem debugging. */
export function execDetached(command: string[], opts: DetachedSpawnOptions): void {
  try {
    let stderr: number | "ignore" = "ignore"
    if (opts.stderrPath !== undefined) {
      try {
        stderr = openSync(opts.stderrPath, "a")
      } catch {
        stderr = "ignore"
      }
    }
    const child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "ignore", stderr],
    })
    child.on("error", () => {})
    child.unref()
    if (typeof stderr === "number") closeSync(stderr)
  } catch {
    // Best effort — captures are optional by design.
  }
}

/** Builds a Kratos client over an injectable runner. `context` returns
 * trimmed stdout, or null on execution failure (spawn error, timeout,
 * non-zero exit) so callers can distinguish a failed fetch from an empty
 * project memory. `capture` returns "" on any failure — captures are
 * fire-and-forget, there is nothing to retry. Detached captures bypass the
 * runner entirely and resolve "" immediately. Neither ever throws. */
export function createKratos(prefix: string[], run: Runner, spawnDetached: DetachedSpawner = execDetached): Kratos {
  async function runOrNull(command: string[], opts: ExecOptions): Promise<ExecOutcome | null> {
    try {
      return await run(command, opts)
    } catch {
      return null
    }
  }

  return {
    async context(args) {
      const command = [...prefix, "context"]
      if (args.budget !== undefined) command.push("--budget", String(args.budget))
      const outcome = await runOrNull(command, {
        cwd: args.cwd,
        timeoutMs: args.timeoutMs ?? CONTEXT_TIMEOUT_MS,
      })
      if (outcome === null || outcome.code !== 0) return null
      return outcome.stdout.trim()
    },
    async capture(event, payload, args) {
      if (args.detached) {
        spawnDetached([...prefix, "capture", "--event", event], {
          cwd: args.cwd,
          stderrPath: args.stderrPath,
        })
        return ""
      }
      const outcome = await runOrNull([...prefix, "capture", "--event", event], {
        cwd: args.cwd,
        timeoutMs: args.timeoutMs ?? CAPTURE_TIMEOUT_MS,
        stdin: JSON.stringify(payload),
      })
      if (outcome === null || outcome.code !== 0) return ""
      return outcome.stdout.trim()
    },
  }
}

/** Resolves a working kratos invocation prefix. Order: explicit binary
 * override → ~/.kratos/bin/kratos launcher → npx fallback. Each candidate is
 * probed once with `--help`; the first that exits 0 wins. Returns null when
 * nothing works. */
export async function resolveKratos(
  binaryOverride: string,
  log: (msg: string) => void,
  io?: { exists?: (p: string) => boolean; run?: Runner },
): Promise<Kratos | null> {
  const exists = io?.exists ?? ((p: string) => existsSync(p))
  const run = io?.run ?? execCommand

  const launcherPath = path.join(homedir(), ".kratos", "bin", "kratos")
  const candidates: { prefix: string[]; probeTimeoutMs: number }[] = []
  if (binaryOverride.length > 0) {
    candidates.push({ prefix: [binaryOverride], probeTimeoutMs: PROBE_TIMEOUT_MS })
  }
  if (exists(launcherPath)) {
    candidates.push({ prefix: [launcherPath], probeTimeoutMs: PROBE_TIMEOUT_MS })
  }
  candidates.push({ prefix: ["npx", "--yes", "kratos-memory"], probeTimeoutMs: PROBE_TIMEOUT_NPX_MS })

  for (const candidate of candidates) {
    try {
      const outcome = await run([...candidate.prefix, "--help"], {
        cwd: tmpdir(),
        timeoutMs: candidate.probeTimeoutMs,
      })
      if (outcome.code === 0) return createKratos(candidate.prefix, run)
      log(`probe failed: ${candidate.prefix.join(" ")} (exit ${outcome.code})`)
    } catch (err) {
      log(`probe failed: ${candidate.prefix.join(" ")} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  return null
}
