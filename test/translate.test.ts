import { test } from "node:test"
import assert from "node:assert/strict"
import { translateToolEvent } from "../src/translate.ts"

test("edit maps to Edit with file_path from path", () => {
  const payload = translateToolEvent("edit", { path: "/a.ts", oldString: "x", newString: "y" })
  assert.deepEqual(payload, { tool_name: "Edit", tool_input: { file_path: "/a.ts" } })
})

test("write maps to Write with file_path from path", () => {
  const payload = translateToolEvent("write", { path: "/b.ts", content: "hi" })
  assert.deepEqual(payload, { tool_name: "Write", tool_input: { file_path: "/b.ts" } })
})

test("patch maps to MultiEdit with file_path from path", () => {
  const payload = translateToolEvent("patch", { path: "/c.ts", patchText: "…" })
  assert.deepEqual(payload, { tool_name: "MultiEdit", tool_input: { file_path: "/c.ts" } })
})

test("shell maps to Bash with command", () => {
  const payload = translateToolEvent("shell", { command: "ls", workdir: "/p" })
  assert.deepEqual(payload, { tool_name: "Bash", tool_input: { command: "ls" } })
})

test("bash also maps to Bash with command", () => {
  const payload = translateToolEvent("bash", { command: "ls" })
  assert.deepEqual(payload, { tool_name: "Bash", tool_input: { command: "ls" } })
})

test("unmapped tools pass their own name through with empty input", () => {
  const payload = translateToolEvent("read", { path: "/d.ts" })
  assert.deepEqual(payload, { tool_name: "read", tool_input: {} })
})

test("file field falls back to filePath then file_path", () => {
  assert.deepEqual(translateToolEvent("edit", { filePath: "/e.ts" }), {
    tool_name: "Edit",
    tool_input: { file_path: "/e.ts" },
  })
  assert.deepEqual(translateToolEvent("edit", { file_path: "/e.ts" }), {
    tool_name: "Edit",
    tool_input: { file_path: "/e.ts" },
  })
})

test("garbage inputs never throw and drop file_path", () => {
  for (const input of [null, undefined, "string", 42, [], { path: 42 }, { path: { deep: true } }]) {
    const payload = translateToolEvent("edit", input)
    assert.ok(payload !== null && payload !== undefined)
    assert.equal(payload.tool_name, "Edit")
    assert.equal(payload.tool_input.file_path, undefined)
  }
})

test("non-string command is dropped", () => {
  const payload = translateToolEvent("shell", { command: 123 })
  assert.deepEqual(payload, { tool_name: "Bash", tool_input: {} })
})
