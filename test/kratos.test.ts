import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { createKratos, resolveKratos } from "../src/kratos.ts"
import type { Runner } from "../src/kratos.ts"

const PREFIX = ["/fake/kratos"]
const LAUNCHER = path.join(os.homedir(), ".kratos", "bin", "kratos")

function makeRunner(outcome: { stdout?: string; code?: number } | "fail") {
  const calls: { command: string[]; opts: Record<string, unknown> }[] = []
  const run: Runner = async (command, opts) => {
    calls.push({ command, opts: { ...opts } })
    if (outcome === "fail") throw new Error("boom")
    return { stdout: outcome.stdout ?? "", code: outcome.code ?? 0 }
  }
  return { run, calls }
}

test("context() runs the context command with default timeout and trims stdout", async () => {
  const { run, calls } = makeRunner({ stdout: "  memory block  \n" })
  const kratos = createKratos(PREFIX, run)
  const out = await kratos.context({ cwd: "/p" })
  assert.equal(out, "memory block")
  assert.deepEqual(calls[0].command, ["/fake/kratos", "context"])
  assert.equal(calls[0].opts.cwd, "/p")
  assert.equal(calls[0].opts.timeoutMs, 10000)
  assert.equal(calls[0].opts.stdin, undefined)
})

test("context() passes --budget when given", async () => {
  const { run, calls } = makeRunner({ stdout: "x" })
  const kratos = createKratos(PREFIX, run)
  await kratos.context({ cwd: "/p", budget: 2000 })
  assert.deepEqual(calls[0].command, ["/fake/kratos", "context", "--budget", "2000"])
})

test("capture() pipes the JSON payload on stdin with default timeout", async () => {
  const { run, calls } = makeRunner({ stdout: "recall line" })
  const kratos = createKratos(PREFIX, run)
  const out = await kratos.capture("user-prompt", { prompt: "x" }, { cwd: "/p" })
  assert.equal(out, "recall line")
  assert.deepEqual(calls[0].command, ["/fake/kratos", "capture", "--event", "user-prompt"])
  assert.equal(calls[0].opts.stdin, '{"prompt":"x"}')
  assert.equal(calls[0].opts.timeoutMs, 5000)
  assert.equal(calls[0].opts.cwd, "/p")
})

test("context() and capture() resolve empty string when the runner fails", async () => {
  const { run } = makeRunner("fail")
  const kratos = createKratos(PREFIX, run)
  assert.equal(await kratos.context({ cwd: "/p" }), "")
  assert.equal(await kratos.capture("session-end", {}, { cwd: "/p" }), "")
})

test("a non-zero exit code also resolves empty string", async () => {
  const { run } = makeRunner({ stdout: "partial output", code: 1 })
  const kratos = createKratos(PREFIX, run)
  assert.equal(await kratos.context({ cwd: "/p" }), "")
})

test("resolveKratos uses the binary override and probes it with --help", async () => {
  const { run, calls } = makeRunner({ stdout: "" })
  const kratos = await resolveKratos("/x/kratos", () => {}, { run })
  assert.ok(kratos)
  assert.deepEqual(calls[0].command, ["/x/kratos", "--help"])
  assert.equal(calls[0].opts.timeoutMs, 5000)
  await kratos.context({ cwd: "/p" })
  assert.deepEqual(calls[1].command, ["/x/kratos", "context"])
})

test("resolveKratos falls back to npx when no launcher exists", async () => {
  const { run, calls } = makeRunner({ stdout: "" })
  const kratos = await resolveKratos("", () => {}, { exists: () => false, run })
  assert.ok(kratos)
  assert.deepEqual(calls[0].command, ["npx", "--yes", "kratos-memory", "--help"])
  assert.equal(calls[0].opts.timeoutMs, 60000)
  await kratos.context({ cwd: "/p" })
  assert.deepEqual(calls[1].command, ["npx", "--yes", "kratos-memory", "context"])
})

test("resolveKratos returns null and logs when every candidate fails", async () => {
  const logs: string[] = []
  const { run, calls } = makeRunner("fail")
  const kratos = await resolveKratos("", (m) => logs.push(m), { exists: () => true, run })
  assert.equal(kratos, null)
  assert.deepEqual(calls[0].command, [LAUNCHER, "--help"])
  assert.deepEqual(calls[1].command, ["npx", "--yes", "kratos-memory", "--help"])
  assert.ok(logs.length >= 1)
})

test("resolveKratos prefers the launcher when it exists and probes ok", async () => {
  const { run, calls } = makeRunner({ stdout: "" })
  const kratos = await resolveKratos("", () => {}, { exists: () => true, run })
  assert.ok(kratos)
  assert.deepEqual(calls[0].command, [LAUNCHER, "--help"])
  assert.equal(calls[0].opts.timeoutMs, 5000)
  await kratos.context({ cwd: "/p" })
  assert.equal(calls[1].command[0], LAUNCHER)
})
