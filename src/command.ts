/** Prompt text injected by the /memory command. Pinned verbatim from the
 * plan: the agent runs the kratos CLI itself via the shell tool. */
export function memoryCommandPrompt(): string {
  return "Check the project memory with the shell tool: run `npx kratos-memory status` and `npx kratos-memory recent --limit 10`, then summarize the memory state in a short bullet list: total memories, most recent work, and any pinned decisions."
}
