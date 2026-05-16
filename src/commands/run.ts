import { reconcileOnce, type ReconcileOptions } from "../controller.js";
import { readWorkItems } from "../state/store.js";

export async function runCommand(
  projectPath: string,
  options: ReconcileOptions & { maxSteps?: number; until?: string }
): Promise<string[]> {
  const messages: string[] = [];
  const maxSteps = options.maxSteps ?? 50;
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await reconcileOnce(projectPath, options);
    messages.push(`${result.action}: ${result.message}`);
    const items = await readWorkItems(projectPath);
    if (result.action === "noop" || reachedUntil(items, options.until ?? "terminal")) break;
  }
  return messages;
}

function reachedUntil(items: Awaited<ReturnType<typeof readWorkItems>>, until: string): boolean {
  if (items.length === 0) return true;
  if (until === "ready-to-merge") return items.every((item) => ["ReadyToMerge", "Merged", "Blocked", "Failed", "Abandoned"].includes(item.status.phase));
  if (until === "merged") return items.every((item) => ["Merged", "Blocked", "Failed", "Abandoned"].includes(item.status.phase));
  if (until === "step") return true;
  return items.every((item) => ["Merged", "Blocked", "Failed", "Abandoned"].includes(item.status.phase));
}
