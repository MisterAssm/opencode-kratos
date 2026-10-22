# opencode-kratos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `opencode-kratos` — an OpenCode V2 plugin giving OpenCode the same automatic kratos-memory integration Claude Code has (context injection, per-prompt recall, tool-event capture, session summaries), published to npm and GitHub.

**Architecture:** Thin adapter. The plugin maps OpenCode plugin hooks (`session.hook` context/prompt/compaction, `ctx.tool.hook execute.after`, `session.idle` events) to kratos CLI calls (`kratos context`, `kratos capture --event …`). All memory logic stays in kratos. Binary resolution probes once in the background; every hook callback is wrapped so failures never break sessions.

**Tech Stack:** TypeScript (erasable syntax only — Node 24 native type stripping), `@opencode/plugin` ^2.1.2 (only runtime dep), `node:test` for tests, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-10-22-opencode-kratos-design.md`

## Global Constraints

- Package: name `opencode-kratos`, version `0.1.0`, MIT, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, engines `>=22.18.0`, `files: ["src"]`.
- TypeScript: strict, `module: "nodenext"`, `target: "es2022"`, `erasableSyntaxOnly: true`. No enums, no namespaces, no parameter properties.
- Runtime dependencies: `@opencode/plugin` ONLY. Dev: `typescript`, `@types/node`. Nothing else.
- Tests run with `node --test test/` on Node 24 (native TS type stripping). CI uses Node 24.
- kratos invocations (exact): `[...prefix, "context", "--budget", String(N)?]`, `[...prefix, "capture", "--event", "user-prompt"|"post-tool-use"|"session-end"]` with `JSON.stringify(payload)` on stdin.
- Binary prefix resolution order: `options.binary` → `~/.kratos/bin/kratos` (if the file exists) → `["npx", "--yes", "kratos-memory"]`.
- Timeouts: recall 5 000 ms, context 10 000 ms, capture 5 000 ms, session-end flush 30 000 ms, probe of launcher/binary-override 5 000 ms, probe of npx 60 000 ms.
- Never throw from a hook callback; never register tools (`ctx.tool.transform` is forbidden — token-cost anti-goal).
- Debug logging prefix: `[kratos]` via `console.log` (lands in the OpenCode server log).
- Conventional commits (`feat:`, `test:`, `docs:`, `chore:`, `ci:`).
- **Spec amendment:** probe the resolved binary with `--help` (exit code 0) instead of `capture --event __probe__` — commander exits before any command action, so the probe cannot register a spurious project in kratos's registry.

## Review Focus

The five failure modes most likely to bite a user, each pinned to the task whose tests must cover it:

1. **Kratos missing or broken (stale launcher, npx offline)** — every feature no-ops, sessions never break. Tests: Task 2 (probe failure → `resolveKratos` returns null), Task 4 (null client → hooks no-op), Task 5 (exec failure → prompt text unchanged).
2. **Hung/slow kratos process** — timeouts cut execution. Tests: Task 2 (runner rejects on timeout → `context()`/`capture()` return `""`).
3. **Malformed tool input** (missing `path`, non-string fields, `input: null`) — translation never throws. Tests: Task 3 (garbage inputs → safe payload).
4. **Recall produces empty output** (short prompt, slash command, below relevance threshold) — prompt text must be byte-identical to the original. Tests: Task 5 (empty stdout → no append).
5. **Duplicate/contended session flush** (two plugin instances, one project) — the loser skips silently. Tests: Task 7 (lock held → flush skipped; stale lock → taken over).

---

### Task 1: Scaffold + config module

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE` (MIT, copyright 2026 MisterAssm)
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `resolveOptions(raw: unknown): KratosPluginOptions` where

```ts
interface KratosPluginOptions {
  binary: string              // default ""
  context: boolean            // default true
  recall: boolean             // default true
  capture: boolean            // default true
  summary: boolean            // default true
  idleDebounceMinutes: number // default 15
  contextBudget: number | undefined // default undefined
  debug: boolean              // default false
}
```

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`

Test names and assertions:
- `resolveOptions(undefined)` returns every default above.
- `resolveOptions({ recall: false, idleDebounceMinutes: 0, contextBudget: 2000, binary: "/x/kratos", debug: true })` reflects all five, leaves `context`/`capture`/`summary` true.
- `resolveOptions({ recall: "no", idleDebounceMinutes: -5, contextBudget: "big" })` falls back to defaults for those three fields (invalid type or negative number).
- `resolveOptions({ nonsense: true })` returns defaults without throwing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.ts`
Expected: FAIL — cannot find module `../src/config.ts`

