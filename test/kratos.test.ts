import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { createKratos, resolveKratos, execDetached, execCommand } from "../src/kratos.ts"
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

test("context() resolves null and capture() resolves empty string when the runner fails", async () => {
  const { run } = makeRunner("fail")
  const kratos = createKratos(PREFIX, run)
  assert.equal(await kratos.context({ cwd: "/p" }), null)
  assert.equal(await kratos.capture("session-end", {}, { cwd: "/p" }), "")
})

test("a non-zero exit code also resolves null for context", async () => {
  const { run } = makeRunner({ stdout: "partial output", code: 1 })
  const kratos = createKratos(PREFIX, run)
  assert.equal(await kratos.context({ cwd: "/p" }), null)
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

test("capture() with detached spawns fire-and-forget, bypassing the runner", async () => {
  const { run, calls } = makeRunner({ stdout: "x" })
  const detached: { command: string[]; opts: Record<string, unknown> }[] = []
  const kratos = createKratos(PREFIX, run, (command, opts) => {
    detached.push({ command, opts: { ...opts, cwd: opts.cwd, stderrPath: opts.stderrPath } })
  })
  const out = await kratos.capture("session-end", {}, {
    cwd: "/p",
    detached: true,
    timeoutMs: 30_000,
    stderrPath: "/log/dbg.log",
  })
  assert.equal(out, "")
  assert.equal(calls.length, 0, "the awaitable runner must not be used for detached captures")
  assert.deepEqual(detached[0].command, ["/fake/kratos", "capture", "--event", "session-end"])
  assert.equal(detached[0].opts.cwd, "/p")
  assert.equal(detached[0].opts.stderrPath, "/log/dbg.log")
  assert.equal(detached[0].opts.timeoutMs, undefined)
})

test("execDetached runs the command without blocking on its completion", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kratos-detached-"))
  const marker = path.join(dir, "marker.txt")
  try {
    execDetached(["/bin/sh", "-c", `echo done > ${JSON.stringify(marker)}`], { cwd: dir })
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        assert.equal(readFileSync(marker, "utf-8").trim(), "done")
        break
      } catch {
        if (Date.now() > deadline) assert.fail("detached child never wrote the marker")
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("execDetached never throws, not even for a nonexistent binary", async () => {
  execDetached(["/definitely/not/a/binary", "--flag"], { cwd: os.tmpdir() })
  // The spawn error fires asynchronously; a missing error handler would crash
  // the process. Give it a tick to prove the handler swallows it.
  await new Promise((r) => setTimeout(r, 100))
})

// --- Real-process battery for execCommand ---
// Every test above injects a fake Runner; these exercise the real spawner —
// the code that runs inside the OpenCode server process, where an unhandled
// stream error crashes the whole server (plugins load in-process).

test("execCommand resolves real stdout and exit code", async () => {
  const outcome = await execCommand(["/usr/bin/printf", "hello"], { cwd: os.tmpdir() })
  assert.equal(outcome.code, 0)
  assert.equal(outcome.stdout, "hello")
})

test("execCommand delivers stdin to the child end-to-end", async () => {
  const outcome = await execCommand(["/usr/bin/wc", "-c"], { cwd: os.tmpdir(), stdin: "hello world" })
  assert.equal(outcome.code, 0)
  assert.equal(outcome.stdout.trim(), "11")
})

test("execCommand survives a child that exits before reading a large stdin (EPIPE)", async () => {
  // /usr/bin/true exits immediately without reading stdin. A payload larger
  // than the pipe buffer (~64KB) cannot be fully written, so once the child
  // dies the pending flushes hit EPIPE on child.stdin. Without an error
  // listener on that stream the 'error' event is unhandled and crashes the
  // process — exactly the server-crash failure mode plugins must never hit.
  const outcome = await execCommand(["/usr/bin/true"], {
    cwd: os.tmpdir(),
    stdin: "x".repeat(256 * 1024),
  })
  assert.equal(outcome.code, 0)
})

test("execCommand rejects on timeout without crashing on the killed child's stdin (EPIPE)", async () => {
  await assert.rejects(
    execCommand(["/bin/sleep", "10"], {
      cwd: os.tmpdir(),
      timeoutMs: 250,
      stdin: "x".repeat(256 * 1024),
    }),
    /timeout after 250ms/,
  )
})

test("execCommand rejects for a nonexistent binary, even with stdin", async () => {
  await assert.rejects(
    execCommand(["/definitely/not/a/binary", "--flag"], { cwd: os.tmpdir(), stdin: "x" }),
    /ENOENT/,
  )
})
