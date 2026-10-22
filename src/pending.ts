/** Tracks in-flight post-tool-use capture promises per project directory.
 *
 * kratos summarizes a session by reading its per-project event buffer at
 * `capture --event session-end`. Post-tool-use captures are spawned
 * asynchronously (hundreds of ms each), so a flush that fires at
 * execution-completion can race the very captures it is meant to summarize:
 * kratos would read a buffer that does not yet hold the last tool events.
 * The capture hook registers each in-flight capture here; the flush awaits
 * them (bounded) before spawning the session-end. */

export interface PendingCaptures {
  /** Registers an in-flight capture for a project directory. The promise is
   * never rejected downstream (a settle handler is attached here), and the
   * entry removes itself when it settles. */
  track(cwd: string, capture: Promise<string>): void
  /** Resolves once every capture tracked for `cwd` has settled, or after
   * `timeoutMs` — whichever comes first. Never rejects. */
  awaitPending(cwd: string, timeoutMs: number): Promise<void>
  /** Number of currently in-flight captures for `cwd`. */
  count(cwd: string): number
}

export function createPendingCaptures(): PendingCaptures {
  const byCwd = new Map<string, Set<Promise<string>>>()
  return {
    track(cwd, capture) {
      let set = byCwd.get(cwd)
      if (set === undefined) {
        set = new Set()
        byCwd.set(cwd, set)
      }
      set.add(capture)
      const remove = () => {
        const current = byCwd.get(cwd)
        if (current === undefined) return
        current.delete(capture)
        if (current.size === 0) byCwd.delete(cwd)
      }
      // then() with both handlers deregisters on settle and marks the
      // original promise handled — no unhandled-rejection downstream.
      capture.then(remove, remove)
    },
    async awaitPending(cwd, timeoutMs) {
      const set = byCwd.get(cwd)
      if (set === undefined || set.size === 0) return
      let timer: NodeJS.Timeout | undefined
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
      try {
        await Promise.race([Promise.allSettled([...set]), cap])
      } finally {
        clearTimeout(timer)
      }
    },
    count(cwd) {
      return byCwd.get(cwd)?.size ?? 0
    },
  }
}
