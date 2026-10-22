export interface CapturePayload {
  tool_name: string
  tool_input: { file_path?: string; command?: string }
}

/** OpenCode tool name → Claude-style tool name that kratos's capture handler
 * understands. Unmapped tools pass through under their own name. */
const TOOL_NAME_MAP: Record<string, string> = {
  edit: "Edit",
  write: "Write",
  patch: "MultiEdit",
  shell: "Bash",
  bash: "Bash",
}

/** File-field candidates on OpenCode tool inputs, in priority order. */
const FILE_FIELDS = ["path", "filePath", "file_path"] as const

/** Translates an OpenCode tool event into a kratos `capture --event
 * post-tool-use` payload. Never throws: unusable inputs degrade to a payload
 * without file_path/command, which kratos buffers as a generic tool use. */
export function translateToolEvent(tool: string, input: unknown): CapturePayload {
  const mapped = TOOL_NAME_MAP[tool] ?? tool
  const tool_input: CapturePayload["tool_input"] = {}

  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>
    if (mapped === "Edit" || mapped === "Write" || mapped === "MultiEdit") {
      for (const field of FILE_FIELDS) {
        if (typeof record[field] === "string") {
          tool_input.file_path = record[field] as string
          break
        }
      }
    } else if (mapped === "Bash" && typeof record.command === "string") {
      tool_input.command = record.command as string
    }
  }

  return { tool_name: mapped, tool_input }
}
