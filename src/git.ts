import { execa } from "execa";
import path from "node:path";
import { ForemanError } from "./utils/errors.js";
import { ensureDir, pathExists } from "./utils/fs.js";

async function git(projectPath: string, args: string[], options: { cwd?: string; reject?: boolean } = {}) {
  return execa("git", args, {
    cwd: options.cwd ?? projectPath,
    reject: options.reject ?? false,
    all: true
  });
}

export type GitStatusEntry = {
  code: string;
  path: string;
  raw: string;
};

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const result = await git(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function currentHead(projectPath: string): Promise<string> {
  const result = await git(projectPath, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new ForemanError("GitError", result.all ?? "Unable to resolve HEAD.");
  }
  return result.stdout.trim();
}

export async function gitStatus(projectPath: string, cwd = projectPath, includeUntrackedAll = false): Promise<string> {
  const args = ["status", "--porcelain=v1"];
  if (includeUntrackedAll) args.push("--untracked-files=all");
  const result = await git(projectPath, args, { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitError", result.all ?? "git status failed.");
  return result.stdout;
}

export async function isWorktreeDirty(projectPath: string): Promise<boolean> {
  return (await gitStatus(projectPath)).trim().length > 0;
}

export async function createWorktree(
  projectPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  if (await pathExists(worktreePath)) {
    const branch = await branchForWorktree(projectPath, worktreePath);
    if (branch !== branchName) {
      throw new ForemanError("StaleWorktree", `Expected ${worktreePath} to be on ${branchName}, got ${branch || "detached"}.`);
    }
    return;
  }
  await ensureDir(path.dirname(worktreePath));
  const result = await git(projectPath, ["worktree", "add", worktreePath, "-b", branchName, "HEAD"]);
  if (result.exitCode !== 0) {
    throw new ForemanError("GitWorktreeError", result.all ?? "git worktree add failed.");
  }
}

export async function createDetachedWorktree(projectPath: string, worktreePath: string, ref = "HEAD"): Promise<void> {
  if (await pathExists(worktreePath)) {
    throw new ForemanError("StaleWorktree", `Integration worktree already exists: ${worktreePath}`);
  }
  await ensureDir(path.dirname(worktreePath));
  const result = await git(projectPath, ["worktree", "add", "--detach", worktreePath, ref]);
  if (result.exitCode !== 0) {
    throw new ForemanError("GitWorktreeError", result.all ?? "git worktree add --detach failed.");
  }
}

export async function diff(projectPath: string, cwd: string): Promise<string> {
  const result = await git(projectPath, ["diff", "--cached", "--binary", "--no-ext-diff"], { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitDiffError", result.all ?? "git diff failed.");
  return result.stdout;
}

export async function diffStat(projectPath: string, cwd: string): Promise<string> {
  const result = await git(projectPath, ["diff", "--cached", "--stat"], { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitDiffError", result.all ?? "git diff --stat failed.");
  return result.stdout;
}

export async function changedFiles(projectPath: string, cwd: string): Promise<string[]> {
  const result = await git(projectPath, ["diff", "--cached", "--name-only"], { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitDiffError", result.all ?? "git diff --name-only failed.");
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function worktreeStatusEntries(projectPath: string, cwd: string): Promise<GitStatusEntry[]> {
  const status = await gitStatus(projectPath, cwd, true);
  return status.split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseStatusLine);
}

export async function unstagedOrUntrackedFiles(projectPath: string, cwd: string): Promise<string[]> {
  const entries = await worktreeStatusEntries(projectPath, cwd);
  return entries
    .filter((entry) => entry.code === "??" || entry.code[1] !== " ")
    .map((entry) => entry.path);
}

export async function materializeCandidate(projectPath: string, cwd: string): Promise<string[]> {
  const add = await git(projectPath, ["add", "-A"], { cwd });
  if (add.exitCode !== 0) throw new ForemanError("GitAddError", add.all ?? "git add -A failed.");
  const status = await git(projectPath, ["status", "--porcelain=v1"], { cwd });
  if (status.exitCode !== 0) throw new ForemanError("GitStatusError", status.all ?? "git status failed.");
  const files = await changedFiles(projectPath, cwd);
  if (!status.stdout.trim() || files.length === 0) {
    throw new ForemanError("EmptyCandidate", "Candidate produced no changes.");
  }
  return files;
}

export async function cleanWorkerContext(projectPath: string, cwd: string): Promise<void> {
  const result = await git(projectPath, ["clean", "-fd", "--", "AGENTS.md", ".codex", ".agents", ".orchestration"], { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitCleanError", result.all ?? "git clean failed.");
}

export async function branchForWorktree(projectPath: string, cwd: string): Promise<string> {
  const result = await git(projectPath, ["branch", "--show-current"], { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitError", result.all ?? "git branch failed.");
  return result.stdout.trim();
}

export async function mergeWorktreeBranch(projectPath: string, cwd: string): Promise<string> {
  const branch = await branchForWorktree(projectPath, cwd);
  if (!branch) throw new ForemanError("MergeBlocked", "Candidate worktree is detached; cannot merge automatically.");
  await mergeBranchInto(projectPath, projectPath, branch);
  return branch;
}

export async function commitCandidate(projectPath: string, cwd: string, message: string): Promise<string> {
  const dirty = await unstagedOrUntrackedFiles(projectPath, cwd);
  if (dirty.length > 0) {
    throw new ForemanError("CandidateWorktreeDirty", `Candidate worktree has unstaged or untracked changes: ${dirty.join(", ")}`);
  }
  const files = await changedFiles(projectPath, cwd);
  if (files.length === 0) throw new ForemanError("EmptyCandidate", "Candidate produced no changes.");
  const commit = await git(projectPath, ["commit", "-m", message], { cwd });
  if (commit.exitCode !== 0) {
    throw new ForemanError("GitCommitError", commit.all ?? "git commit failed.");
  }
  const sha = await git(projectPath, ["rev-parse", "HEAD"], { cwd });
  if (sha.exitCode !== 0) throw new ForemanError("GitError", sha.all ?? "git rev-parse failed.");
  return sha.stdout.trim();
}

export async function mergeBranchInto(projectPath: string, cwd: string, branch: string): Promise<void> {
  const result = await git(projectPath, ["merge", "--no-ff", branch], { cwd });
  if (result.exitCode !== 0) {
    throw new ForemanError("MergeConflict", result.all ?? "git merge failed.");
  }
}

export async function removeWorktree(projectPath: string, worktreePath: string): Promise<void> {
  if (!(await pathExists(worktreePath))) return;
  const result = await git(projectPath, ["worktree", "remove", "--force", worktreePath]);
  if (result.exitCode !== 0) {
    throw new ForemanError("GitWorktreeError", result.all ?? "git worktree remove failed.");
  }
}

export async function showCommitPatch(projectPath: string, cwd: string, ref = "HEAD"): Promise<string> {
  const result = await git(projectPath, ["show", "--stat", "--patch", "--binary", "--no-ext-diff", ref], { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitShowError", result.all ?? "git show failed.");
  return result.stdout;
}

export async function changedFilesInCommit(projectPath: string, cwd: string, ref = "HEAD"): Promise<string[]> {
  const result = await git(projectPath, ["show", "--name-only", "--format=", ref], { cwd });
  if (result.exitCode !== 0) throw new ForemanError("GitShowError", result.all ?? "git show --name-only failed.");
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function writePatch(projectPath: string, cwd: string, patchPath: string): Promise<void> {
  const patch = await diff(projectPath, cwd);
  await ensureDir(path.dirname(patchPath));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(patchPath, patch, "utf8");
}

function parseStatusLine(line: string): GitStatusEntry {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const pathPart = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
  return {
    code,
    path: unquotePath(pathPart),
    raw: line
  };
}

function unquotePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}
