import { test } from "node:test"
import assert from "node:assert/strict"
import pluginDefault, { __setKratosForTests, sessionCwd, wrap } from "../src/index.ts"
import type { Kratos } from "../src/kratos.ts"

type HookCb = (event: any) => Promise<void> | void

function makeCtx(options: Record<string, unknown> = {}) {
  const sessionHooks = new Map<string, HookCb[]>()
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
    },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    command: { transform: async () => ({ dispose: async () => {} }) },
    event: {
      subscribe: async function* () {
        // yields nothing by default
      },
    },
  }
  return { ctx: ctx as any, sessionHooks }
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