- [ ] **Step 3: Scaffold the project**

`package.json` per Global Constraints (deps: `@opencode/plugin` ^2.1.2; devDeps: `typescript` ^5.9, `@types/node` ^24; scripts: `test`: `node --test test/`, `typecheck`: `tsc --noEmit`). `tsconfig.json` per Global Constraints with `include: ["src", "test"]`. `.gitignore`: `node_modules/`. Run `npm install`.

- [ ] **Step 4: Implement `resolveOptions` in `src/config.ts`**

One rule the signature doesn't determine: booleans accepted only when `typeof === "boolean"`; `idleDebounceMinutes` only when a non-negative finite number; `contextBudget` only when a positive finite number; `binary` only a non-empty string.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/config.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold package and config options"
```

### Task 2: Kratos client (prefix resolution, probe, exec with timeout)

**Files:**
- Create: `src/kratos.ts`, `test/kratos.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:

```ts
interface ExecOptions { cwd: string; timeoutMs?: number; stdin?: string }
interface ExecOutcome { stdout: string; code: number }
type Runner = (command: string[], opts: ExecOptions) => Promise<ExecOutcome>

interface Kratos {
  context(args: { cwd: string; budget?: number; timeoutMs?: number }): Promise<string>
  capture(event: "user-prompt" | "post-tool-use" | "session-end", payload: unknown,
          args: { cwd: string; timeoutMs?: number }): Promise<string>
}

function createKratos(prefix: string[], run: Runner): Kratos
async function resolveKratos(binaryOverride: string, log: (msg: string) => void,
  io?: { exists?: (p: string) => boolean; run?: Runner }): Promise<Kratos | null>
```

`context`/`capture` return trimmed stdout, or `""` on any failure (non-zero exit, timeout, spawn error) — they never throw. Default `timeoutMs`: context 10 000, capture 5 000.

- [ ] **Step 1: Write failing tests** in `test/kratos.test.ts` with a hand-rolled fake `Runner` (records calls; scripts outcomes)

- `context({ cwd: "/p" })` invokes `run` with `[prefix, "context"]`, `{ cwd: "/p", timeoutMs: 10000, stdin: undefined }` and returns trimmed stdout.
- `context({ cwd: "/p", budget: 2000 })` invokes `[prefix, "context", "--budget", "2000"]`.
- `capture("user-prompt", { prompt: "x" }, { cwd: "/p" })` invokes `[prefix, "capture", "--event", "user-prompt"]` with `stdin: '{"prompt":"x"}'`, `timeoutMs: 5000`.
- Runner rejects → `context` and `capture` resolve `""`.
- `resolveKratos("/x/kratos", noop, { run: fakeOk })` probes `["/x/kratos", "--help"]` (timeoutMs 5000) and returns a client whose prefix is `["/x/kratos"]`.
- `resolveKratos("", noop, { exists: () => false, run: fakeOk })` skips the launcher, probes `["npx", "--yes", "kratos-memory", "--help"]` (timeoutMs 60000) and returns the npx-prefixed client.
- `resolveKratos("", log, { exists: () => true, run: fakeFail })` probes launcher (fail), then npx (fail) → returns `null` and `log` was called at least once.
- `resolveKratos("", noop, { exists: () => true, run: fakeOk })` returns the launcher-prefixed client (probed with timeoutMs 5000).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/kratos.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/kratos.ts`**

`execCommand` uses `node:child_process` `spawn` with `stdio: ["pipe","pipe","pipe"]`, writes `stdin`, kills with `SIGKILL` on timeout, collects stdout as UTF-8, rejects on spawn error/timeout. `resolveKratos` walks the prefix order from Global Constraints, probes with `--help`, checks exit code 0. Default `io`: `exists` = `fs.existsSync(path.join(homedir(), ".kratos", "bin", "kratos"))`, `run` = the real `execCommand`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/kratos.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/kratos.ts test/kratos.test.ts && git commit -m "feat: kratos client with prefix resolution, probe, and timeouts"
```

### Task 3: Tool payload translation

**Files:**
- Create: `src/translate.ts`, `test/translate.test.ts`

**Interfaces:**
- Produces:

```ts
interface CapturePayload { tool_name: string; tool_input: { file_path?: string; command?: string } }
function translateToolEvent(tool: string, input: unknown): CapturePayload
```

- [ ] **Step 1: Write failing tests** in `test/translate.test.ts`

