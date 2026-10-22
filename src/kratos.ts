import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
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

export type Runner = (command: string[], opts: ExecOptions) => Promise<ExecOutcome>

export type CaptureEvent = "user-prompt" | "post-tool-use" | "session-end"

export interface Kratos {
  context(args: { cwd: string; budget?: number; timeoutMs?: number }): Promise<string>
  capture(
    event: CaptureEvent,
    payload: unknown,
    args: { cwd: string; timeoutMs?: number },
  ): Promise<string>
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

/** Builds a Kratos client over an injectable runner. `context`/`capture`
 * return trimmed stdout, or "" on any failure — they never throw. */
export function createKratos(prefix: string[], run: Runner): Kratos {
  async function runOrEmpty(command: string[], opts: ExecOptions): Promise<string> {
    try {
      const outcome = await run(command, opts)
      if (outcome.code !== 0) return ""
      return outcome.stdout.trim()
    } catch {
      return ""
    }
  }

  return {
    context(args) {
      const command = [...prefix, "context"]
      if (args.budget !== undefined) command.push("--budget", String(args.budget))
      return runOrEmpty(command, {
        cwd: args.cwd,
        timeoutMs: args.timeoutMs ?? CONTEXT_TIMEOUT_MS,
      })
    },
    capture(event, payload, args) {
      return runOrEmpty([...prefix, "capture", "--event", event], {
        cwd: args.cwd,
        timeoutMs: args.timeoutMs ?? CAPTURE_TIMEOUT_MS,
        stdin: JSON.stringify(payload),
      })
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
