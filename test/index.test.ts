import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import pluginDefault, { __setKratosForTests, __setStateDirForTests, sessionCwd, wrap } from "../src/index.ts"
import { memoryCommandPrompt } from "../src/command.ts"
import type { Kratos } from "../src/kratos.ts"

type HookCb = (event: any) => Promise<void> | void

function makeCtx(options: Record<string, unknown> = {}) {
  const sessionHooks = new Map<string, HookCb[]>()
  const toolHooks = new Map<string, HookCb[]>()
  const commands: any[] = []
  const promptCalls: any[] = []
  const eventQueue: any[] = []
  let wake: (() => void) | null = null
  const pushEvent = (event: any) => {
    eventQueue.push(event)
    wake?.()
  }
  const eventStream = async function* (): AsyncGenerator<any> {
    while (true) {
      while (eventQueue.length > 0) yield eventQueue.shift()!
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }
  const ctx = {
    options,
    location: { directory: "/proj" },
    session: {
      hook: async (name: string, cb: HookCb) => {
        const list = sessionHooks.get(name) ?? []
        list.push(cb)
        sessionHooks.set(name, list)
        return { dispose: async () => {} }
      },
      get: async (_input: { sessionID: string }) => ({ location: { directory: "/proj" } }),
      prompt: async (input: unknown) => {
        promptCalls.push(input)
      },
    },
    tool: {
      hook: async (name: string, cb: HookCb) => {
        const list = toolHooks.get(name) ?? []
        list.push(cb)
        toolHooks.set(name, list)
        return { dispose: async () => {} }
      },
    },
    command: {
      transform: async (cb: (editor: unknown) => void) => {
        await cb({
          add: (definition: unknown) => {
            commands.push(definition)
          },
        })
        return { dispose: async () => {} }
      },
    },
    event: { subscribe: (_opts?: unknown) => eventStream() },
  }
  return { ctx: ctx as any, sessionHooks, toolHooks, pushEvent, commands, promptCalls }
}

function fakeKratos(behavior?: {
  context?: (args: unknown) => Promise<string>
  capture?: (event: string, payload: unknown, args: unknown) => Promise<string>
}) {
  const contextCalls: unknown[] = []
  const captureCalls: { event: string; payload: unknown; args: unknown }[] = []
  const client = {
    async context(args: unknown) {
      contextCalls.push(args)
      return behavior?.context ? behavior.context(args) : Promise.resolve("PROJECT MEMORY: …")
    },
    async capture(event: string, payload: unknown, args: unknown) {
      captureCalls.push({ event, payload, args })
      return behavior?.capture ? behavior.capture(event, payload, args) : Promise.resolve("")
    },
  } as unknown as Kratos
  return { client, contextCalls, captureCalls }
}

function contextEvent(sessionID: string) {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "test", id: "m1" },
    system: [] as Array<{ type: string; text: string }>,
    messages: [],
    tools: {},
    options: {},
  }
}

async function fireContext(sessionHooks: Map<string, HookCb[]>, sessionID: string) {
  const event = contextEvent(sessionID)
  for (const cb of sessionHooks.get("context") ?? []) await cb(event)
  return event
}

test("setup registers the session context hook", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  assert.equal(sessionHooks.get("context")?.length, 1)
})

test("context hook injects one system part wrapped in kratos-context tags", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  const event = await fireContext(sessionHooks, "s1")
  assert.equal(event.system.length, 1)
  assert.deepEqual(event.system[0], {
    type: "text",
    text: "<kratos-context>\nPROJECT MEMORY: …\n</kratos-context>",
  })
})

test("context is fetched once per session and again for a new session", async () => {
  const fake = fakeKratos()
  __setKratosForTests(fake.client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  await fireContext(sessionHooks, "s1")
  await fireContext(sessionHooks, "s1")
  assert.equal(fake.contextCalls.length, 1)
  await fireContext(sessionHooks, "s2")
  assert.equal(fake.contextCalls.length, 2)
})

test("empty context output pushes nothing", async () => {
  __setKratosForTests(fakeKratos({ context: async () => "" }).client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  const event = await fireContext(sessionHooks, "s1")
  assert.equal(event.system.length, 0)
})

test("null kratos client: hook fires, nothing happens, no throw", async () => {
  __setKratosForTests(null)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  const event = await fireContext(sessionHooks, "s1")
  assert.equal(event.system.length, 0)
})

test("kratos context rejection: no throw, nothing pushed", async () => {
  __setKratosForTests(fakeKratos({ context: async () => Promise.reject(new Error("boom")) }).client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  const event = await fireContext(sessionHooks, "s1")
  assert.equal(event.system.length, 0)
})

test("context: false disables hook registration", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, sessionHooks } = makeCtx({ context: false })
  await pluginDefault.setup(ctx)
  assert.equal(sessionHooks.get("context"), undefined)
})

test("contextBudget is passed through to kratos context", async () => {
  const fake = fakeKratos()
  __setKratosForTests(fake.client)
  const { ctx, sessionHooks } = makeCtx({ contextBudget: 2000 })
  await pluginDefault.setup(ctx)
  await fireContext(sessionHooks, "s1")
  assert.equal(fake.contextCalls.length, 1)
  assert.equal((fake.contextCalls[0] as { budget?: number }).budget, 2000)
})

test("wrap swallows thrown errors", async () => {
  await wrap(() => {
    throw new Error("boom")
  })
})

test("sessionCwd resolves the session location directory", async () => {
  assert.equal(await sessionCwd(async () => ({ location: { directory: "/proj" } }), "s1"), "/proj")
})

test("sessionCwd returns undefined on failure or missing location", async () => {
  assert.equal(await sessionCwd(async () => { throw new Error("nope") }, "s1"), undefined)
  assert.equal(await sessionCwd(async () => ({ nope: true }), "s1"), undefined)
})

async function firePrompt(sessionHooks: Map<string, HookCb[]>, sessionID: string, text: string) {
  const event = {
    sessionID,
    prompt: { text },
    metadata: {},
    delivery: "steer",
  }
  for (const cb of sessionHooks.get("prompt") ?? []) await cb(event)
  return event
}

test("setup registers the prompt hook with default options", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  assert.equal(sessionHooks.get("prompt")?.length, 1)
})