- `translateToolEvent("edit", { path: "/a.ts", oldString: "x", newString: "y" })` → `{ tool_name: "Edit", tool_input: { file_path: "/a.ts" } }`
- `translateToolEvent("write", { path: "/b.ts", content: "hi" })` → `{ tool_name: "Write", tool_input: { file_path: "/b.ts" } }`
- `translateToolEvent("patch", { path: "/c.ts", patchText: "…" })` → `{ tool_name: "MultiEdit", tool_input: { file_path: "/c.ts" } }`
- `translateToolEvent("shell", { command: "ls", workdir: "/p" })` → `{ tool_name: "Bash", tool_input: { command: "ls" } }`
- `translateToolEvent("bash", { command: "ls" })` → `{ tool_name: "Bash", tool_input: { command: "ls" } }` (both names map)
- `translateToolEvent("read", { path: "/d.ts" })` → `{ tool_name: "read", tool_input: {} }` (generic pass-through)
- Field fallback chain: `translateToolEvent("edit", { filePath: "/e.ts" })` and `translateToolEvent("edit", { file_path: "/e.ts" })` both → `file_path: "/e.ts"`
- Garbage inputs never throw: `translateToolEvent("edit", null)`, `translateToolEvent("write", { path: 42 })`, `translateToolEvent("edit", "string")` → generic payload `{ tool_name: "edit", tool_input: {} }` (or Edit-mapping with no `file_path` — either is acceptable; assert no throw and `tool_input.file_path` is undefined)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/translate.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/translate.ts`**

Mapping table: `edit`→`Edit`, `write`→`Write`, `patch`→`MultiEdit`, `shell`|`bash`→`Bash`; everything else passes its own name through. File-field chain `path`→`filePath`→`file_path` (first value that is a string); `command` when a string.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/translate.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/translate.ts test/translate.test.ts && git commit -m "feat: translate opencode tool events to kratos capture payloads"
```

### Task 4: Plugin core — setup, wiring, context injection

**Files:**
- Create: `src/index.ts`, `test/index.test.ts`

**Interfaces:**
- Consumes: `resolveOptions` (Task 1), `resolveKratos`/`Kratos` (Task 2).
- Produces: the plugin default export (`Plugin.define({ id: "kratos", setup })`); `setup` returns an async cleanup that disposes all registrations. Internal helpers later tasks rely on (exported for tests): `sessionCwd(get: (i: string) => Promise<unknown>, sessionID: string): Promise<string | undefined>` and `wrap(fn: () => Promise<void>): Promise<void>` (never throws).

- [ ] **Step 1: Write failing tests** in `test/index.test.ts` with a mock `ctx`

Mock ctx records hook registrations: `ctx.session.hook(name, cb)` stores `cb`; `ctx.session.get` returns `{ location: { directory: "/proj" } }`; `ctx.tool.hook`, `ctx.command.transform`, `ctx.event.subscribe` are stubs; `ctx.options` is a plain object. Inject a fake `Kratos` by exporting `__setKratosForTests(client | null)` from `src/index.ts` (test-only seam; production resolves via `resolveKratos`).

- `setup(ctx)` registers `session.hook("context", …)`.
- Firing the context hook (mock kratos `context` → `"PROJECT MEMORY: …"`) pushes exactly one system part `{ type: "text", text: "<kratos-context>\nPROJECT MEMORY: …\n</kratos-context>" }` onto `event.system`.
- Firing twice for the same `sessionID` calls mock `context` once (cache); a new `sessionID` calls it again.
- Mock kratos `context` resolves `""` → nothing pushed.
- `__setKratosForTests(null)` → hook fires, nothing happens, no throw.
- Mock kratos `context` rejects → no throw, nothing pushed (Review Focus 1 & 2).
- `ctx.options = { context: false }` → hook not registered.
- `contextBudget: 2000` is passed through to mock `context` args.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/index.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/index.ts`**

`setup(ctx)`: resolve options; create logger (`debug ? console.log.bind(console) : () => {}`, prefix `[kratos]`); start `resolveKratos` in the background (do NOT await — server start must not block; hook handlers `await` the promise, bounded by its internal probe timeouts); register the context hook: `const kratos = await kratosPromise; if (!kratos || !opts.context) return; const cached = cache.get(sessionID); …` — cache is a `Map<string, string>` capped at 100 entries (delete the oldest key on insert). Every registration lands in a `registrations` array; cleanup disposes them all. The whole hook body runs inside `wrap` (try/catch + log).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ && npx tsc --noEmit`
Expected: PASS (all files)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts && git commit -m "feat: plugin setup with background kratos resolution and context injection"
```

### Task 5: Prompt recall

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4's wiring; `Kratos.capture` (Task 2).

- [ ] **Step 1: Write failing tests** (extend `test/index.test.ts`)

- `setup(ctx)` with default options registers `session.hook("prompt", …)`.
- Firing the prompt hook with `{ prompt: { text: "how does auth work?" }, sessionID: "s1" }` (mock capture → `"Kratos recall — saved memories relevant to this prompt:\n- JWT auth…"`) mutates `prompt.text` to the original + `"\n\n<kratos-recall>\n" + stdout + "\n</kratos-recall>"`.
- Mock capture → `""` (kratos silent: short prompt / below threshold) → `prompt.text` is byte-identical to the original (Review Focus 4).
- Mock capture rejects → `prompt.text` unchanged, no throw.
- `ctx.options = { recall: false }` → prompt hook not registered.
- Mock `ctx.session.get` throws → prompt text unchanged, no throw (Review Focus 1).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/index.test.ts`
Expected: FAIL (prompt hook absent)

