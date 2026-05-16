import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendFile, writeFile, readFile } from "node:fs/promises";
import { execa } from "execa";
import type { AgentRun } from "../src/domain.js";
import { apiVersion } from "../src/domain.js";
import type { CodexExec, CodexRunRequest } from "../src/codex.js";
import { installCommand } from "../src/commands/install.js";
import { planCommand } from "../src/commands/plan.js";
import { statusCommand } from "../src/commands/status.js";
import { dashboardCommand } from "../src/commands/dashboard.js";
import { eventsCommand } from "../src/commands/events.js";
import { reconcileOnce } from "../src/controller.js";
import { tryAcquireLease, releaseLease } from "../src/lease.js";
import { readConfig, readPatchCandidates, readWorkItems, writeConfig, writeWorkItem } from "../src/state/store.js";
import { pathExists, writeTextAtomic } from "../src/utils/fs.js";
import { tempRepo } from "./helpers.js";

describe("reconcile flow", () => {
  it("advances a fake-backed WorkItem to ReadyToMerge", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 3, maxReviewers: 2 });
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nAdd a tiny feature.\n");
    await planCommand(repo, "feature.md");
    await setValidation(repo, "git rev-parse --is-inside-work-tree");

    expect((await reconcileOnce(repo)).phase).toBe("Ready");
    expect((await reconcileOnce(repo)).phase).toBe("Validating");
    expect((await reconcileOnce(repo)).phase).toBe("Reviewing");
    expect((await reconcileOnce(repo)).phase).toBe("ReadyToMerge");
    const final = await reconcileOnce(repo);
    expect(final.action).toBe("wait_for_merge");
    expect(await statusCommand(repo)).toContain("ReadyToMerge");
    const [item] = await readWorkItems(repo);
    if (!item) throw new Error("expected WorkItem");
    const candidates = await readPatchCandidates(repo, item.metadata.uid);
    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => candidate.status.score)).toBe(true);
    expect(await eventsCommand(repo, { limit: 2 })).toContain("review_completed");
    await expect(dashboardCommand(repo)).resolves.toContain(".orchestration/dashboard/index.html");
    await expect(pathExists(path.join(repo, ".orchestration/dashboard/index.html"))).resolves.toBe(true);
  });

  it("can perform guarded auto-merge when explicitly enabled", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 3, maxReviewers: 2 });
    const config = await readConfig(repo);
    config.autoMerge.enabled = true;
    await writeConfig(repo, config);
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nAdd a tiny feature.\n");
    await planCommand(repo, "feature.md");
    await setValidation(repo, "git rev-parse --is-inside-work-tree");

    await reconcileOnce(repo);
    await reconcileOnce(repo);
    await reconcileOnce(repo);
    await reconcileOnce(repo);
    const merged = await reconcileOnce(repo);
    expect(merged.phase).toBe("Merged");
    const [item] = await readWorkItems(repo);
    if (!item) throw new Error("expected WorkItem");
    expect(item.status.phase).toBe("Merged");
  });

  it("moves to Repairing when validation fails and retries remain", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 3, maxReviewers: 2 });
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nAdd a tiny feature.\n");
    await planCommand(repo, "feature.md");
    const [item] = await readWorkItems(repo);
    if (!item) throw new Error("expected WorkItem");
    item.spec.validationCommands = ["node -e \"process.exit(1)\""];
    await writeWorkItem(repo, item);

    await reconcileOnce(repo);
    await reconcileOnce(repo);
    const failed = await reconcileOnce(repo);

    expect(failed.phase).toBe("Repairing");
    const [updated] = await readWorkItems(repo);
    if (!updated) throw new Error("expected WorkItem");
    expect(updated.status.failureReason).toBe("TestFailed");
  });

  it("auto-merge commits candidate changes into the main worktree", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    const config = await readConfig(repo);
    config.autoMerge.enabled = true;
    config.candidatePolicy.maxCandidates = 1;
    await writeConfig(repo, config);
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nModify README.\n");
    await planCommand(repo, "feature.md");
    await setValidation(repo, "git rev-parse --is-inside-work-tree");

    const codex = new MutatingCodexExec(async (request) => {
      if (request.role === "coder") await appendFile(path.join(request.cwd, "README.md"), "\nmerged change\n", "utf8");
    });

    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    const merged = await reconcileOnce(repo, { codex });

    expect(merged.phase).toBe("Merged");
    await expect(readFile(path.join(repo, "README.md"), "utf8")).resolves.toContain("merged change");
  });

  it("captures new files in candidate artifacts and merge", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    const config = await readConfig(repo);
    config.autoMerge.enabled = true;
    config.candidatePolicy.maxCandidates = 1;
    await writeConfig(repo, config);
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nAdd a new file.\n");
    await planCommand(repo, "feature.md");
    await setValidation(repo, "git rev-parse --is-inside-work-tree");

    const codex = new MutatingCodexExec(async (request) => {
      if (request.role === "coder") await writeFile(path.join(request.cwd, "new-file.txt"), "new content\n", "utf8");
    });

    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    const [item] = await readWorkItems(repo);
    if (!item) throw new Error("expected WorkItem");
    let candidates = await readPatchCandidates(repo, item.metadata.uid);
    expect(candidates[0]?.status.changedFiles).toContain("new-file.txt");
    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });

    await expect(readFile(path.join(repo, "new-file.txt"), "utf8")).resolves.toBe("new content\n");
    candidates = await readPatchCandidates(repo, item.metadata.uid);
    expect(candidates[0]?.status.changedFiles).toContain("new-file.txt");
  });

  it("does not auto-merge when validation is skipped", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    const config = await readConfig(repo);
    config.autoMerge.enabled = true;
    config.candidatePolicy.maxCandidates = 1;
    await writeConfig(repo, config);
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nNo validation.\n");
    await planCommand(repo, "feature.md");

    await reconcileOnce(repo);
    await reconcileOnce(repo);
    const result = await reconcileOnce(repo);
    expect(result.phase).toBe("Blocked");
    const [item] = await readWorkItems(repo);
    expect(item?.status.failureReason).toBe("ValidationCommandMissing");
  });

  it("rejects candidates when validation leaves generated files", async () => {
    const repo = await tempRepo();
    await writeNodeValidationProject(repo, "require('node:fs').writeFileSync('coverage.txt', 'generated\\n')");
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    const config = await readConfig(repo);
    config.candidatePolicy.maxCandidates = 1;
    await writeConfig(repo, config);
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nModify README.\n");
    await planCommand(repo, "feature.md");
    await setValidation(repo, "npm test");

    const codex = new MutatingCodexExec(async (request) => {
      if (request.role === "coder") await appendFile(path.join(request.cwd, "README.md"), "\nvalidated change\n", "utf8");
    });

    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    const result = await reconcileOnce(repo, { codex });

    expect(result.phase).toBe("Blocked");
    const [item] = await readWorkItems(repo);
    if (!item) throw new Error("expected WorkItem");
    expect(item.status.failureReason).toBe("ValidationMutatedWorktree");
    const candidates = await readPatchCandidates(repo, item.metadata.uid);
    expect(candidates[0]?.status.phase).toBe("Rejected");
    expect(candidates[0]?.status.changedFiles).not.toContain("coverage.txt");
  });

  it("validates in a temporary integration worktree before changing main", async () => {
    const repo = await tempRepo();
    await writeNodeValidationProject(repo, "require('node:fs').existsSync('FAIL') && process.exit(1)");
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    const config = await readConfig(repo);
    config.autoMerge.enabled = true;
    config.candidatePolicy.maxCandidates = 1;
    await writeConfig(repo, config);
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nModify README.\n");
    await planCommand(repo, "feature.md");
    await setValidation(repo, "npm test");

    const codex = new MutatingCodexExec(async (request) => {
      if (request.role === "coder") await appendFile(path.join(request.cwd, "README.md"), "\nintegration candidate\n", "utf8");
    });

    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });
    await reconcileOnce(repo, { codex });

    await writeFile(path.join(repo, "FAIL"), "fail integration\n", "utf8");
    await execa("git", ["add", "FAIL"], { cwd: repo });
    await execa("git", ["commit", "-m", "add failing main marker"], { cwd: repo });
    const mainHeadBeforeMerge = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

    const result = await reconcileOnce(repo, { codex });
    const mainHeadAfterMergeAttempt = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

    expect(result.phase).toBe("Blocked");
    expect(mainHeadAfterMergeAttempt).toBe(mainHeadBeforeMerge);
    await expect(readFile(path.join(repo, "README.md"), "utf8")).resolves.not.toContain("integration candidate");
  });

  it("does not mark failed Codex runs as implemented", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    const config = await readConfig(repo);
    config.candidatePolicy.maxCandidates = 1;
    await writeConfig(repo, config);
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nFail coder.\n");
    await planCommand(repo, "feature.md");
    await setValidation(repo, "git rev-parse --is-inside-work-tree");

    await reconcileOnce(repo, { codex: new FailingCodexExec() });
    const failed = await reconcileOnce(repo, { codex: new FailingCodexExec() });
    expect(failed.phase).toBe("Ready");
    const [item] = await readWorkItems(repo);
    if (!item) throw new Error("expected WorkItem");
    expect(item.status.conditions.some((condition) => condition.type === "Implemented" && condition.status === "True")).toBe(false);
  });

  it("skips a locked first WorkItem and reconciles the next actionable one", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    await writeTextAtomic(path.join(repo, "feature.md"), [
      "# Feature",
      "",
      "## Goal",
      "Two items.",
      "",
      "## WorkItems",
      "- First: do first",
      "- Second: do second"
    ].join("\n"));
    await planCommand(repo, "feature.md");
    const [first, second] = await readWorkItems(repo);
    if (!first || !second) throw new Error("expected two WorkItems");
    const lease = await tryAcquireLease(repo, first.metadata.uid, 120);
    expect(lease.acquired).toBe(true);
    try {
      const result = await reconcileOnce(repo);
      expect(result.workItemId).toBe(second.metadata.uid);
      expect(result.phase).toBe("Ready");
    } finally {
      await releaseLease(lease);
    }
  });
});