test("prompt hook appends the recall block to the prompt text", async () => {
  const recallText = "Kratos recall — saved memories relevant to this prompt:\n- JWT auth…"
  __setKratosForTests(fakeKratos({ capture: async () => recallText }).client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  const event = await firePrompt(sessionHooks, "s1", "how does auth work?")
  assert.equal(
    event.prompt.text,
    "how does auth work?" + "\n\n<kratos-recall>\n" + recallText + "\n</kratos-recall>",
  )
})

test("silent capture leaves the prompt text byte-identical", async () => {
  __setKratosForTests(fakeKratos({ capture: async () => "" }).client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  const event = await firePrompt(sessionHooks, "s1", "how does auth work?")
  assert.equal(event.prompt.text, "how does auth work?")
})

test("capture rejection leaves the prompt text unchanged without throwing", async () => {
  __setKratosForTests(fakeKratos({ capture: async () => Promise.reject(new Error("boom")) }).client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  const event = await firePrompt(sessionHooks, "s1", "how does auth work?")
  assert.equal(event.prompt.text, "how does auth work?")
})

test("recall: false disables prompt hook registration", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, sessionHooks } = makeCtx({ recall: false })
  await pluginDefault.setup(ctx)
  assert.equal(sessionHooks.get("prompt"), undefined)
})

test("session.get throwing leaves the prompt text unchanged without throwing", async () => {
  __setKratosForTests(fakeKratos({ capture: async () => "recall!" }).client)
  const { ctx, sessionHooks } = makeCtx()
  ctx.session.get = async () => { throw new Error("no session") }
  await pluginDefault.setup(ctx)
  const event = await firePrompt(sessionHooks, "s1", "how does auth work?")
  assert.equal(event.prompt.text, "how does auth work?")
})

const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

test("setup registers the tool execute.after hook with default options", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, toolHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  assert.equal(toolHooks.get("execute.after")?.length, 1)
})

test("completed write events are translated and captured", async () => {
  const fake = fakeKratos()
  __setKratosForTests(fake.client)
  const { ctx, toolHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  for (const cb of toolHooks.get("execute.after") ?? []) {
    await cb({
      tool: "write",
      input: { path: "/a.ts", content: "hi" },
      sessionID: "s1",
      status: "completed",
      result: {},
    })
  }
  await flush()
  assert.equal(fake.captureCalls.length, 1)
  assert.deepEqual(fake.captureCalls[0].event, "post-tool-use")
  assert.deepEqual(fake.captureCalls[0].payload, {
    tool_name: "Write",
    tool_input: { file_path: "/a.ts" },
  })
  assert.deepEqual(fake.captureCalls[0].args, { cwd: "/proj", timeoutMs: 5000 })
})

test("failed tool events are not captured", async () => {
  const fake = fakeKratos()
  __setKratosForTests(fake.client)
  const { ctx, toolHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  for (const cb of toolHooks.get("execute.after") ?? []) {
    await cb({
      tool: "write",
      input: { path: "/a.ts" },
      sessionID: "s1",
      status: "error",
      error: { message: "nope" },
    })
  }
  await flush()
  assert.equal(fake.captureCalls.length, 0)
})

test("capture rejection during tool events does not throw", async () => {
  __setKratosForTests(fakeKratos({ capture: async () => Promise.reject(new Error("boom")) }).client)
  const { ctx, toolHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  for (const cb of toolHooks.get("execute.after") ?? []) {
    await cb({
      tool: "shell",
      input: { command: "ls" },
      sessionID: "s1",
      status: "completed",
      result: {},
    })
  }
  await flush()
})

test("capture: false disables the tool hook registration", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, toolHooks } = makeCtx({ capture: false })
  await pluginDefault.setup(ctx)
  assert.equal(toolHooks.get("execute.after"), undefined)
})

function compactionEvent(sessionID: string) {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "test", id: "m1" },
    system: [],
    messages: [],
    tools: {},
    options: {},
  }
}