- [ ] **Step 3: Implement the prompt hook in `src/index.ts`**

Resolve cwd via `sessionCwd`; call `kratos.capture("user-prompt", { prompt: text }, { cwd, timeoutMs: 5000 })`; append the block only when stdout is non-empty. Wrap everything.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts && git commit -m "feat: per-prompt memory recall injection"
```

### Task 6: Tool-event capture

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts` (extend)

**Interfaces:**
- Consumes: `translateToolEvent` (Task 3), `Kratos.capture` (Task 2).

- [ ] **Step 1: Write failing tests**

- `setup(ctx)` registers `tool.hook("execute.after", …)`.
- Firing with `{ tool: "write", input: { path: "/a.ts" }, status: "completed", sessionID: "s1" }` calls mock `capture("post-tool-use", { tool_name: "Write", tool_input: { file_path: "/a.ts" } }, { cwd: "/proj", timeoutMs: 5000 })`.
- `status: "error"` events never call capture.
- Mock capture rejects → no throw.
- `{ capture: false }` → hook not registered.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/index.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement in `src/index.ts`**

Translate, then `capture("post-tool-use", payload, { cwd, timeoutMs: 5000 })`. Fire-and-forget is acceptable here (do not await in the hot path) but failures must still be caught — use `void promise.catch(log)`. Wrap.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts && git commit -m "feat: buffer tool events into kratos capture"
```

### Task 7: Session summaries — scheduler, lock, compaction, idle, cleanup

**Files:**
- Create: `src/summary.ts`, `test/summary.test.ts`
- Modify: `src/index.ts`, `test/index.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
function lockPathFor(lockDir: string, cwd: string): string  // sha256(cwd) hex, first 32 chars + ".lock"
function tryAcquireLock(lockPath: string, now: number, staleMs?: number): boolean  // default staleMs 60000
function releaseLock(lockPath: string): void

class FlushScheduler {
  constructor(opts: { debounceMs: number; lockDir: string;
    onFlush: (sessionID: string, cwd: string, source: "idle" | "compaction" | "cleanup") => Promise<void>;
    now?: () => number })
  onIdle(sessionID: string, cwd: string): void
  async flushNow(sessionID: string, cwd: string, source: "idle" | "compaction" | "cleanup"): Promise<void>
  pending(): string[]
  dispose(): void  // clears timers, does NOT flush
}
```

Lock semantics: `tryAcquireLock` creates the file with flag `"wx"`; if creation fails and the existing file's mtime is older than `staleMs`, replace it (unlink + recreate) and succeed; otherwise fail. `flushNow` acquires, and only if acquired awaits `onFlush`, releasing in `finally`.

- [ ] **Step 1: Write failing tests** in `test/summary.test.ts` (use a temp dir; `node:test` mock timers via `mock.timers`)

- `tryAcquireLock` on a free path → true, file exists; second immediate `tryAcquireLock` → false (Review Focus 5).
- Lock with mtime 61 s old → `tryAcquireLock` at "now" → true (stale takeover).
- `lockPathFor("/locks", "/a")` ≠ `lockPathFor("/locks", "/b")`.
- `FlushScheduler` with `debounceMs: 1000`: two `onIdle("s1", "/p")` calls 500 ms apart → `onFlush("s1", "/p", "idle")` fires exactly once, 1000 ms after the second call (re-schedule semantics).
- `debounceMs: 0` → flush fires on next tick.
- `pending()` lists `"s1"` while a timer is armed; empty after flush.
- `dispose()` cancels armed timers (`onFlush` never called afterwards).
- `flushNow("s1", "/p", "compaction")` with the lock already held → `onFlush` NOT called, no throw.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/summary.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/summary.ts`**

