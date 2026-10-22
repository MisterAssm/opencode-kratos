import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

export type LogFn = (message: string) => void

/** Creates the plugin's debug logger.
 *
 * When enabled, appends `[kratos] <message>` lines to `<dir>/debug.log`
 * (typically ~/.kratos/opencode-kratos/debug.log). OpenCode v2 swallows
 * plugin console.log output, so a file is the only reliable debug surface.
 * Never throws: an unwritable destination degrades to a silent noop.
 */
export function createDebugLogger(enabled: boolean, dir: string): LogFn {
  if (!enabled) return () => {}
  const file = path.join(dir, "debug.log")
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return () => {}
  }
  return (message: string) => {
    try {
      appendFileSync(file, `[kratos] ${message}\n`, "utf-8")
    } catch {
      // Disk full, permissions, vanished dir — debug logging is best effort.
    }
  }
}