/** Runs fn with a private plugin state dir so tests never touch ~/.kratos. */
function withTestStateDir(fn: () => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "kratos-locktest-"))
  __setStateDirForTests(stateDir)
  return fn().finally(() => {
    __setStateDirForTests(null)
    rmSync(stateDir, { recursive: true, force: true })
  })
}

test("setup registers the compaction hook with default options", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, sessionHooks } = makeCtx()
  await pluginDefault.setup(ctx)
  assert.equal(sessionHooks.get("compaction")?.length, 1)
})

test("compaction hook fires a session-end capture with a 30s timeout", async () => {
  await withTestStateDir(async () => {
    const fake = fakeKratos()
    __setKratosForTests(fake.client)
    const { ctx, sessionHooks } = makeCtx()
    await pluginDefault.setup(ctx)
    for (const cb of sessionHooks.get("compaction") ?? []) {
      await cb(compactionEvent("s1"))
    }
    await flush()
    assert.equal(fake.captureCalls.length, 1)
    assert.equal(fake.captureCalls[0].event, "session-end")
    assert.deepEqual(fake.captureCalls[0].payload, {})
    assert.deepEqual(fake.captureCalls[0].args, { cwd: "/proj", timeoutMs: 30000 })
  })
})

test("compaction flush is fire-and-forget: the hook returns before capture completes", async () => {
  await withTestStateDir(async () => {
    let releaseCapture!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    const fake = fakeKratos({ capture: async () => { await gate; return "" } })
    __setKratosForTests(fake.client)
    const { ctx, sessionHooks } = makeCtx()
    await pluginDefault.setup(ctx)
    for (const cb of sessionHooks.get("compaction") ?? []) {
      await cb(compactionEvent("s1"))
    }
    await flush(20)
    assert.equal(fake.captureCalls.length, 1) // started, still blocked on the gate
    releaseCapture()
    await flush(20)
  })
})

test("session.idle events trigger a debounced session-end capture", async () => {
  await withTestStateDir(async () => {
    const fake = fakeKratos()
    __setKratosForTests(fake.client)
    const { ctx, pushEvent } = makeCtx({ idleDebounceMinutes: 0 })
    await pluginDefault.setup(ctx)
    pushEvent({ type: "session.idle", data: { sessionID: "s1" } })
    await flush(100)
    assert.equal(fake.captureCalls.length, 1)
    assert.equal(fake.captureCalls[0].event, "session-end")
    assert.deepEqual(fake.captureCalls[0].payload, {})
    assert.deepEqual(fake.captureCalls[0].args, { cwd: "/proj", timeoutMs: 30000 })
  })
})

test("summary: false disables the compaction hook and idle handling", async () => {
  const fake = fakeKratos()
  __setKratosForTests(fake.client)
  const { ctx, sessionHooks, pushEvent } = makeCtx({ summary: false })
  await pluginDefault.setup(ctx)
  assert.equal(sessionHooks.get("compaction"), undefined)
  pushEvent({ type: "session.idle", data: { sessionID: "s1" } })
  await flush(100)
  assert.equal(fake.captureCalls.length, 0)
})

test("cleanup flushes armed sessions instead of dropping them", async () => {
  await withTestStateDir(async () => {
    const fake = fakeKratos()
    __setKratosForTests(fake.client)
    // Large debounce keeps the session armed (timer never fires on its own):
    // the cleanup path must be what flushes it.
    const { ctx, pushEvent } = makeCtx({ idleDebounceMinutes: 60 })
    const cleanup = (await pluginDefault.setup(ctx)) as () => Promise<void>
    pushEvent({ type: "session.idle", data: { sessionID: "s1" } })
    await flush(20)
    await cleanup()
    await flush(20)
    assert.equal(fake.captureCalls.length, 1)
    assert.equal(fake.captureCalls[0].event, "session-end")
  })
})

test("memoryCommandPrompt returns the pinned text", () => {
  assert.equal(
    memoryCommandPrompt(),
    "Check the project memory with the shell tool: run `npx kratos-memory status` and `npx kratos-memory recent --limit 10`, then summarize the memory state in a short bullet list: total memories, most recent work, and any pinned decisions.",
  )
})

test("setup registers a /memory command via command.transform", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, commands } = makeCtx()
  await pluginDefault.setup(ctx)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, "memory")
  assert.equal(commands[0].description, "Review kratos project memory (status + recent)")
  assert.equal(typeof commands[0].execute, "function")
})

test("/memory execute prompts the session with the memory command text", async () => {
  __setKratosForTests(fakeKratos().client)
  const { ctx, commands, promptCalls } = makeCtx()
  await pluginDefault.setup(ctx)
  await commands[0].execute({
    sessionID: "s1",
    prompt: { text: "/memory", files: [] },
    delivery: "steer",
  })
  assert.equal(promptCalls.length, 1)
  assert.deepEqual(promptCalls[0], {
    sessionID: "s1",
    text: memoryCommandPrompt(),
    files: [],
    delivery: "steer",
  })
})