`onIdle` clears any existing timer for the sessionID and arms a new one (`setTimeout` → `void flushNow(..., "idle").catch(log)`). `flushNow` is lock-guarded per Global Constraints. Use `fs.openSync(path, "wx")` / `fs.statSync` / `fs.rmSync` (sync fs is fine for tiny lock files).

- [ ] **Step 4: Extend `test/index.test.ts`**

- `setup(ctx)` registers `session.hook("compaction", …)` and subscribes to events (`ctx.event.subscribe` mock yields a controllable async iterable).
- Compaction hook fires with `{ sessionID: "s1" }` → `FlushScheduler.flushNow` path invoked with source `"compaction"` (observe via mock kratos capture receiving `"session-end"` with `timeoutMs: 30000`, or via an injected scheduler spy — choose the mock-kratos observation).
- Emitting `{ type: "session.idle", data: { sessionID: "s1" } }` on the event stream → with `idleDebounceMinutes: 0`, capture receives `"session-end"`.
- The compaction flush is fire-and-forget: the hook callback resolves before the flush completes (assert the registration callback returns without awaiting a deferred flush promise).
- `{ summary: false }` → no compaction hook, no event subscription side effects.
- Cleanup (the function `setup` returns): with `idleDebounceMinutes: 0` and an armed pending session, invoking cleanup triggers a `"session-end"` capture with source `"cleanup"` (best-effort).

- [ ] **Step 5: Run tests to verify they fail, then wire `src/index.ts`**

Run: `node --test test/`
Expected: FAIL → then implement: subscribe with an `AbortController`; on `session.idle` resolve cwd and `scheduler.onIdle`; compaction hook → `void scheduler.flushNow(..., "compaction")`; cleanup aborts the subscription, disposes registrations, and best-effort-flushes every `pending()` session (overall 30 s bound).

Run: `node --test test/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/summary.ts src/index.ts test/ && git commit -m "feat: debounced, lock-guarded session summaries"
```

### Task 8: /memory command

**Files:**
- Create: `src/command.ts`
- Modify: `src/index.ts`, `test/index.test.ts` (extend)

**Interfaces:**
- Produces: `memoryCommandPrompt(): string`

- [ ] **Step 1: Write failing tests**

