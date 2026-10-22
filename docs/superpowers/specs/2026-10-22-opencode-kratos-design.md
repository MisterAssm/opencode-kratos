# opencode-kratos — Design

- **Date:** 2026-10-22
- **Status:** Approved approach (1 + 3), pending design sign-off
- **Owner:** MisterAssm

## Intent & why

[kratos-memory](https://github.com/ceorkm/kratos-cli) (npm: `kratos-memory`) is a local-first
persistent memory CLI for AI coding agents. It ships automatic integrations for Claude Code and
Codex via their hook systems, but nothing for OpenCode. OpenCode users are stuck with the manual
mode: an `AGENTS.md` file that *suggests* the agent use `npx kratos-memory`, with no enforcement
and no auto-capture.

This project delivers that missing integration as a published OpenCode V2 plugin, so OpenCode
users get the same experience Claude Code users get: memory context injected at session start,
relevant memories recalled per prompt, file edits auto-captured, and consolidated session
summaries saved — all enforced by the system, not by the model's goodwill.

**Why a plugin and not MCP:** kratos deliberately abandoned its MCP server because tool schemas
cost ~1,538 tokens per session before any memory is read. A plugin pays nothing until used. We
must not reintroduce that cost: no `ctx.tool.transform` tool registrations.

## Goals

1. Full behavioral parity with kratos's Claude Code hooks, mapped onto OpenCode V2 plugin hooks.
2. Thin adapter: **all** memory logic (PII redaction, relevance thresholds, buffering,
   compression, storage) stays in the kratos CLI. The plugin only translates events and invokes
   the CLI.
3. Graceful degradation: if kratos is not installed or fails, sessions must never break. The
   plugin disables itself quietly.
4. Published and installable by anyone in one line: `opencode-kratos` on npm, source + docs on
   GitHub (`MisterAssm/opencode-kratos`), MIT license, English README.
5. Verified working: unit tests, typecheck, and a real end-to-end run against a live OpenCode
   server with kratos installed.

## Non-goals

- OpenCode V1 support (V2 only; the dual-export pattern exists if ever needed).
- Reimplementing any kratos logic in the plugin (search ranking, redaction, compression).
- Registering MCP tools or agent tools of any kind (token-cost philosophy).
- Git post-commit capture (that is a git hook, not an OpenCode plugin concern; users can run
  `npx kratos-memory hooks install` per-project for that).
- Modifying kratos itself. If the `capture` interface needs changes, we file an issue upstream.

## Anti-goals

- **Never break a session.** Any plugin error, timeout, or missing binary must be invisible to
  the agent loop. Timeouts on every kratos invocation; catch everything.
- **No per-edit DB writes.** Kratos's design buffers edits and consolidates at flush points; we
  must respect that (no calling `kratos save` per tool event).
- **No network calls, no telemetry.** The plugin shells out to a local CLI; nothing else.

## Constraints

- OpenCode V2 plugin API (`@opencode/plugin` ^2.1.2). Plugins run inside the OpenCode background
  service and can outlive TUI sessions.
- kratos's `capture` interface is functional but undocumented:
  `kratos capture --event <type>` reads a JSON payload on stdin, dispatches to
  `user-prompt` (prints recall lines to stdout), `post-tool-use` (buffers), `session-end`
  (consolidates + clears buffer), `git-commit`. Exit is silent on unknown events.
- kratos auto-detects the project from `cwd`. The plugin must invoke it with the session's
  project directory as cwd, not the server's cwd.
- kratos's session buffer is one file per project (`~/.kratos/projects/<id>/sessions/current.json`)
  — concurrent sessions in one project share it (same limitation as Claude Code; accepted).
- The plugin distributes as raw TypeScript (`"exports": { ".": "./src/index.ts" }`); OpenCode
  loads TS natively. No build step for consumers; we still typecheck and lint in CI.

## Approaches considered

### 1. Thin adapter over the kratos CLI ✅ (chosen)

The plugin maps OpenCode hooks to existing kratos commands (`kratos context`,
`kratos capture --event …`). ~250–350 lines of glue. All logic stays in kratos; improvements to
kratos flow through automatically.

*Trade-off:* depends on the undocumented-but-stable `capture` interface. Mitigated by
feature-degradation on failure and an upstream issue to document it.

### 2. Native integration (direct SQLite access) ❌

Plugin talks to `~/.kratos/` databases directly and reimplements recall/capture.

*Rejected:* duplicates redaction, thresholds, and compression; guaranteed drift; far more code;
works against kratos's single-source-of-truth design.

### 3. Tooling extras (folded into 1) ✅

A `/memory` slash command (zero schema tokens, unlike tools) and per-feature config options.
Cheap, useful, adopted as part of approach 1.

## Decided design

### Hook mapping

| OpenCode event | Plugin action | Kratos call |
|---|---|---|
| `session.hook("context")` — every model call, cached per session | Inject memory block as a system part | `kratos context [--budget N]` once per sessionID, result cached |
| `session.hook("prompt")` — prompt admission | Append recall block to prompt text | `kratos capture --event user-prompt` stdin `{prompt}`, stdout appended |
| `ctx.tool.hook("execute.after")` — completed tool calls | Buffer edit/command events | `kratos capture --event post-tool-use` stdin translated payload |
| `session.hook("compaction")` — before context compaction | Flush session buffer | `kratos capture --event session-end` |
| `session.idle` event (debounced, default 15 min) | Flush session buffer | `kratos capture --event session-end` |
| Plugin cleanup (server shutdown) | Best-effort flush | `kratos capture --event session-end` |

Notes:
- The `context` hook fires per model call; we push the **same cached** system part each time
  (OpenCode reassembles the system prompt per call). Cache key: sessionID. One `kratos context`
  exec per session.
- Prompt recall output is **appended at the end** of `event.prompt.text` (offsets of existing
  `@mentions` are preserved; appending is safe per the prompt-hook contract). Wrapped in a
  clearly delimited block, e.g. `\n\n<kratos-recall>…</kratos-recall>`. Kratos's own
  `handleUserPrompt` already stays silent under 12-char prompts, slash commands, or below the
  relevance threshold (score ≥ 60, max 3 results) — the plugin inherits that by delegating.
- The idle debounce exists because OpenCode sessions never truly end server-side. Each
  `session.idle` event for a sessionID (re)schedules that session's debounce timer — the design
  is cadence-independent: whether idle fires once per turn or on status transitions, the flush
  happens after N minutes without a further idle event. `idleDebounceMinutes: 0` flushes
  immediately on idle (used by E2E tests).
- **Flush deduplication (topology-independent):** the OpenCode docs warn that a plugin instance
  may receive events for sessions outside its own location, so multiple plugin instances (e.g.
  one per location) could observe the same `session.idle` and race on kratos's shared per-project
  buffer. Every session-end flush is therefore guarded by a per-project lock file
  (`~/.kratos/projects/<id>/sessions/flush.lock`, created with `O_EXCL`, staleness threshold
  60 s, removed after the flush). Concurrent flushers: the loser skips silently. This makes the
  design correct under any instance/delivery topology without needing to pin one down.

### Kratos invocation

- **Binary resolution (once, cached):** `options.binary` → `~/.kratos/bin/kratos` if it exists
  (the stable launcher kratos maintains for hooks) → `npx kratos-memory` as fallback. The
  resolved binary — launcher or npx — is then **functionally probed once** with
  `kratos capture --event __probe__` (an unknown event kratos ignores silently by design, so the
  probe is a true no-op) under a short timeout. This catches the stale-launcher case where the
  shim exists but its underlying install is gone (silent `exit 0`). Probe failure → disable the
  plugin and log one warning.
- **cwd:** the session's project directory, resolved via `ctx.session.get({ sessionID })`
  (exact property verified at implementation).
- **Timeouts:** 5 s for recall (prompt admission blocks on it), 10 s for context (first model
  call), 5 s for capture buffering, 30 s for session-end consolidation. On timeout: recall and
  context silently skip; capture/flush failures are logged and dropped.
- **stdin/stdout:** JSON payload in, stdout captured (only `user-prompt` produces output).

### Payload translation

kratos's `handlePostToolUse` expects Claude-style payloads (`tool_name`, `tool_input.file_path`,
`tool_input.command`). OpenCode tools are `edit`, `write`, `bash`, `patch`, etc. The plugin
translates before piping:

