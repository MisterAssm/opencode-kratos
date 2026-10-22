import { test } from "node:test"
import assert from "node:assert/strict"
import { createPendingCaptures } from "../src/pending.ts"

function deferred(): { promise: Promise<string>; resolve: (v: string) => void; reject: (e: unknown) => void } {
  let resolve!: (v: string) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("awaitPending resolves immediately when nothing is tracked", async () => {
  const pending = createPendingCaptures()
  await pending.awaitPending("/a", 100)
  assert.equal(pending.count("/a"), 0)
})

test("awaitPending waits for in-flight captures of the same cwd", async () => {
  const pending = createPendingCaptures()
  const gate = deferred()
  pending.track("/a", gate.promise)
  assert.equal(pending.count("/a"), 1)
  let settled = false
  const waited = pending.awaitPending("/a", 2000).then(() => {
    settled = true
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(settled, false)
  gate.resolve("done")
  await waited
  assert.equal(settled, true)
})

test("awaitPending ignores captures tracked for other cwds", async () => {
  const pending = createPendingCaptures()
  const gate = deferred()
  pending.track("/other", gate.promise)
  const start = Date.now()
  await pending.awaitPending("/a", 5000)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 2500, `resolved in ${elapsed}ms — waited on a foreign cwd's capture`)
  gate.resolve("done")
})

test("awaitPending gives up after the timeout cap", async () => {
  const pending = createPendingCaptures()
  const gate = deferred()
  pending.track("/a", gate.promise)
  const start = Date.now()
  await pending.awaitPending("/a", 120)
  const elapsed = Date.now() - start
  assert.ok(elapsed >= 100, `gave up after only ${elapsed}ms`)
  gate.resolve("done")
})

test("settled captures are deregistered and stop blocking later flushes", async () => {
  const pending = createPendingCaptures()
  const gate = deferred()
  pending.track("/a", gate.promise)
  gate.resolve("done")
  await gate.promise
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(pending.count("/a"), 0)
  const start = Date.now()
  await pending.awaitPending("/a", 2000)
  assert.ok(Date.now() - start < 1000, "waited on an already-settled capture")
})

test("rejected captures are deregistered without unhandled rejections", async () => {
  const pending = createPendingCaptures()
  const gate = deferred()
  pending.track("/a", gate.promise)
  gate.reject(new Error("spawn failed"))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(pending.count("/a"), 0)
  await pending.awaitPending("/a", 100)
})