- `memoryCommandPrompt()` returns exactly: `"Check the project memory with the shell tool: run \`npx kratos-memory status\` and \`npx kratos-memory recent --limit 10\`, then summarize the memory state in a short bullet list: total memories, most recent work, and any pinned decisions."` (exact copy)
- `setup(ctx)` registers a command named `memory` (description: `"Review kratos project memory (status + recent)"`) whose `execute` calls `ctx.session.prompt` with `{ sessionID, ...prompt, text: memoryCommandPrompt(), delivery }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/index.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/command.ts` and wire the registration in `src/index.ts`** via `ctx.command.transform` (per the plugins guide's command example).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/command.ts src/index.ts test/ && git commit -m "feat: /memory command"
```

### Task 9: README, CI, npm metadata

**Files:**
- Create: `README.md`, `.github/workflows/ci.yml`
- Modify: `package.json` (add `description`, `keywords`, `repository`, `license`, `files`)

**Interfaces:**
- Consumes: the finished feature set of Tasks 1–8.

- [ ] **Step 1: Write `README.md`** (English), covering exactly: one-paragraph pitch; the hook-mapping table from the spec; requirements (OpenCode V2, kratos or the automatic npx fallback, and a note that global kratos install is faster); install section with the one-line config

```jsonc
{ "plugins": [{ "package": "opencode-kratos" }] }
```

full options reference table (all eight options with defaults from Task 1); how it works per feature including the idle-debounce flush strategy and why; troubleshooting (kratos not found, nothing captured, enable `debug: true` and read the server log at `~/.local/share/opencode/log/opencode.log`); known limitations from the spec (no git post-commit capture, shared buffer across concurrent sessions, mid-session saves appear next session); development section (install, `npm test`, `npm run typecheck`, `npm run e2e`); MIT license; credit to `ceorkm/kratos-cli`.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**: on push + PR; `actions/checkout@v5`, `actions/setup-node@v5` with `node-version: 24`, `npm install`, `npm run typecheck`, `npm test`.

- [ ] **Step 3: Complete package metadata**: `description: "Persistent kratos-memory integration for OpenCode — context injection, per-prompt recall, auto-capture, session summaries"`, `keywords: ["opencode", "opencode-plugin", "kratos", "memory", "ai-agents"]`, `repository`, `license: "MIT"`, `files: ["src"]`, script `"e2e": "node e2e/run.mjs"`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml"); puts "YAML-OK"'`
Expected: PASS + YAML-OK (ruby ships with macOS; if unavailable, any YAML parser that loads the file without error)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: README, CI workflow, and npm metadata"
```

### Task 10: End-to-end verification

**Files:**
- Create: `e2e/run.mjs`

**Interfaces:**
- Consumes: everything. This task is the proof the spec's Goal 5 is met.

- [ ] **Step 1: Write `e2e/run.mjs`** implementing exactly this flow:

1. `mkdtemp` a project dir; `git init` it.
2. Write `opencode.json` in it: `{ "plugins": [{ "package": "<repo root abs path>", "options": { "idleDebounceMinutes": 0, "debug": true } }] }`.
3. In that cwd, run `npx --yes kratos-memory save "E2E canary: the deploy checklist requires SSH key rotation every 90 days" --tags e2e` (assert exit 0).
4. **Recall phase:** run `opencode run --standalone "What is the SSH key rotation policy for deploys?"` with cwd = project. Assert the OpenCode server log (`~/.local/share/opencode/log/opencode.log`, newest lines written during the run) contains a `[kratos]` recall line, or (fallback assertion) that the session transcript (via `opencode api`) contains `kratos-recall` or the canary text. If neither: FAIL with the log tail printed.
5. **Capture/summary phase:** run `opencode run --standalone "Create a file named hello.txt containing the word hi"` with cwd = project. Then run `npx --yes kratos-memory recent --json` in that cwd and assert a memory exists with tag `session-summary` (or `auto-capture`) mentioning `hello.txt`. Print which flush source fired (`idle` / `cleanup`) based on `[kratos]` log lines.
6. If the live tool field names differ from Task 3's assumptions (recall: `edit`/`write`/`patch` take `path`; shell tool is `shell` with `command`), fix `src/translate.ts` + its tests and re-run all tests. This is the sanctioned correction point.
7. Exit 0 on success with a PASS summary; non-zero with details on failure. Clean up the temp dir unless `KEEP=1`.

- [ ] **Step 2: Run the E2E**

Run: `npm run e2e`
Expected: PASS — recall injected, session summary saved, flush source reported

- [ ] **Step 3: Run the full suite one more time**

Run: `npm run typecheck && npm test && npm run e2e`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add e2e/run.mjs && git commit -m "test: end-to-end verification script"
```

### Task 11: Publish

**Files:**
- Modify: none (repository creation, npm publish)

**Interfaces:**
- Consumes: Tasks 1–10 complete and green.

- [ ] **Step 1: User action — npm login.** The machine is not authenticated (`npm whoami` → ENEEDAUTH). Ask the human partner to run `npm login` in a terminal (interactive browser flow). Then verify: `npm whoami` prints their username.

- [ ] **Step 2: Dry-run publish**

Run: `npm publish --dry-run`
Expected: tarball contains `src/**`, `README.md`, `LICENSE`, `package.json` — nothing else

- [ ] **Step 3: Publish to npm**

Run: `npm publish`
Expected: `+ opencode-kratos@0.1.0`; verify with `npm view opencode-kratos version` → `0.1.0`

- [ ] **Step 4: Create the GitHub repo and push**

```bash
gh repo create MisterAssm/opencode-kratos --public --description "Persistent kratos-memory integration for OpenCode" --source . --remote origin --push
git tag v0.1.0 && git push origin v0.1.0
```

Expected: repo live at `https://github.com/MisterAssm/opencode-kratos` with full history and tag

- [ ] **Step 5: Smoke-test the published artifact** — in a fresh temp project, configure `"plugins": [{ "package": "opencode-kratos" }]`, run `opencode run --standalone "say hi"`, and confirm no plugin errors in the server log.

- [ ] **Step 6: Commit any final touches** (e.g. badge URLs in README pointing at the real repo)

```bash
git add -A && git commit -m "chore: post-publish touches" && git push
```
