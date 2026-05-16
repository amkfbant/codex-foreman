import { readdir, readFile, rm } from "node:fs/promises";
import { execa } from "execa";
import path from "node:path";
import { locksDir, orchestrationDir } from "../paths.js";
import { pathExists } from "../utils/fs.js";

export async function gcCommand(projectPath: string): Promise<string[]> {
  const messages: string[] = [];
  const dir = locksDir(projectPath);
  if (await pathExists(dir)) {
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".lock")) continue;
      const filePath = path.join(dir, entry);
      try {
        const record = JSON.parse(await readFile(filePath, "utf8")) as { expiresAt?: number };
        if (record.expiresAt && record.expiresAt < Date.now()) {
          await rm(filePath, { force: true });
          messages.push(`removed expired lock ${entry}`);
        }
      } catch {
        messages.push(`kept unreadable lock ${entry}`);
      }
    }
  } else {
    messages.push("no locks directory found");
  }

  const prune = await execa("git", ["worktree", "prune"], { cwd: projectPath, reject: false, all: true });
  if (prune.exitCode === 0) {
    messages.push("pruned stale git worktree metadata");
  } else {
    messages.push(`kept git worktree metadata: ${prune.all ?? "git worktree prune failed"}`);
  }

  const worktreesDir = path.join(orchestrationDir(projectPath), "worktrees");
  if (await pathExists(worktreesDir)) {
    for (const entry of await readdir(worktreesDir)) {
      if (!entry.includes("-integration-")) continue;
      const fullPath = path.join(worktreesDir, entry);
      if (await pathExists(path.join(fullPath, ".git"))) continue;
      await rm(fullPath, { recursive: true, force: true });
      messages.push(`removed stale integration worktree directory ${entry}`);
    }
  }

  return messages.length ? messages : ["no expired locks found"];
}
