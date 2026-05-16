import { readWorkItem, writeWorkItem } from "../state/store.js";

export async function retryCommand(projectPath: string, workItemId: string): Promise<string> {
  const item = await readWorkItem(projectPath, workItemId);
  item.status.phase = "Ready";
  item.status.failureReason = undefined;
  item.status.message = "Manually queued for retry.";
  item.status.conditions = item.status.conditions.filter((condition) => condition.type !== "ReconcileError");
  await writeWorkItem(projectPath, item);
  return `queued ${workItemId} for retry`;
}

