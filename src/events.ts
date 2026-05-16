import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ControllerEvent } from "./domain.js";
import { eventsFile } from "./paths.js";
import { ensureDir } from "./utils/fs.js";
import { nowIso } from "./utils/time.js";

export async function appendEvent(
  projectPath: string,
  event: Omit<ControllerEvent, "at">
): Promise<ControllerEvent> {
  const fullEvent: ControllerEvent = { at: nowIso(), ...event };
  const filePath = eventsFile(projectPath);
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
  return fullEvent;
}

