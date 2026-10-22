import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveOptions } from "../src/config.ts"

test("resolveOptions(undefined) returns every default", () => {
  const opts = resolveOptions(undefined)
  assert.equal(opts.binary, "")
  assert.equal(opts.context, true)
  assert.equal(opts.recall, true)
  assert.equal(opts.capture, true)
  assert.equal(opts.summary, true)
  assert.equal(opts.idleDebounceMinutes, 15)
  assert.equal(opts.contextBudget, undefined)
  assert.equal(opts.debug, false)
})

test("resolveOptions reflects valid overrides and leaves other features on", () => {
  const opts = resolveOptions({
    recall: false,
    idleDebounceMinutes: 0,
    contextBudget: 2000,
    binary: "/x/kratos",
    debug: true,
  })
  assert.equal(opts.recall, false)
  assert.equal(opts.idleDebounceMinutes, 0)
  assert.equal(opts.contextBudget, 2000)
  assert.equal(opts.binary, "/x/kratos")
  assert.equal(opts.debug, true)
  assert.equal(opts.context, true)
  assert.equal(opts.capture, true)
  assert.equal(opts.summary, true)
})

test("resolveOptions falls back to defaults on invalid values", () => {
  const opts = resolveOptions({ recall: "no", idleDebounceMinutes: -5, contextBudget: "big" })
  assert.equal(opts.recall, true)
  assert.equal(opts.idleDebounceMinutes, 15)
  assert.equal(opts.contextBudget, undefined)
})

test("resolveOptions ignores unknown keys without throwing", () => {
  const opts = resolveOptions({ nonsense: true })
  assert.deepEqual(opts, resolveOptions(undefined))
})
