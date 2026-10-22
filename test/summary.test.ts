import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FlushScheduler, lockPathFor, tryAcquireLock, releaseLock, flushTriggerSessionID } from "../src/summary.ts"

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kratos-summary-test-"))
}

test("flushTriggerSessionID accepts session.idle events", () => {
  assert.equal(flushTriggerSessionID({ type: "session.idle", data: { sessionID: "ses_1" } }), "ses_1")
})

test("flushTriggerSessionID accepts execution-completion events (headless runs never emit session.idle)", () => {
  for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
    assert.equal(flushTriggerSessionID({ type, data: { sessionID: "ses_2" } }), "ses_2", type)
  }
})

test("flushTriggerSessionID rejects unrelated events, malformed payloads, and non-objects", () => {
  assert.equal(flushTriggerSessionID({ type: "session.step.started", data: { sessionID: "ses_3" } }), undefined)
  assert.equal(flushTriggerSessionID({ type: "session.idle" }), undefined)
  assert.equal(flushTriggerSessionID({ type: "session.idle", data: {} }), undefined)
  assert.equal(flushTriggerSessionID({ type: "session.idle", data: { sessionID: 42 } }), undefined)
  assert.equal(flushTriggerSessionID(null), undefined)
  assert.equal(flushTriggerSessionID("session.idle"), undefined)
})

test("tryAcquireLock acquires a free path and blocks a second immediate attempt", () => {
  const dir = tempDir()
  const lockPath = path.join(dir, "a.lock")
  assert.equal(tryAcquireLock(lockPath, Date.now()), true)
  assert.equal(existsSync(lockPath), true)
  assert.equal(tryAcquireLock(lockPath, Date.now()), false)
  releaseLock(lockPath)
  assert.equal(tryAcquireLock(lockPath, Date.now()), true)
  releaseLock(lockPath)
  rmSync(dir, { recursive: true, force: true })
})

test("tryAcquireLock takes over a lock that is older than the staleness threshold", () => {
  const dir = tempDir()
  const lockPath = path.join(dir, "stale.lock")
  assert.equal(tryAcquireLock(lockPath, Date.now()), true)
  const sixtyOneSecondsAgo = new Date(Date.now() - 61_000)
  utimesSync(lockPath, sixtyOneSecondsAgo, sixtyOneSecondsAgo)
  assert.equal(tryAcquireLock(lockPath, Date.now()), true)
  releaseLock(lockPath)
  rmSync(dir, { recursive: true, force: true })
})

test("lockPathFor produces distinct paths per cwd", () => {
  assert.notEqual(lockPathFor("/locks", "/a"), lockPathFor("/locks", "/b"))
})

/** Drains pending microtasks without touching (possibly mocked) timers. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => process.nextTick(resolve))
  }
}

test("FlushScheduler re-schedules on repeated idle events and flushes once", async () => {
  const flushes: { sessionID: string; cwd: string; source: string }[] = []
  const scheduler = new FlushScheduler({
    debounceMs: 1000,
    lockDir: tempDir(),
    onFlush: async (sessionID, cwd, source) => {
      flushes.push({ sessionID, cwd, source })
    },
  })
  mock.timers.enable()
  scheduler.onIdle("s1", "/p")
  assert.deepEqual(scheduler.pending(), ["s1"])
  mock.timers.tick(500)
  scheduler.onIdle("s1", "/p")
  mock.timers.tick(1000)
  await drainMicrotasks()
  assert.equal(flushes.length, 1)
  assert.deepEqual(flushes[0], { sessionID: "s1", cwd: "/p", source: "idle" })
  assert.deepEqual(scheduler.pending(), [])
  mock.timers.reset()
})

test("FlushScheduler with zero debounce flushes on the next tick", async () => {
  const flushes: string[] = []
  const scheduler = new FlushScheduler({
    debounceMs: 0,
    lockDir: tempDir(),
    onFlush: async (sessionID) => {
      flushes.push(sessionID)
    },
  })
  mock.timers.enable()
  scheduler.onIdle("s1", "/p")
  mock.timers.tick(1)
  await drainMicrotasks()
  assert.equal(flushes.length, 1)
  mock.timers.reset()
})

test("dispose cancels armed timers", async () => {
  const flushes: string[] = []
  const scheduler = new FlushScheduler({
    debounceMs: 1000,
    lockDir: tempDir(),
    onFlush: async (sessionID) => {
      flushes.push(sessionID)
    },
  })
  mock.timers.enable()
  scheduler.onIdle("s1", "/p")
  scheduler.dispose()
  mock.timers.tick(2000)
  await drainMicrotasks()
  assert.equal(flushes.length, 0)
  assert.deepEqual(scheduler.pending(), [])
  mock.timers.reset()
})

test("flushNow skips silently when the lock is already held", async () => {
  const dir = tempDir()
  const flushes: string[] = []
  const scheduler = new FlushScheduler({
    debounceMs: 0,
    lockDir: dir,
    onFlush: async (sessionID) => {
      flushes.push(sessionID)
    },
  })
  assert.equal(tryAcquireLock(lockPathFor(dir, "/p"), Date.now()), true)
  await scheduler.flushNow("s1", "/p", "compaction")
  assert.equal(flushes.length, 0)
  releaseLock(lockPathFor(dir, "/p"))
  rmSync(dir, { recursive: true, force: true })
})

test("flushPending flushes every armed session with the given source", async () => {
  const flushes: { sessionID: string; source: string }[] = []
  const scheduler = new FlushScheduler({
    debounceMs: 60_000,
    lockDir: tempDir(),
    onFlush: async (sessionID, _cwd, source) => {
      flushes.push({ sessionID, source })
    },
  })
  scheduler.onIdle("s1", "/p1")
  scheduler.onIdle("s2", "/p2")
  await scheduler.flushPending("cleanup")
  assert.deepEqual(flushes.sort((a, b) => a.sessionID.localeCompare(b.sessionID)), [
    { sessionID: "s1", source: "cleanup" },
    { sessionID: "s2", source: "cleanup" },
  ])
  assert.deepEqual(scheduler.pending(), [])
})
