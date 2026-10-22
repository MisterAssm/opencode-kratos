#!/usr/bin/env node
// End-to-end verification for opencode-kratos.
//
// Boots a real OpenCode standalone server twice against a throwaway git
// project and proves:
//   1. Recall — a saved canary memory reaches the model's prompt (the answer
//      can only come from kratos recall).
//   2. Capture/summary — a file-creating session leaves a session-summary (or
//      auto-capture) memory mentioning the file, flushed via idle or cleanup.
//
// Requires: opencode v2 on PATH, network for npx kratos-memory.
// Set KEEP=1 to keep the temp project for inspection.

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const KEEP = process.env.KEEP === "1"
const OPENCODE_LOG = path.join(homedir(), ".local", "share", "opencode", "log", "opencode.log")
const PLUGIN_SPEC = "git+https://github.com/MisterAssm/opencode-kratos.git#feat/plugin"
const PLUGIN_CACHE_GLOB = path.join(homedir(), ".cache", "opencode", "npm", "git-opencode-kratos-*")
const PLUGIN_DEBUG_LOG = path.join(homedir(), ".kratos", "opencode-kratos", "debug.log")

const CANARY = "E2E canary: the deploy checklist requires SSH key rotation every 90 days"

const failures = []
function ok(msg) {
  console.log(`  ✓ ${msg}`)
}
function bad(msg) {
  failures.push(msg)
  console.error(`  ✗ ${msg}`)
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 180_000,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  })
}

function kratos(args, cwd, timeoutMs = 90_000) {
  return run("npx", ["--yes", "kratos-memory", ...args], { cwd, timeoutMs, capture: true })
}

/** Reads only the log lines appended to opencode.log since `size`. */
function logTailSince(size) {
  try {
    const stat = statSync(OPENCODE_LOG)
    if (stat.size <= size) return ""
    const fdText = readFileSync(OPENCODE_LOG, "utf-8")
    return fdText.slice(Math.min(size, fdText.length))
  } catch {
    return ""
  }
}

/** Reads the plugin's debug log ("" when absent — e.g. debug: false). */
function readDebugLog() {
  try {
    return readFileSync(PLUGIN_DEBUG_LOG, "utf-8")
  } catch {
    return ""
  }
}

console.log("[e2e] opencode-kratos end-to-end verification")

// --- 1. Throwaway git project -------------------------------------------------
const projectDir = mkdtempSync(path.join(tmpdir(), "kratos-e2e-"))
console.log(`[e2e] project: ${projectDir}`)
const gitInit = run("git", ["init", "--quiet"], { cwd: projectDir })
if (gitInit.status !== 0) {
  console.error("[e2e] FAIL: git init failed")
  process.exit(1)
}

// --- 2. Plugin config ----------------------------------------------------------
// The plugin is loaded via the git spec of this repository's feat/plugin
// branch: opencode v2.1.2 only loads package-spec plugin entries (see ledger
// ruling for Task 10). The spec therefore tests exactly the code that is
// PUSHED — the pre-flight check below fails fast when local HEAD is not
// pushed, and the plugin cache is cleared so the runs install fresh code.
const localHead = run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, capture: true }).stdout.trim()
const pushedHead = run("git", ["rev-parse", "origin/feat/plugin"], { cwd: REPO_ROOT, capture: true }).stdout.trim()
if (localHead !== pushedHead) {
  console.error(`[e2e] FAIL: local HEAD ${localHead.slice(0, 8)} is not pushed (origin/feat/plugin = ${pushedHead.slice(0, 8)}). Run: git push origin feat/plugin`)
  process.exit(1)
}
run("rm", ["-rf", PLUGIN_CACHE_GLOB], { capture: true })
run("rm", ["-f", PLUGIN_DEBUG_LOG], { capture: true })

writeFileSync(
  path.join(projectDir, "opencode.json"),
  JSON.stringify(
    {
      plugins: [
        {
          package: PLUGIN_SPEC,
          options: { idleDebounceMinutes: 0, debug: true },
        },
      ],
    },
    null,
    2,
  ),
)

// --- 3. Canary memory ----------------------------------------------------------
console.log("[e2e] phase 0: saving canary memory into kratos")
const save = kratos(["save", CANARY, "--tags", "e2e"], projectDir)
if (save.status !== 0) {
  console.error(`[e2e] FAIL: kratos save exited ${save.status}\n${save.stderr}`)
  process.exit(1)
}
ok("canary memory saved")

// --- 4. Recall phase -----------------------------------------------------------
console.log("[e2e] phase 1: recall — asking about the canary fact")
const logSizeBeforeRecall = statSync(OPENCODE_LOG).size
const recallRun = run(
  "opencode",
  ["run", "--standalone", "--print-logs", "What is the SSH key rotation policy for deploys?"],
  { cwd: projectDir, timeoutMs: 240_000, capture: true },
)
if (recallRun.status !== 0) {
  console.error(`[e2e] FAIL: opencode run (recall) exited ${recallRun.status}\n${recallRun.stderr}`)
  process.exit(1)
}
const recallOut = `${recallRun.stdout}\n${recallRun.stderr}`
const recallLog = logTailSince(logSizeBeforeRecall)