| OpenCode tool | Mapped to | Input mapping |
|---|---|---|
| `edit`, `write` | `Edit` / `Write` | `filePath`/`path` → `file_path` |
| `patch` | `MultiEdit` | `path` → `file_path` |
| `bash` | `Bash` | `command` → `command` |
| any other tool | passed through with its name | — |

Exact OpenCode input field names are verified at implementation via `ctx.tool.list()` schemas or
a live session. Failed tool calls (`event.status === "error"`) are not captured.

### `/memory` command

Registered via `ctx.command.transform`. Submits a prompt to the session instructing the agent to
run `kratos status` and `kratos recent` and summarize. Zero schema tokens; purely opt-in.
Note: a prompt submitted by a command still runs the `prompt` hook, so a recall search may fire
on the status prompt — harmless (it is context-relevant by nature), left unguarded.

### Configuration (plugin options)

```jsonc
{
  "plugins": [
    {
      "package": "opencode-kratos",
      "options": {
        "binary": "",              // override kratos binary path
        "context": true,           // session context injection
        "recall": true,            // per-prompt memory recall
        "capture": true,           // tool-event buffering
        "summary": true,           // session summaries (idle debounce + compaction + cleanup)
        "idleDebounceMinutes": 15, // 0 = flush on every idle (tests)
        "contextBudget": undefined,// passed as --budget to `kratos context`
        "debug": false             // verbose logging to the OpenCode log
      }
    }
  ]
}
```

Defaults: everything on. Unknown options ignored.

### Graceful degradation rules

1. Never throw from a hook callback. Every callback body is wrapped; errors are logged (debug)
   and swallowed.
