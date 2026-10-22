import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDebugLogger } from "../src/log.ts"

test("disabled logger is a noop that never touches the filesystem", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kratos-log-test-"))
  const log = createDebugLogger(false, dir)
  log("should not be written")
  assert.equal(existsSync(path.join(dir, "debug.log")), false)
  rmSync(dir, { recursive: true, force: true })
})

test("enabled logger appends [kratos]-prefixed lines to debug.log", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kratos-log-test-"))
  const log = createDebugLogger(true, dir)
  log("first message")
  log("second message")
  const content = readFileSync(path.join(dir, "debug.log"), "utf-8")
  assert.equal(content, "[kratos] first message\n[kratos] second message\n")
  rmSync(dir, { recursive: true, force: true })
})

test("write failures are swallowed silently", () => {
  const blocker = mkdtempSync(path.join(tmpdir(), "kratos-log-test-"))
  const notADir = path.join(blocker, "occupied")
  writeFileSync(notADir, "i am a file, not a directory")
  const log = createDebugLogger(true, notADir)
  log("this must not throw")
  rmSync(blocker, { recursive: true, force: true })
})