async function setValidation(repo: string, command: string): Promise<void> {
  const [item] = await readWorkItems(repo);
  if (!item) throw new Error("expected WorkItem");
  item.spec.validationCommands = [command];
  await writeWorkItem(repo, item);
}

async function writeNodeValidationProject(repo: string, script: string): Promise<void> {
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({
    scripts: {
      test: `node -e "${script}"`
    }
  }, null, 2)}\n`, "utf8");
  await execa("git", ["add", "package.json"], { cwd: repo });
  await execa("git", ["commit", "-m", "add validation script"], { cwd: repo });
}

class MutatingCodexExec implements CodexExec {
  constructor(private readonly mutate: (request: CodexRunRequest) => Promise<void>) {}

  async run(request: CodexRunRequest): Promise<AgentRun> {
    await this.mutate(request);
    if (request.role === "reviewer" && request.outputPath) {
      await writeTextAtomic(request.outputPath, JSON.stringify({
        result: "approve",
        summary: "approved",
        findings: [],
        next_prompt_hints: []
      }, null, 2));
    } else if (request.outputPath) {
      await writeTextAtomic(request.outputPath, `${request.role} done\n`);
    }
    return successfulRun(request);
  }
}

class FailingCodexExec implements CodexExec {
  async run(request: CodexRunRequest): Promise<AgentRun> {
    return {
      ...successfulRun(request),
      status: {
        ...successfulRun(request).status,
        phase: "failed",
        exitCode: 1,
        failureReason: "CodexRunFailed",
        message: "intentional failure"
      }
    };
  }
}

function successfulRun(request: CodexRunRequest): AgentRun {
  const now = new Date().toISOString();
  return {
    apiVersion,
    kind: "AgentRun",
    metadata: {
      uid: `RUN-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workItemRef: request.workItemId,
      createdAt: now
    },
    spec: {
      role: request.role,
      cwd: request.cwd,
      sandbox: request.sandbox,
      outputPath: request.outputPath,
      outputSchemaPath: request.outputSchemaPath
    },
    status: {
      phase: "succeeded",
      startedAt: now,
      completedAt: now,
      jsonlPath: path.join(request.projectPath, ".orchestration/runs/test.jsonl"),
      exitCode: 0
    }
  };
}
