import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"

/** A flush holds the project lock for at most ~6s (5s capture-wait cap plus
 * the spawn itself), so a lock older than this can only belong to a crashed
 * holder. Keeping the threshold tight lets the next flush recover quickly
 * from a holder that died mid-flush (e.g. the OpenCode server shutting down
 * right after a headless run). */
const STALE_LOCK_MS = 10_000

/** What triggered a session-summary flush. */
export type FlushSource = "idle" | "compaction" | "cleanup"

/** Event types that mark a session as quiet — the trigger to arm a flush.
 * `session.idle` covers interactive sessions; execution completion
 * (succeeded / failed / interrupted) covers headless `opencode run` sessions,
 * which never emit `session.idle`. */
const FLUSH_TRIGGER_TYPES = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/** Returns the sessionID when the event marks a session as quiet (arm the
 * debounced flush), undefined otherwise. Tolerates any malformed payload. */
export function flushTriggerSessionID(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const e = event as { type?: unknown; data?: { sessionID?: unknown } }
  if (typeof e.type !== "string" || !FLUSH_TRIGGER_TYPES.has(e.type)) return undefined
  const sessionID = e.data?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

/** Lock file path for a project directory: lockDir/<sha256(cwd) truncated>.lock */
export function lockPathFor(lockDir: string, cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 32)
  return path.join(lockDir, `${hash}.lock`)
}

/** Best-effort exclusive lock via O_EXCL creation. A lock older than the
 * staleness threshold is considered abandoned (holder crashed) and taken over.
 * Never throws. */
export function tryAcquireLock(lockPath: string, now: number, staleMs: number = STALE_LOCK_MS): boolean {
  try {
    const fd = openSync(lockPath, "wx")
    closeSync(fd)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") return false
    try {
      const mtimeMs = statSync(lockPath).mtimeMs
      if (now - mtimeMs <= staleMs) return false
      rmSync(lockPath, { force: true })
    } catch {
      return false
    }
    try {
      const fd = openSync(lockPath, "wx")
      closeSync(fd)
      return true
    } catch {
      return false
    }
  }
}

/** Releases a lock acquired via tryAcquireLock. Never throws. */
export function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true })
  } catch {
    // Already gone or unremovable — nothing to do.
  }
}

export interface FlushSchedulerOptions {
  /** Idle debounce window in milliseconds. 0 flushes on the next tick. */
  debounceMs: number
  /** Directory holding the per-project flush locks. */
  lockDir: string
  /** Invoked at most once per idle window per session, under the project lock. */
  onFlush: (sessionID: string, cwd: string, source: FlushSource) => Promise<void>
  /** Invoked when a flush is skipped because another instance holds the
   * project lock (visibility — the skip itself is by design). Optional. */
  onLockSkip?: (sessionID: string, cwd: string) => void
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

/** Debounces session-summary flushes. Each `session.idle` event for a session
 * re-arms its timer (cadence-independent). Flushes are serialized per project
 * through a lock file so concurrent OpenCode instances on the same project
 * never double-summarize. All failures are swallowed. */
export class FlushScheduler {
  private opts: FlushSchedulerOptions
  private timers = new Map<string, NodeJS.Timeout>()
  private cwds = new Map<string, string>()

  constructor(opts: FlushSchedulerOptions) {
    this.opts = opts
  }

  /** Arms (or re-arms) the idle debounce timer for a session. */
  onIdle(sessionID: string, cwd: string): void {
    const existing = this.timers.get(sessionID)
    if (existing !== undefined) clearTimeout(existing)
    this.cwds.set(sessionID, cwd)
    const timer = setTimeout(() => {
      this.timers.delete(sessionID)
      this.cwds.delete(sessionID)
      void this.flushNow(sessionID, cwd, "idle").catch(() => {})
    }, this.opts.debounceMs)
    this.timers.set(sessionID, timer)
  }

  /** Runs one lock-guarded flush. Skips (with an optional report via
   * onLockSkip) when another instance holds the project lock. Never throws. */
  async flushNow(sessionID: string, cwd: string, source: FlushSource): Promise<void> {
    try {
      mkdirSync(this.opts.lockDir, { recursive: true })
    } catch {
      return
    }
    const lockPath = lockPathFor(this.opts.lockDir, cwd)
    if (!tryAcquireLock(lockPath, this.opts.now?.() ?? Date.now())) {
      this.opts.onLockSkip?.(sessionID, cwd)
      return
    }
    try {
      await this.opts.onFlush(sessionID, cwd, source)
    } finally {
      releaseLock(lockPath)
    }
  }

  /** SessionIDs with an armed idle timer. */
  pending(): string[] {
    return [...this.timers.keys()]
  }

  /** Flushes every armed session immediately with the given source, disarming
   * their timers first so no idle flush can race or double-fire. */
  async flushPending(source: FlushSource): Promise<void> {
    const armed = [...this.timers.keys()]
    for (const sessionID of armed) {
      const timer = this.timers.get(sessionID)
      if (timer !== undefined) clearTimeout(timer)
      this.timers.delete(sessionID)
    }
    const flushes: Promise<void>[] = []
    for (const sessionID of armed) {
      const cwd = this.cwds.get(sessionID)
      this.cwds.delete(sessionID)
      if (cwd !== undefined) flushes.push(this.flushNow(sessionID, cwd, source))
    }
    await Promise.allSettled(flushes)
  }

  /** Cancels all armed timers without flushing. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.cwds.clear()
  }
}
