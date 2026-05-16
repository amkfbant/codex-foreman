import { readFile } from "node:fs/promises";
import { describeWorkItem } from "../controller.js";
import { eventsFile } from "../paths.js";
import { readPatchCandidates, readPlan, readWorkItems } from "../state/store.js";
import { pathExists } from "../utils/fs.js";

export async function statusCommand(projectPath: string, options: { json?: boolean } = {}): Promise<string> {
  const items = await readWorkItems(projectPath);
  const candidateGroups = await Promise.all(items.map(async (item) => ({
    item,
    candidates: await readPatchCandidates(projectPath, item.metadata.uid)
  })));
  let planLine = "Plan: none";
  let plan: Awaited<ReturnType<typeof readPlan>> | undefined;
  try {
    plan = await readPlan(projectPath);
    planLine = `Plan: ${plan.metadata.uid} (${plan.status.phase})`;
  } catch {
    planLine = "Plan: none";
  }
  if (options.json) {
    return `${JSON.stringify({ project: projectPath, plan, workItems: candidateGroups }, null, 2)}\n`;
  }
  const lines = [
    `Project: ${projectPath}`,
    planLine,
    "",
    "WorkItems:",
    candidateGroups.length ? candidateGroups.map(({ item, candidates }) => [
      describeWorkItem(item, projectPath),
      ...candidates.map((candidate) => `  - ${candidate.metadata.uid}: ${candidate.status.phase}, validation=${candidate.status.validation.status}, review=${candidate.status.reviewResult}, score=${candidate.status.score?.value ?? "n/a"}`)
    ].join("\n")).join("\n\n") : "  none"
  ];
  const recentEvents = await readRecentEvents(projectPath);
  if (recentEvents.length > 0) {
    lines.push("", "Recent events:", ...recentEvents.map((event) => `  ${event}`));
  }
  return `${lines.join("\n")}\n`;
}

async function readRecentEvents(projectPath: string): Promise<string[]> {
  const filePath = eventsFile(projectPath);
  if (!(await pathExists(filePath))) return [];
  const lines = (await readFile(filePath, "utf8")).trim().split("\n").filter(Boolean);
  return lines.slice(-8).map((line) => {
    try {
      const event = JSON.parse(line) as { at?: string; type?: string; workItemId?: string; message?: string };
      return `${event.at ?? ""} ${event.type ?? "event"} ${event.workItemId ?? ""} ${event.message ?? ""}`.trim();
    } catch {
      return line;
    }
  });
}
