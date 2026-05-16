import path from "node:path";

export function resolveProject(projectPath: string): string {
  return path.resolve(projectPath);
}

export function orchestrationDir(projectPath: string): string {
  return path.join(projectPath, ".orchestration");
}

export function workItemsDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "workitems");
}

export function desiredDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "desired");
}

export function runsDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "runs");
}

export function candidatesDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "candidates");
}

export function worktreesDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "worktrees");
}

export function locksDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "locks");
}

export function schemasDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "schemas");
}

export function projectInfoDir(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "project");
}

export function eventsFile(projectPath: string): string {
  return path.join(orchestrationDir(projectPath), "events", "events.jsonl");
}