console.log("[e2e] model answer:")
console.log(
  recallRun.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-4)
    .map((l) => `    ${l}`)
    .join("\n"),
)

// The plugin's own debug file is the primary evidence surface: it proves the
// plugin's setup ran AND that options arrived (debug: true is an option).
const recallDebugLog = readDebugLog()
if (recallDebugLog.includes("[kratos]")) {
  ok(`plugin debug log written (${recallDebugLog.split("\n").filter((l) => l.length > 0).length} lines — options delivered)`)
} else {
  bad("no [kratos] lines in ~/.kratos/opencode-kratos/debug.log — plugin setup may not have run or options were not delivered")
}

const recallInjected =
  recallDebugLog.includes("recall injected") ||
  recallOut.includes("[kratos] recall injected") ||
  recallLog.includes("[kratos] recall injected")
const canaryInAnswer = recallRun.stdout.includes("90 days")
const canaryInPrompt = recallOut.includes("kratos-recall") || recallLog.includes("kratos-recall")
if (recallInjected || canaryInAnswer || canaryInPrompt) {
  ok(
    `recall proven (${[
      recallInjected && "log line",
      canaryInAnswer && "model answered from memory",
      canaryInPrompt && "kratos-recall block visible",
    ]
      .filter(Boolean)
      .join(" + ")})`,
  )
} else {
  bad("no evidence of recall — expected '[kratos] recall injected', '90 days' in the answer, or a kratos-recall block")
  console.error("    --- plugin debug log ---")
  console.error(recallDebugLog.split("\n").map((l) => `    ${l}`).join("\n"))
  console.error("    --- run output tail ---")
  console.error(recallOut.split("\n").slice(-25).map((l) => `    ${l}`).join("\n"))
  console.error("    --- opencode.log tail (this run) ---")
  console.error(recallLog.split("\n").slice(-25).map((l) => `    ${l}`).join("\n"))
}

// --- 5. Capture/summary phase --------------------------------------------------
console.log("[e2e] phase 2: capture — creating a file through the agent")
const logSizeBeforeCapture = statSync(OPENCODE_LOG).size
const captureRun = run(
  "opencode",
  ["run", "--standalone", "Create a file named hello.txt containing the word hi"],
  { cwd: projectDir, timeoutMs: 240_000, capture: true },
)
if (captureRun.status !== 0) {
  console.error(`[e2e] FAIL: opencode run (capture) exited ${captureRun.status}\n${captureRun.stderr}`)
  process.exit(1)
}
const captureOut = `${captureRun.stdout}\n${captureRun.stderr}`
const captureLog = logTailSince(logSizeBeforeCapture)

// Which flush source fired? (idle / cleanup / compaction)
const captureDebugLog = readDebugLog()
const flushSources = [
  ...captureDebugLog.matchAll(/session summary flush \((\w+)\)/g),
  ...captureLog.matchAll(/session summary flush \((\w+)\)/g),
  ...captureOut.matchAll(/session summary flush \((\w+)\)/g),
].map((m) => m[1])
if (flushSources.length > 0) {
  ok(`session summary flushed via: ${[...new Set(flushSources)].join(", ")}`)
} else {
  console.log("  · no flush log line found (checking kratos state anyway)")
}

// Poll kratos for the summary memory (flush is debounced 0 but capture is async).
console.log("[e2e] polling kratos for the session summary…")
let summaryMemory = null
let recentRaw = ""
for (let attempt = 0; attempt < 12; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  const recent = kratos(["recent", "--json"], projectDir, 60_000)
  if (recent.status !== 0) continue
  recentRaw = recent.stdout
  try {
    const parsed = JSON.parse(recent.stdout)
    const memories = Array.isArray(parsed) ? parsed : (parsed.memories ?? [])
    summaryMemory = memories.find(
      (m) =>
        (m.tags?.includes("session-summary") || m.tags?.includes("auto-capture")) &&
        `${m.summary ?? ""} ${m.text ?? ""}`.includes("hello.txt"),
    ) ?? null
    if (summaryMemory) break
  } catch {
    // retry on parse issues
  }
}

if (summaryMemory) {
  ok(`memory ${summaryMemory.id} (tags: ${summaryMemory.tags?.join(", ")}) mentions hello.txt`)
} else {
  bad("no session-summary/auto-capture memory mentioning hello.txt in kratos recent")
  console.error("    --- plugin debug log ---")
  console.error(captureDebugLog.split("\n").map((l) => `    ${l}`).join("\n"))
  console.error("    --- kratos recent --json (last attempt, head) ---")
  console.error(recentRaw.split("\n").slice(0, 40).map((l) => `    ${l}`).join("\n"))
  console.error("    --- run output tail ---")
  console.error(captureOut.split("\n").slice(-25).map((l) => `    ${l}`).join("\n"))
}

// --- Result --------------------------------------------------------------------
if (failures.length === 0) {
  console.log("[e2e] PASS — recall injected, session summary saved")
} else {
  console.error(`[e2e] FAIL — ${failures.length} assertion(s) failed`)
}

if (KEEP) {
  console.log(`[e2e] KEEP=1 — project kept at ${projectDir}`)
} else {
  rmSync(projectDir, { recursive: true, force: true })
}
process.exit(failures.length === 0 ? 0 : 1)