2. Kratos unavailable → resolve once, log once, no-op thereafter.
3. A failing feature (e.g. recall timeout) does not disable the others.
4. Plugin unload disposes all registrations and clears timers.

### Package layout

```
opencode-kratos/
├── package.json          # name opencode-kratos, type module, exports ".": "./src/index.ts"
├── tsconfig.json         # strict, NodeNext
├── src/
│   ├── index.ts          # Plugin.define, setup, hook registrations
│   ├── kratos.ts         # binary resolution, exec with timeout, cwd handling
│   ├── translate.ts      # OpenCode tool payloads → kratos capture payloads
│   ├── config.ts         # option parsing with defaults
│   └── command.ts        # /memory command
├── test/                 # unit tests (node:test)
├── e2e/                  # E2E script (local, requires model access)
├── .github/workflows/ci.yml  # typecheck + unit tests
├── README.md
├── LICENSE               # MIT
└── docs/superpowers/specs/…
```

- Runtime deps: `@opencode/plugin` only. Dev deps: `typescript`, `@types/node`.
- Version `0.1.0` at publish (honest about the undocumented-interface dependency).

### Testing strategy

1. **Unit (node:test):** payload translation table tests; config defaults/overrides; binary
   resolution order (mocked `fs`); debounce timer logic with fake timers; timeout wrapping.
2. **Typecheck:** `tsc --noEmit`.
3. **E2E (local, before publish):** script that
   - creates a temp git project with `opencode.json` loading the plugin from the repo path and
     `idleDebounceMinutes: 0`,
   - ensures kratos is installed (`npx kratos-memory status`),
   - saves a distinctive memory via `kratos save`,
   - runs `opencode run "…"` twice: once asking the agent to edit a file (exercises capture),
     once with a prompt matching the saved memory (exercises recall),
   - subscribes to the OpenCode event stream during the run and records whether `session.idle`
     fired headlessly, so the test attributes **which flush path** (idle vs. cleanup-on-shutdown)
     saved the summary rather than passing green for the wrong reason,
   - asserts: the recall block appears in the session transcript; the session summary memory
     exists in `~/.kratos/projects/<id>/databases/memories.db` after the run, with the observed
     flush path logged.
   E2E uses whatever model/provider the user's OpenCode is configured with. It is documented in
   the README and run manually; CI covers typecheck + unit only.

### Documentation plan (README.md, English)

- What it is, one paragraph + hook mapping table.
- Requirements (OpenCode V2, kratos or npx fallback) and install (one-line `plugins` config).
- Full options reference.
- How it works (per feature), including the flush strategy and why debouncing exists.
- Troubleshooting (kratos not found, nothing captured, debug mode).
- Development (setup, test, e2e), license, credit to kratos.

### Publishing plan

1. Repo `MisterAssm/opencode-kratos`, public, MIT, pushed with full history.
2. `npm publish` as `opencode-kratos@0.1.0` (name verified free).
3. Tag `v0.1.0`.
4. Optional, post-launch: open an issue on `ceorkm/kratos-cli` pointing at the plugin and asking
   whether the `capture` interface can be documented/stabilized.

## What's left to the builder

- Verify exact OpenCode tool input field names (`edit`/`write`/`bash`/`patch`) — via
  `ctx.tool.list()` or a live session — and adjust the translation table.
- Verify how to resolve a session's project directory from `sessionID` (the builder check
  pre-verified `ctx.session.get()` returns `location.directory`; confirm at implementation).
- Confirm `node:child_process` exec works in the plugin host runtime (Bun and Node both
  support it; one-line spike).
- Pick the exact recall-block delimiter format; keep it minimal and explicit.
- Tune timeout values if E2E shows the defaults are too tight.

Resolved during the builder check (recorded here so the plan inherits them):

- `session.idle` payload carries `data.sessionID` (pre-verified against `@opencode/client`
  types). Its delivery topology (which instances receive it) is unknown and **designed around**
  via the per-project flush lock rather than investigated.
- Whether `session.idle` fires in headless `opencode run` is unknown; the E2E observes and
  records it, and the cleanup flush guarantees summaries land either way.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `kratos capture` interface changes (undocumented) | Version-pin nothing; degrade per-feature on failure; upstream issue to document; changelog notes |
| `npx` fallback adds seconds of latency per call | Resolve once; probe with timeout; disable quietly if unusable |
| Prompt-admission hook blocks on recall exec | 5 s timeout; recall is skipped, not retried |
| Server shutdown loses buffered edits | Best-effort flush in plugin cleanup; compaction flush covers long sessions |
| Concurrent sessions share one kratos buffer | Accepted (parity with Claude Code); documented as a known limitation |
| Plugin API evolves (`@opencode/plugin` 2.x) | Semver-range dependency; CI typecheck catches breaks |

## Known limitations (documented upstream in README)

- No git post-commit capture (use kratos's own `hooks install` for that).
- Shared session buffer across concurrent sessions in one project.
- Memories saved mid-session appear in context injection only from the next session (cache is
  per-session by design, matching Claude Code's SessionStart behavior).
