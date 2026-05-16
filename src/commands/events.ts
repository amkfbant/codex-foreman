import { readFile } from "node:fs/promises";
import { eventsFile } from "../paths.js";
import { pathExists } from "../utils/fs.js";

export type EventsOptions = {
  workitem?: string;
  limit?: number;
  json?: boolean;
};

export async function eventsCommand(projectPath: string, options: EventsOptions = {}): Promise<string> {
  const filePath = eventsFile(projectPath);
  if (!(await pathExists(filePath))) return "";
  const events = (await readFile(filePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => parseEventLine(line))
    .filter((event) => !options.workitem || event.workItemId === options.workitem)
    .slice(-(options.limit ?? 20));
  if (options.json) return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return `${events.map((event) => `${event.at ?? ""} ${event.type ?? "event"} ${event.workItemId ?? ""} ${event.message ?? ""}`.trim()).join("\n")}\n`;
}

function parseEventLine(line: string): { at?: string; type?: string; workItemId?: string; message?: string; data?: unknown } {
  try {
    return JSON.parse(line) as { at?: string; type?: string; workItemId?: string; message?: string; data?: unknown };
  } catch {
    return { type: "invalid_event_line", message: line };
  }
}
