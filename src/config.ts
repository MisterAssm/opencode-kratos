export interface KratosPluginOptions {
  binary: string
  context: boolean
  recall: boolean
  capture: boolean
  summary: boolean
  idleDebounceMinutes: number
  contextBudget: number | undefined
  debug: boolean
}

const DEFAULTS: KratosPluginOptions = {
  binary: "",
  context: true,
  recall: true,
  capture: true,
  summary: true,
  idleDebounceMinutes: 15,
  contextBudget: undefined,
  debug: false,
}

const BOOLEAN_KEYS = ["context", "recall", "capture", "summary", "debug"] as const

export function resolveOptions(raw: unknown): KratosPluginOptions {
  const source: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  const opts: KratosPluginOptions = { ...DEFAULTS }

  if (typeof source.binary === "string" && source.binary.length > 0) {
    opts.binary = source.binary
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof source[key] === "boolean") opts[key] = source[key] as boolean
  }
  if (
    typeof source.idleDebounceMinutes === "number" &&
    Number.isFinite(source.idleDebounceMinutes) &&
    source.idleDebounceMinutes >= 0
  ) {
    opts.idleDebounceMinutes = source.idleDebounceMinutes
  }
  if (
    typeof source.contextBudget === "number" &&
    Number.isFinite(source.contextBudget) &&
    source.contextBudget > 0
  ) {
    opts.contextBudget = source.contextBudget
  }

  return opts
}
