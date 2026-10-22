import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"

const STALE_LOCK_MS = 60_000

/** What triggered a session-summary flush. */
export type FlushSource = "idle" | "compaction" | "cleanup"

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

  /** Runs one lock-guarded flush. Skips silently when another instance holds
   * the project lock. Never throws. */
  async flushNow(sessionID: string, cwd: string, source: FlushSource): Promise<void> {
    try {
      mkdirSync(this.opts.lockDir, { recursive: true })
    } catch {
      return
    }
    const lockPath = lockPathFor(this.opts.lockDir, cwd)
    if (!tryAcquireLock(lockPath, this.opts.now?.() ?? Date.now())) return
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
