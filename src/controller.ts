import { execa } from "execa";
import path from "node:path";
import {
  apiVersion,
  type AgentRun,
  type Condition,
  type KnowledgeEntry,
  type OrchestrationConfig,
  type PatchCandidate,
  type Plan,
  type ReviewReport,
  reviewReportSchema,
  type WorkItem
} from "./domain.js";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { appendEvent } from "./events.js";
import {
  branchForWorktree,
  changedFiles,
  changedFilesInCommit,
  cleanWorkerContext,
  commitCandidate,
  createDetachedWorktree,
  createWorktree,
  currentHead,
  diff,
  diffStat,
  materializeCandidate,
  mergeBranchInto,
  mergeWorktreeBranch,
  removeWorktree,
  showCommitPatch,
  unstagedOrUntrackedFiles,
  worktreeStatusEntries,
  writePatch
} from "./git.js";
import { releaseLease, renewLease, tryAcquireLease } from "./lease.js";
import { orchestrationDir, schemasDir } from "./paths.js";
import { renderCoderPrompt, renderRepairPrompt, renderReviewerPrompt } from "./prompts.js";
import {
  readConfig,
  readPlan,
  readPatchCandidate,
  readPatchCandidates,
  readReview,
  readWorkItems,
  writeAgentRun,
  writeKnowledgeEntry as writeKnowledgeEntryObject,
  writePatchCandidate,
  writeReview,
  writeWorkItem
} from "./state/store.js";
import { ForemanError, errorMessage } from "./utils/errors.js";
import { ensureDir, pathExists, readText, relativeTo, writeTextAtomic } from "./utils/fs.js";
import { makeId, nowIso } from "./utils/time.js";
import { type CodexExec, FakeCodexExec } from "./codex.js";

export type ReconcileResult = {
  workItemId?: string;
  action: string;
  phase?: string;
  message: string;
};

export type ReconcileOptions = {
  codex?: CodexExec;
};

export async function reconcileOnce(projectPath: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const config = await readConfig(projectPath);
  const items = await readWorkItems(projectPath);
  const activeRefs = await activePlanRefs(projectPath);
  const candidates = selectNextWorkItems(items, activeRefs);
  if (candidates.length === 0) {
    return { action: "noop", message: "No actionable WorkItems found." };
  }

  for (const item of candidates) {
    const leaseTtl = Math.max(config.defaults.validationTimeoutSeconds, 1800) + 120;
    const lease = await tryAcquireLease(projectPath, item.metadata.uid, leaseTtl);
    if (!lease.acquired) continue;
    const heartbeat = setInterval(() => {
      renewLease(lease).catch(() => undefined);
    }, Math.max(1000, Math.floor(lease.ttlSeconds * 1000 / 3)));

    try {
      return await reconcileItem(projectPath, config, item, options.codex ?? new FakeCodexExec());
    } catch (error) {
      const updated = markCondition(item, "ReconcileError", "False", errorMessage(error));
      updated.status.failureReason = error instanceof ForemanError ? error.code : "ControllerError";
      updated.status.message = errorMessage(error);
      if (isRetryableImplementationError(updated.status.failureReason) && updated.status.attempts < config.retryPolicy.maxImplementationAttempts) {
        updated.status.phase = "Ready";
        updated.status.message = `${updated.status.message} Retrying later.`;
      } else {
        updated.status.phase = "Blocked";
      }
      await writeWorkItem(projectPath, updated);
      await appendEvent(projectPath, {
        type: updated.status.phase === "Blocked" ? "workitem_blocked" : "workitem_retry_scheduled",
        workItemId: item.metadata.uid,
        message: updated.status.message ?? "WorkItem updated after reconcile error."
      });
      return {
        workItemId: item.metadata.uid,
        action: updated.status.phase === "Blocked" ? "blocked" : "retry_scheduled",
        phase: updated.status.phase,
        message: updated.status.message ?? "WorkItem updated after reconcile error."
      };
    } finally {
      clearInterval(heartbeat);
      await releaseLease(lease);
    }
  }

  return { action: "locked", message: "All actionable WorkItems are locked by another controller." };
}

async function activePlanRefs(projectPath: string): Promise<Set<string> | undefined> {
  try {
    return new Set((await readPlan(projectPath)).spec.workItemRefs);
  } catch {
    return undefined;
  }
}

function selectNextWorkItems(items: WorkItem[], activeRefs?: Set<string>): WorkItem[] {
  const byId = new Map(items.map((item) => [item.metadata.uid, item]));
  return items.filter((item) => {
    if (activeRefs && !activeRefs.has(item.metadata.uid)) return false;
    if (["Merged", "Blocked", "Failed", "Abandoned"].includes(item.status.phase)) return false;
    return item.spec.dependencies.every((dep) => byId.get(dep)?.status.phase === "Merged");
  });
}

function isRetryableImplementationError(reason: string | undefined): boolean {
  return ["CodexRunFailed", "CodexError", "SandboxDenied", "Timeout", "OutputSchemaMismatch", "EmptyCandidate"].includes(reason ?? "");
}

async function reconcileItem(
  projectPath: string,
  config: OrchestrationConfig,
  item: WorkItem,
  codex: CodexExec
): Promise<ReconcileResult> {
  switch (item.status.phase) {
    case "Pending":
    case "Planned":
      return markReady(projectPath, item);
    case "Ready":
      return runCoder(projectPath, item, codex);
    case "Validating":
      return runValidation(projectPath, config, item);
    case "Reviewing":
      return runReviewer(projectPath, config, item, codex);
    case "Repairing":
      return runRepairer(projectPath, config, item, codex);
    case "ReadyToMerge":
      return maybeMerge(projectPath, config, item);
    default:
      return {
        workItemId: item.metadata.uid,
        action: "noop",
        phase: item.status.phase,
        message: `No controller action for phase ${item.status.phase}.`
      };
  }
}

async function markReady(projectPath: string, item: WorkItem): Promise<ReconcileResult> {
  item.status.phase = "Ready";
  item.status.observedGeneration = item.metadata.generation;
  item.status.message = "WorkItem is ready for implementation.";
  await writeWorkItem(projectPath, item);
  await appendEvent(projectPath, {
    type: "workitem_ready",
    workItemId: item.metadata.uid,
    message: item.status.message
  });
  return {
    workItemId: item.metadata.uid,
    action: "mark_ready",
    phase: item.status.phase,
    message: item.status.message
  };
}

async function runCoder(projectPath: string, item: WorkItem, codex: CodexExec): Promise<ReconcileResult> {
  const config = await readConfig(projectPath);
  await assertMainWorktreeReady(projectPath);
  item.status.attempts += 1;
  await writeWorkItem(projectPath, item);
  const candidateCount = Math.min(config.candidatePolicy.maxCandidates, config.defaults.maxCoders);
  const candidates = Array.from({ length: candidateCount }, (_, index) => candidateFor(item, String.fromCharCode(65 + index)));
  const runner = async (candidate: PatchCandidate): Promise<{ candidate: PatchCandidate; run: AgentRun }> => {
    try {
      return await withSemaphore(projectPath, "coder", config.defaults.maxCoders, async () => {
        const worktreePath = path.join(projectPath, candidate.spec.worktree);
        const candidatePath = path.join(projectPath, candidate.spec.candidateDir);
        await ensureDir(candidatePath);
        await createWorktree(projectPath, worktreePath, candidate.spec.branch);
        await installWorkerContext(projectPath, worktreePath);
        await writePatchCandidate(projectPath, candidate);
        const run = await codex.run({
          projectPath,
          cwd: worktreePath,
          workItemId: item.metadata.uid,
          role: "coder",
          prompt: renderCoderPrompt(item),
          sandbox: "workspace-write",
          outputPath: path.join(candidatePath, "RESULTS.md"),
          outputSchemaPath: path.join(schemasDir(projectPath), "coder-result.schema.json")
        });
        await writeAgentRun(projectPath, run);
        assertRunSucceeded(run);
        await cleanWorkerContext(projectPath, worktreePath);
        const materializedFiles = await materializeCandidate(projectPath, worktreePath);
        const scopeViolations = outsideAllowedPaths(item, materializedFiles);
        if (scopeViolations.length > 0) {
          candidate.status.phase = "Rejected";
          candidate.status.failureReason = "AllowedPathsViolation";
          candidate.status.changedFiles = materializedFiles;
          candidate.status.message = `Candidate changed files outside allowedPaths: ${scopeViolations.join(", ")}`;
          await writePatchCandidate(projectPath, candidate);
          throw new ForemanError("AllowedPathsViolation", candidate.status.message);
        }
        await writePatch(projectPath, worktreePath, path.join(candidatePath, "changes.patch"));
        candidate.status.phase = "Implemented";
        candidate.status.coderRunId = run.metadata.uid;
        candidate.status.changedFiles = materializedFiles;
        candidate.status.diffStat = await diffStat(projectPath, worktreePath);
        candidate.status.message = "Coder run completed.";
        await writePatchCandidate(projectPath, candidate);
        return { candidate, run };
      });
    } catch (error) {
      candidate.status.phase = "Rejected";
      candidate.status.failureReason = error instanceof ForemanError ? error.code : "CodexRunFailed";
      candidate.status.message = errorMessage(error);
      await writePatchCandidate(projectPath, candidate).catch(() => undefined);
      throw error;
    }
  };
  const settled = config.candidatePolicy.parallel
    ? await Promise.allSettled(candidates.map(runner))
    : await runSequentialSettled(candidates, runner);
  const results = fulfilledValues(settled);
  if (results.length === 0) {
    throw firstRejectedError(settled) ?? new ForemanError("CodexRunFailed", "All coder candidates failed.");
  }
  item.status.phase = "Validating";
  item.status.lastRunId = results.at(-1)?.run.metadata.uid;
  item.status.activeWorktree = results[0]?.candidate.spec.worktree;
  item.status.candidateId = results[0]?.candidate.metadata.uid;
  item.status.candidateIds = results.map((result) => result.candidate.metadata.uid);
  item.status.message = `${results.length} coder candidate run(s) completed; validation is next.`;
  markCondition(item, "Implemented", "True", item.status.message);
  await writeWorkItem(projectPath, item);
  await appendEvent(projectPath, {
    type: "coder_completed",
    workItemId: item.metadata.uid,
    message: item.status.message,
    data: { candidateIds: item.status.candidateIds }
  });
  return {
    workItemId: item.metadata.uid,
    action: "run_coder",
    phase: item.status.phase,
    message: item.status.message
  };
}

async function runValidation(projectPath: string, config: OrchestrationConfig, item: WorkItem): Promise<ReconcileResult> {
  const candidates = await actionableCandidates(projectPath, item);
  if (candidates.length === 0) throw new ForemanError("CandidateMissing", `WorkItem ${item.metadata.uid} has no candidates to validate.`);
  const results = await Promise.all(candidates.map(async (candidate) => {
    const worktreePath = path.join(projectPath, candidate.spec.worktree);
    const candidatePath = path.join(projectPath, candidate.spec.candidateDir);
    const logPath = path.join(candidatePath, "validation.log");
    const logs: string[] = [];
    const commandResults: PatchCandidate["status"]["validation"]["commands"] = [];
    let failed = false;

    if (item.spec.validationCommands.length === 0) {
      logs.push("No validation commands configured for this WorkItem.");
    }

    for (const command of item.spec.validationCommands) {
      const started = Date.now();
      const result = await runValidationCommand(command, worktreePath, config);
      const durationMs = Date.now() - started;
      logs.push(`$ ${command}\n${result.all ?? ""}\nexitCode=${result.exitCode}`);
      commandResults.push({
        command,
        exitCode: result.exitCode ?? 1,
        logPath: relativeTo(projectPath, logPath),
        durationMs
      });
      if (result.exitCode !== 0) failed = true;
    }

    let failureReason = failed ? "TestFailed" : undefined;
    if (item.spec.validationCommands.length > 0) {
      const validationDirtiedFiles = await unstagedOrUntrackedFiles(projectPath, worktreePath);
      if (validationDirtiedFiles.length > 0) {
        failed = true;
        failureReason = "ValidationMutatedWorktree";
        logs.push(`Validation left unstaged or untracked changes: ${validationDirtiedFiles.join(", ")}`);
      }
    }

    await writeTextAtomic(logPath, `${logs.join("\n\n")}\n`);
    candidate.status.phase = failureReason === "ValidationMutatedWorktree" ? "Rejected" : "Validated";
    candidate.status.validation = {
      status: failed ? "failed" : item.spec.validationCommands.length === 0 ? "skipped" : "passed",
      commands: commandResults,
      logPath: relativeTo(projectPath, logPath)
    };
    candidate.status.changedFiles = await changedFiles(projectPath, worktreePath);
    candidate.status.diffStat = await diffStat(projectPath, worktreePath);
    candidate.status.failureReason = failureReason;
    candidate.status.message = failed
      ? failureReason === "ValidationMutatedWorktree"
        ? "Validation mutated the candidate worktree."
        : "Validation failed."
      : "Validation passed.";
    await writePatchCandidate(projectPath, candidate);
    if (failed) {
      await writeFailureKnowledge(
        projectPath,
        item,
        `${candidate.metadata.uid} validation failed`,
        logs.join("\n\n"),
        [candidate.status.validation.logPath ?? ""],
        candidate.metadata.uid
      );
    }
    return candidate;
  }));

  const allFailed = results.every((candidate) => candidate.status.validation.status === "failed");
  const allSkipped = results.every((candidate) => candidate.status.validation.status === "skipped");
  const repairableFailures = results.filter((candidate) => candidate.status.failureReason !== "ValidationMutatedWorktree");
  if (allSkipped) {
    item.status.phase = "Blocked";
    item.status.failureReason = "ValidationCommandMissing";
    item.status.message = "Validation commands are required before review or merge.";
    markCondition(item, "TestsPassed", "Unknown", item.status.message);
  } else if (allFailed) {
    if (repairableFailures.length === 0) {
      item.status.phase = "Blocked";
      item.status.failureReason = "ValidationMutatedWorktree";
      item.status.message = "All candidates left unstaged or untracked changes during validation.";
    } else if (item.status.repairAttempts >= config.retryPolicy.maxRepairAttempts) {
      item.status.phase = "Blocked";
      item.status.failureReason = "TestFailed";
      item.status.message = "All candidates failed validation and repair retry limit is exhausted.";
    } else {
      item.status.phase = "Repairing";
      item.status.failureReason = "TestFailed";
      item.status.candidateId = pickBestCandidate(repairableFailures, config, item).metadata.uid;
      item.status.message = "All candidates failed validation; repair is next.";
    }
    markCondition(item, "TestsPassed", "False", item.status.message);
  } else {
    item.status.phase = "Reviewing";
    item.status.failureReason = undefined;
    item.status.message = "At least one candidate validated; review is next.";
    markCondition(item, "TestsPassed", "True", item.status.message);
  }
  await writeWorkItem(projectPath, item);
  await appendEvent(projectPath, {
    type: allFailed ? "validation_failed" : "validation_passed",
    workItemId: item.metadata.uid,
    message: item.status.message ?? ""
  });
  return {
    workItemId: item.metadata.uid,
    action: "run_validation",
    phase: item.status.phase,
    message: item.status.message ?? ""
  };
}

async function runReviewer(
  projectPath: string,
  config: OrchestrationConfig,
  item: WorkItem,
  codex: CodexExec
): Promise<ReconcileResult> {
  const candidates = (await readPatchCandidates(projectPath, item.metadata.uid))
    .filter((candidate) => candidate.status.validation.status !== "failed" && candidate.status.phase !== "Rejected");
  if (candidates.length === 0) throw new ForemanError("CandidateMissing", `WorkItem ${item.metadata.uid} has no reviewable candidates.`);
  const schemaPath = path.join(schemasDir(projectPath), "review-result.schema.json");
  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    try {
      return await withSemaphore(projectPath, "reviewer", config.defaults.maxReviewers, async () => {
        const worktreePath = path.join(projectPath, candidate.spec.worktree);
        const candidatePath = path.join(projectPath, candidate.spec.candidateDir);
        const validationLogPath = path.join(candidatePath, "validation.log");
        const validationLog = (await pathExists(validationLogPath)) ? await readText(validationLogPath) : "";
        const reviewOutputPath = path.join(candidatePath, "review-output.json");
        const run = await codex.run({
          projectPath,
          cwd: worktreePath,
          workItemId: item.metadata.uid,
          role: "reviewer",
          prompt: renderReviewerPrompt(item, await diffStat(projectPath, worktreePath), await diff(projectPath, worktreePath), validationLog),
          sandbox: "read-only",
          outputPath: reviewOutputPath,
          outputSchemaPath: schemaPath
        });
        await writeAgentRun(projectPath, run);
        assertRunSucceeded(run);
        let review: ReviewReport;
        try {
          review = await loadReviewOutput(reviewOutputPath, item.metadata.uid, candidate.metadata.uid);
        } catch (error) {
          review = invalidReview(item.metadata.uid, candidate.metadata.uid, errorMessage(error));
        }
        review.metadata.uid = `RR-${Date.now()}-${candidate.spec.variant}`;
        await writeReview(projectPath, review);
        candidate.status.phase = "Reviewed";
        candidate.status.reviewerRunId = run.metadata.uid;
        candidate.status.reviewResult = review.result;
        candidate.status.score = scoreCandidate(config, item, candidate, review);
        candidate.status.failureReason = review.result === "approve" ? undefined : "ReviewRequestedChanges";
        candidate.status.message = review.summary;
        await writePatchCandidate(projectPath, candidate);
        await writeTextAtomic(path.join(candidatePath, "score.json"), `${JSON.stringify(candidate.status.score, null, 2)}\n`);
        return { candidate, review, run };
      });
    } catch (error) {
      candidate.status.phase = "Rejected";
      candidate.status.failureReason = error instanceof ForemanError ? error.code : "CodexRunFailed";
      candidate.status.message = errorMessage(error);
      await writePatchCandidate(projectPath, candidate).catch(() => undefined);
      throw error;
    }
  }));
  const reviewed = fulfilledValues(settled);
  if (reviewed.length === 0) {
    throw firstRejectedError(settled) ?? new ForemanError("CodexRunFailed", "All reviewer candidates failed.");
  }

  const best = reviewed.map((entry) => entry.candidate).sort(compareCandidates).at(0);
  if (!best) throw new ForemanError("CandidateMissing", "No reviewed candidates were available for scoring.");
  const bestReview = reviewed.find((entry) => entry.candidate.metadata.uid === best.metadata.uid)?.review;
  item.status.lastRunId = reviewed.at(-1)?.run.metadata.uid;
  item.status.candidateId = best.metadata.uid;
  item.status.activeWorktree = best.spec.worktree;

  if (best.status.reviewResult === "approve" && (best.status.score?.value ?? 0) >= config.candidatePolicy.minScoreToSelect) {
    best.status.phase = "Selected";
    await writePatchCandidate(projectPath, best);
    item.status.phase = "ReadyToMerge";
    item.status.selectedCandidateId = best.metadata.uid;
    item.status.message = `Selected candidate ${best.metadata.uid} with score ${best.status.score?.value ?? 0}.`;
    markCondition(item, "ReviewApproved", "True", bestReview?.summary ?? item.status.message);
  } else if (best.status.reviewResult === "request_changes" && item.status.repairAttempts < config.retryPolicy.maxRepairAttempts) {
    item.status.phase = "Repairing";
    item.status.failureReason = "ReviewRequestedChanges";
    item.status.message = bestReview?.summary ?? "Reviewer requested changes.";
    markCondition(item, "ReviewApproved", "False", item.status.message);
  } else {
    item.status.phase = "Blocked";
    item.status.failureReason = best.status.reviewResult === "reject" ? "ReviewRejected" : "CandidateScoreTooLow";
    item.status.message = `No candidate met selection criteria. Best score: ${best.status.score?.value ?? 0}.`;
    markCondition(item, "ReviewApproved", "False", item.status.message);
  }

  await writeWorkItem(projectPath, item);
  await appendEvent(projectPath, {
    type: "review_completed",
    workItemId: item.metadata.uid,
    message: item.status.message ?? "",
    data: { selectedCandidateId: item.status.selectedCandidateId, bestScore: best.status.score?.value }
  });
  return {
    workItemId: item.metadata.uid,
    action: "run_reviewer",
    phase: item.status.phase,
    message: item.status.message ?? ""
  };
}

async function runRepairer(
  projectPath: string,
  config: OrchestrationConfig,
  item: WorkItem,
  codex: CodexExec
): Promise<ReconcileResult> {
  const candidate = await requireCandidate(projectPath, item);
  const worktreePath = path.join(projectPath, candidate.spec.worktree);
  const candidatePath = path.join(projectPath, candidate.spec.candidateDir);
  const validationLogPath = path.join(candidatePath, "validation.log");
  const validationLog = (await pathExists(validationLogPath)) ? await readText(validationLogPath) : "";
  let review: ReviewReport | undefined;
  try {
    review = await readReview(projectPath, item.metadata.uid, candidate.metadata.uid);
  } catch {
    review = undefined;
  }
  if (item.status.repairAttempts >= config.retryPolicy.maxRepairAttempts) {
    item.status.phase = "Blocked";
    item.status.failureReason = item.status.failureReason ?? "RetryLimitExceeded";
    item.status.message = "Repair retry limit is exhausted.";
    await writeWorkItem(projectPath, item);
    return {
      workItemId: item.metadata.uid,
      action: "mark_blocked",
      phase: item.status.phase,
      message: item.status.message
    };
  }
  const nextAttempt = item.status.repairAttempts + 1;
  const run = await codex.run({
    projectPath,
    cwd: worktreePath,
    workItemId: item.metadata.uid,
    role: "repairer",
    prompt: renderRepairPrompt(item, review, validationLog),
    sandbox: "workspace-write",
    outputPath: path.join(candidatePath, `repair-${nextAttempt}.md`)
  });
  await writeAgentRun(projectPath, run);
  assertRunSucceeded(run);
  await cleanWorkerContext(projectPath, worktreePath);
  const materializedFiles = await materializeCandidate(projectPath, worktreePath);
  const scopeViolations = outsideAllowedPaths(item, materializedFiles);
  if (scopeViolations.length > 0) {
    throw new ForemanError("AllowedPathsViolation", `Candidate changed files outside allowedPaths: ${scopeViolations.join(", ")}`);
  }
  await writePatch(projectPath, worktreePath, path.join(candidatePath, "changes.patch"));
  candidate.status.phase = "Repairing";
  candidate.status.repairRunIds = [...candidate.status.repairRunIds, run.metadata.uid];
  candidate.status.changedFiles = materializedFiles;
  candidate.status.diffStat = await diffStat(projectPath, worktreePath);
  candidate.status.message = "Repair run completed.";
  await writePatchCandidate(projectPath, candidate);
  item.status.phase = "Validating";
  item.status.repairAttempts = nextAttempt;
  item.status.lastRunId = run.metadata.uid;
  item.status.candidateId = candidate.metadata.uid;
  item.status.activeWorktree = candidate.spec.worktree;
  item.status.message = "Repair run completed; validation is next.";
  markCondition(item, "Implemented", "True", item.status.message);
  await writeWorkItem(projectPath, item);
  await appendEvent(projectPath, {
    type: "repair_completed",
    workItemId: item.metadata.uid,
    message: item.status.message,
    data: { runId: run.metadata.uid, repairAttempt: nextAttempt, candidateId: candidate.metadata.uid }
  });
  return {
    workItemId: item.metadata.uid,
    action: "run_repairer",
    phase: item.status.phase,
    message: item.status.message
  };
}

async function maybeMerge(projectPath: string, config: OrchestrationConfig, item: WorkItem): Promise<ReconcileResult> {
  if (!config.autoMerge.enabled) {
    item.status.message = "Candidate is ready to merge; auto-merge is disabled.";
    await writeWorkItem(projectPath, item);
    return {
      workItemId: item.metadata.uid,
      action: "wait_for_merge",
      phase: item.status.phase,
      message: item.status.message
    };
  }
  await assertMainWorktreeReady(projectPath);
  const candidate = await requireCandidate(projectPath, item);
  const worktreePath = path.join(projectPath, candidate.spec.worktree);
  const dirty = await unstagedOrUntrackedFiles(projectPath, worktreePath);
  if (dirty.length > 0) {
    candidate.status.phase = "Rejected";
    candidate.status.failureReason = "CandidateWorktreeDirty";
    candidate.status.message = `Candidate has unstaged or untracked changes after validation: ${dirty.join(", ")}`;
    await writePatchCandidate(projectPath, candidate);
    throw new ForemanError("CandidateWorktreeDirty", candidate.status.message);
  }
  const files = await changedFiles(projectPath, worktreePath);
  candidate.status.changedFiles = files;
  candidate.status.diffStat = await diffStat(projectPath, worktreePath);
  await writePatchCandidate(projectPath, candidate);
  const blocked = autoMergeBlockers(config, item, files, candidate);
  if (blocked.length > 0) {
    item.status.message = `Auto-merge blocked: ${blocked.join("; ")}`;
    await writeWorkItem(projectPath, item);
    return {
      workItemId: item.metadata.uid,
      action: "auto_merge_blocked",
      phase: item.status.phase,
      message: item.status.message
    };
  }
  const branch = await branchForWorktree(projectPath, worktreePath);
  if (!branch) throw new ForemanError("MergeBlocked", "Candidate worktree is detached; cannot merge automatically.");
  const commitSha = await commitCandidate(projectPath, worktreePath, `codex-foreman: ${item.metadata.uid} ${candidate.metadata.uid}`);
  candidate.status.changedFiles = await changedFilesInCommit(projectPath, worktreePath, commitSha);
  await writeTextAtomic(path.join(projectPath, candidate.spec.candidateDir, "changes.patch"), await showCommitPatch(projectPath, worktreePath, commitSha));
  await writePatchCandidate(projectPath, candidate);
  const validatedMainHead = await runIntegrationValidation(projectPath, config, item, branch, candidate.metadata.uid);
  if ((await currentHead(projectPath)) !== validatedMainHead) {
    throw new ForemanError("MergeBlocked", "Main branch moved after integration validation; retry reconcile.");
  }
  await mergeWorktreeBranch(projectPath, worktreePath);
  item.status.phase = "Merged";
  item.status.selectedCandidateId = candidate.metadata.uid;
  item.status.message = `Merged candidate ${candidate.metadata.uid} from ${branch}.`;
  markCondition(item, "Merged", "True", item.status.message);
  candidate.status.phase = "Merged";
  await writePatchCandidate(projectPath, candidate);
  await writeCompletionKnowledge(projectPath, item);
  markCondition(item, "KnowledgeUpdated", "True", "Recorded merge summary in orchestration knowledge.");
  await writeWorkItem(projectPath, item);
  await appendEvent(projectPath, {
    type: "candidate_merged",
    workItemId: item.metadata.uid,
    message: item.status.message
  });
  return {
    workItemId: item.metadata.uid,
    action: "merge_candidate",
    phase: item.status.phase,
    message: item.status.message
  };
}

function candidateFor(item: WorkItem, suffix: string): PatchCandidate {
  const attempt = Math.max(1, item.status.attempts);
  const id = `${item.metadata.uid}-attempt-${String(attempt).padStart(3, "0")}-${suffix}`;
  const branchSuffix = suffix.toLowerCase();
  const createdAt = nowIso();
  return {
    apiVersion,
    kind: "PatchCandidate",
    metadata: {
      uid: id,
      workItemRef: item.metadata.uid,
      createdAt,
      generation: 1
    },
    spec: {
      worktree: `.orchestration/worktrees/${item.metadata.uid}-attempt-${String(attempt).padStart(3, "0")}-coder-${branchSuffix}`,
      branch: `orch/${item.metadata.uid.toLowerCase()}-attempt-${String(attempt).padStart(3, "0")}-coder-${branchSuffix}`,
      candidateDir: `.orchestration/candidates/${item.metadata.uid}/${id}`,
      variant: suffix
    },
    status: {
      phase: "Created",
      repairRunIds: [],
      validation: {
        status: "unknown",
        commands: []
      },
      reviewResult: "missing",
      changedFiles: [],
      diffStat: ""
    }
  };
}

async function requireCandidate(projectPath: string, item: WorkItem): Promise<PatchCandidate> {
  const id = item.status.candidateId;
  if (!id) throw new ForemanError("CandidateMissing", `WorkItem ${item.metadata.uid} has no candidate.`);
  return (await readPatchCandidates(projectPath, item.metadata.uid)).find((candidate) => candidate.metadata.uid === id)
    ?? await readPatchCandidate(projectPath, item.metadata.uid, id);
}

function markCondition(item: WorkItem, type: string, status: Condition["status"], message: string): WorkItem {
  const next = item.status.conditions.filter((condition) => condition.type !== type);
  next.push({ type, status, at: nowIso(), message });
  item.status.conditions = next;
  return item;
}

async function runSequentialSettled<T, R>(items: T[], runner: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (const item of items) {
    try {
      results.push({ status: "fulfilled", value: await runner(item) });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results;
}

function fulfilledValues<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

function firstRejectedError<T>(results: PromiseSettledResult<T>[]): Error | undefined {
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected || rejected.status !== "rejected") return undefined;
  return rejected.reason instanceof Error ? rejected.reason : new Error(errorMessage(rejected.reason));
}

async function withSemaphore<T>(projectPath: string, name: string, slots: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (let i = 0; i < Math.max(1, slots); i += 1) {
      const lease = await tryAcquireLease(projectPath, `global-${name}-${i}`, 3600);
      if (lease.acquired) {
        try {
          return await fn();
        } finally {
          await releaseLease(lease);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new ForemanError("ConcurrencyLimitReached", `No ${name} slots are available.`);
}

async function actionableCandidates(projectPath: string, item: WorkItem): Promise<PatchCandidate[]> {
  const candidates = await readPatchCandidates(projectPath, item.metadata.uid);
  const ids = new Set(item.status.candidateIds.length ? item.status.candidateIds : candidates.map((candidate) => candidate.metadata.uid));
  return candidates.filter((candidate) => ids.has(candidate.metadata.uid) && candidate.status.phase !== "Rejected" && candidate.status.phase !== "Merged");
}

function pickBestCandidate(candidates: PatchCandidate[], config: OrchestrationConfig, item: WorkItem): PatchCandidate {
  const best = [...candidates].sort((a, b) => {
    const scoredA = a.status.score ?? scoreCandidate(config, item, a);
    const scoredB = b.status.score ?? scoreCandidate(config, item, b);
    return scoredB.value - scoredA.value || a.metadata.uid.localeCompare(b.metadata.uid);
  })[0];
  if (!best) throw new ForemanError("CandidateMissing", "No candidates available for selection.");
  return best;
}

function invalidReview(workItemId: string, candidateId: string, message: string): ReviewReport {
  return {
    apiVersion,
    kind: "ReviewReport",
    metadata: {
      uid: `RR-${Date.now()}-invalid`,
      workItemRef: workItemId,
      candidateRef: candidateId,
      reviewer: "codex-reviewer",
      createdAt: nowIso()
    },
    result: "request_changes",
    summary: `Review output was invalid: ${message}`,
    findings: [{
      severity: "medium",
      category: "spec",
      title: "Reviewer output did not match the expected schema.",
      evidence: [],
      requiredChange: "Retry reviewer run with valid JSON output."
    }],
    nextPromptHints: ["Return only JSON matching the review-result schema."]
  };
}

async function runValidationCommand(command: string, cwd: string, config: OrchestrationConfig) {
  const argv = parseValidationCommand(command);
  if (!isAllowedValidationCommand(argv, config.validationPolicy)) {
    throw new ForemanError("ValidationCommandNotAllowed", `Validation command is not allowlisted: ${command}`);
  }
  const [file, ...args] = argv;
  if (!file) throw new ForemanError("ValidationCommandMissing", "Validation command is empty.");
  return execa(file, args, {
    cwd,
    reject: false,
    timeout: config.defaults.validationTimeoutSeconds * 1000,
    all: true
  });
}

function parseValidationCommand(command: string): string[] {
  if (/[;&|`$<>]/.test(command)) {
    throw new ForemanError("ValidationCommandNotAllowed", `Validation command contains shell metacharacters: ${command}`);
  }
  const argv = command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  if (argv.length === 0) throw new ForemanError("ValidationCommandMissing", "Validation command is empty.");
  return argv;
}

function isAllowedValidationCommand(argv: string[], policy: OrchestrationConfig["validationPolicy"]): boolean {
  const [cmd] = argv;
  if (!cmd) return false;
  if (!policy.allowedExecutables.includes(cmd)) return false;
  const commandText = argv.join(" ");
  return !policy.forbiddenArgPatterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(commandText);
    } catch {
      return commandText.includes(pattern);
    }
  });
}

function scoreCandidate(
  config: OrchestrationConfig,
  item: WorkItem,
  candidate: PatchCandidate,
  review?: ReviewReport
): { value: number; reasons: string[] } {
  let value = 100;
  const reasons: string[] = ["base score 100"];
  if (candidate.status.validation.status === "failed") {
    value -= 80;
    reasons.push("-80 validation failed");
  } else if (candidate.status.validation.status === "skipped") {
    value -= 5;
    reasons.push("-5 validation skipped");
  } else if (candidate.status.validation.status === "passed") {
    value += 10;
    reasons.push("+10 validation passed");
  }
  const result = review?.result ?? candidate.status.reviewResult;
  if (result === "approve") {
    value += 25;
    reasons.push("+25 review approved");
  } else if (result === "request_changes") {
    value -= 25;
    reasons.push("-25 review requested changes");
  } else if (result === "reject") {
    value -= 100;
    reasons.push("-100 review rejected");
  }
  const findings = review?.findings ?? [];
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const high = findings.filter((finding) => finding.severity === "high").length;
  if (critical) {
    value -= critical * 60;
    reasons.push(`-${critical * 60} critical finding penalty`);
  }
  if (high) {
    value -= high * 30;
    reasons.push(`-${high * 30} high finding penalty`);
  }
  if (candidate.status.changedFiles.length) {
    value -= candidate.status.changedFiles.length;
    reasons.push(`-${candidate.status.changedFiles.length} changed file penalty`);
  }
  const protectedHits = candidate.status.changedFiles.filter((file) =>
    [...config.protectedPaths, ...item.spec.protectedPaths].some((pattern) => matchesProtected(pattern, file))
  );
  if (protectedHits.length) {
    value -= 100;
    reasons.push(`-100 protected path change: ${protectedHits.join(", ")}`);
  }
  const dependencyHits = config.security.forbidDependencyChanges
    ? candidate.status.changedFiles.filter((file) => config.security.dependencyFiles.some((dep) => file === dep || file.endsWith(`/${dep}`)))
    : [];
  if (dependencyHits.length) {
    value -= 50;
    reasons.push(`-50 dependency file change: ${dependencyHits.join(", ")}`);
  }
  if (candidate.status.repairRunIds.length) {
    value -= candidate.status.repairRunIds.length * 5;
    reasons.push(`-${candidate.status.repairRunIds.length * 5} repair attempt penalty`);
  }
  return { value, reasons };
}

function compareCandidates(a: PatchCandidate, b: PatchCandidate): number {
  return (b.status.score?.value ?? Number.NEGATIVE_INFINITY) - (a.status.score?.value ?? Number.NEGATIVE_INFINITY)
    || a.metadata.uid.localeCompare(b.metadata.uid);
}

async function loadReviewOutput(filePath: string, workItemId: string, candidateId: string): Promise<ReviewReport> {
  const raw = JSON.parse(await readText(filePath)) as Record<string, unknown>;
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  const report = {
    apiVersion,
    kind: "ReviewReport",
    metadata: {
      uid: `RR-${Date.now()}`,
      workItemRef: workItemId,
      candidateRef: candidateId,
      reviewer: "codex-reviewer",
      createdAt: nowIso()
    },
    result: String(raw.result ?? "request_changes") as ReviewReport["result"],
    summary: String(raw.summary ?? "Reviewer did not provide a summary."),
    findings: findings.map((finding) => {
      const record = finding as Record<string, unknown>;
      return {
        severity: String(record.severity ?? "medium") as ReviewReport["findings"][number]["severity"],
        category: String(record.category ?? "correctness") as ReviewReport["findings"][number]["category"],
        title: String(record.title ?? ""),
        evidence: Array.isArray(record.evidence)
          ? record.evidence.map((evidence) => {
              const evidenceRecord = evidence as Record<string, unknown>;
              return {
                path: String(evidenceRecord.path ?? ""),
                lines: evidenceRecord.lines ? String(evidenceRecord.lines) : undefined
              };
            })
          : [],
        requiredChange: String(record.required_change ?? record.requiredChange ?? "")
      };
    }),
    nextPromptHints: Array.isArray(raw.next_prompt_hints)
      ? raw.next_prompt_hints.map(String)
      : Array.isArray(raw.nextPromptHints)
        ? raw.nextPromptHints.map(String)
        : []
  };
  const parsed = reviewReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new ForemanError("ReviewOutputInvalid", parsed.error.message);
  }
  return parsed.data;
}

function autoMergeBlockers(config: OrchestrationConfig, item: WorkItem, files: string[], candidate?: PatchCandidate): string[] {
  const blockers: string[] = [];
  if (config.security.highRiskRequiresManualMerge && item.spec.risk === "high") blockers.push("high-risk WorkItem");
  if (item.spec.risk === "high" && !config.autoMerge.allowHighRisk) blockers.push("high-risk WorkItem");
  if (files.length > config.autoMerge.maxChangedFiles) blockers.push("too many changed files");
  const protectedPatterns = [...config.protectedPaths, ...item.spec.protectedPaths];
  const protectedHits = files.filter((file) => protectedPatterns.some((pattern) => matchesProtected(pattern, file)));
  if (protectedHits.length > 0) blockers.push(`protected paths changed: ${protectedHits.join(", ")}`);
  const dependencyHits = config.security.forbidDependencyChanges
    ? files.filter((file) => config.security.dependencyFiles.some((dependencyFile) => file === dependencyFile || file.endsWith(`/${dependencyFile}`)))
    : [];
  if (dependencyHits.length > 0) blockers.push(`dependency files changed: ${dependencyHits.join(", ")}`);
  const outsideAllowed = outsideAllowedPaths(item, files);
  if (outsideAllowed.length > 0) blockers.push(`outside allowed paths: ${outsideAllowed.join(", ")}`);
  if (candidate && candidate.status.validation.status !== "passed") {
    blockers.push(`validation not passed: ${candidate.status.validation.status}`);
  }
  const reviewApproved = item.status.conditions.some((condition) => condition.type === "ReviewApproved" && condition.status === "True");
  const testsPassed = item.status.conditions.some((condition) => condition.type === "TestsPassed" && condition.status === "True");
  if (!reviewApproved) blockers.push("review not approved");
  if (!testsPassed) blockers.push("tests not passed");
  return blockers;
}

function matchesProtected(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (pattern.endsWith(".*")) return file === pattern.slice(0, -2) || file.startsWith(pattern.slice(0, -1));
  return file === pattern || file.startsWith(`${pattern}/`);
}

function outsideAllowedPaths(item: WorkItem, files: string[]): string[] {
  if (item.spec.allowedPaths.length === 0) return [];
  return files.filter((file) => !item.spec.allowedPaths.some((allowed) => matchesAllowedPath(allowed, file)));
}

function matchesAllowedPath(pattern: string, file: string): boolean {
  if (pattern === ".") return true;
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  return file === pattern || file.startsWith(`${pattern}/`);
}

function assertRunSucceeded(run: AgentRun): void {
  if (run.status.phase !== "succeeded" || run.status.exitCode !== 0) {
    throw new ForemanError(
      run.status.failureReason ?? "CodexRunFailed",
      run.status.message ?? `Codex run ${run.metadata.uid} failed.`
    );
  }
}

async function assertMainWorktreeReady(projectPath: string): Promise<void> {
  let planSource: string | undefined;
  try {
    planSource = (await readPlan(projectPath)).spec.sourcePath;
  } catch {
    planSource = undefined;
  }
  const unsafe = (await worktreeStatusEntries(projectPath, projectPath))
    .filter((entry) => {
      if (entry.path === planSource) return false;
      if (entry.code === "??" && isOrchestrationScaffoldingPath(entry.path)) return false;
      return true;
    })
    .map((entry) => entry.raw);
  if (unsafe.length > 0) {
    throw new ForemanError("DirtyWorktree", `Main worktree has uncommitted non-orchestration changes: ${unsafe.join(", ")}`);
  }
}

function isOrchestrationScaffoldingPath(file: string): boolean {
  return file === "AGENTS.md"
    || file === "AGENTS.orchestration.patch.md"
    || file.startsWith(".codex/")
    || file.startsWith(".agents/")
    || file.startsWith(".orchestration/")
    || file.endsWith(".orchestration.patch.md")
    || file.includes(".orchestration.patch.");
}

async function installWorkerContext(projectPath: string, worktreePath: string): Promise<void> {
  await ignoreWorkerContext(worktreePath);
  const entries = [
    "AGENTS.md",
    ".codex",
    ".agents",
    ".orchestration/project",
    ".orchestration/workitems",
    ".orchestration/knowledge",
    ".orchestration/schemas"
  ];
  for (const entry of entries) {
    const source = path.join(projectPath, entry);
    const target = path.join(worktreePath, entry);
    if ((await pathExists(source)) && !(await pathExists(target))) {
      await ensureDir(path.dirname(target));
      await cp(source, target, { recursive: true, force: false, errorOnExist: false });
    }
  }
}

async function ignoreWorkerContext(worktreePath: string): Promise<void> {
  const gitFile = path.join(worktreePath, ".git");
  const content = await readFile(gitFile, "utf8");
  const gitDirMatch = content.match(/^gitdir:\s*(.+)\s*$/);
  if (!gitDirMatch?.[1]) return;
  const gitDir = path.resolve(worktreePath, gitDirMatch[1]);
  const infoDir = path.join(gitDir, "info");
  await mkdir(infoDir, { recursive: true });
  const excludePath = path.join(infoDir, "exclude");
  const additions = ["/AGENTS.md", "/.codex/", "/.agents/", "/.orchestration/"];
  const existing = (await pathExists(excludePath)) ? await readFile(excludePath, "utf8") : "";
  const next = [...new Set([...existing.split("\n").filter(Boolean), ...additions])].join("\n");
  await writeFile(excludePath, `${next}\n`, "utf8");
}

async function runIntegrationValidation(
  projectPath: string,
  config: OrchestrationConfig,
  item: WorkItem,
  candidateBranch: string,
  candidateId: string
): Promise<string> {
  if (item.spec.validationCommands.length === 0) {
    throw new ForemanError("ValidationCommandMissing", "Integration validation requires at least one validation command.");
  }
  const mainHead = await currentHead(projectPath);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const worktreePath = path.join(projectPath, ".orchestration", "worktrees", `${item.metadata.uid}-integration-${suffix}`);
  const logPath = path.join(orchestrationDir(projectPath), "events", `integration-validation-${item.metadata.uid}-${candidateId}.log`);
  const logs: string[] = [];
  try {
    await createDetachedWorktree(projectPath, worktreePath, mainHead);
    await mergeBranchInto(projectPath, worktreePath, candidateBranch);
    for (const command of item.spec.validationCommands) {
      const result = await runValidationCommand(command, worktreePath, config);
      logs.push(`$ ${command}\n${result.all ?? ""}\nexitCode=${result.exitCode}`);
      if (result.exitCode !== 0) {
        await writeTextAtomic(logPath, `${logs.join("\n\n")}\n`);
        throw new ForemanError("IntegrationValidationFailed", `Integration validation failed before merge: ${command}`);
      }
    }
    const dirty = await unstagedOrUntrackedFiles(projectPath, worktreePath);
    if (dirty.length > 0) {
      logs.push(`Integration validation left unstaged or untracked changes: ${dirty.join(", ")}`);
      await writeTextAtomic(logPath, `${logs.join("\n\n")}\n`);
      throw new ForemanError("IntegrationValidationMutatedWorktree", `Integration validation left unstaged or untracked changes: ${dirty.join(", ")}`);
    }
    const currentMainHead = await currentHead(projectPath);
    if (currentMainHead !== mainHead) {
      throw new ForemanError("MergeBlocked", "Main branch moved while integration validation was running; retry reconcile.");
    }
    await writeTextAtomic(logPath, `${logs.join("\n\n")}\n`);
    return mainHead;
  } finally {
    await removeWorktree(projectPath, worktreePath).catch(() => undefined);
  }
}

async function writeCompletionKnowledge(projectPath: string, item: WorkItem): Promise<void> {
  const entry: KnowledgeEntry = {
    apiVersion,
    kind: "KnowledgeEntry",
    metadata: {
      uid: `KE-${Date.now()}-${item.metadata.uid}`,
      createdAt: nowIso(),
      sourceWorkItem: item.metadata.uid
    },
    spec: {
      category: "lesson",
      title: `${item.metadata.uid} completed`,
      summary: item.status.message ?? "WorkItem completed.",
      evidencePaths: [`workitems/${item.metadata.uid}.xml`],
      action: "Use this completion as context for future related WorkItems."
    }
  };
  await writeKnowledgeEntryObject(projectPath, entry);
  const lessonPath = path.join(orchestrationDir(projectPath), "knowledge", "lessons", `${item.metadata.uid}.md`);
  const indexPath = path.join(orchestrationDir(projectPath), "knowledge", "index.md");
  await ensureDir(path.dirname(lessonPath));
  await writeTextAtomic(lessonPath, [
    `# ${item.metadata.uid} ${item.metadata.name}`,
    "",
    `Completed: ${nowIso()}`,
    `Candidate: ${item.status.selectedCandidateId ?? item.status.candidateId ?? "unknown"}`,
    "",
    "## Goal",
    "",
    item.spec.goal,
    "",
    "## Result",
    "",
    item.status.message ?? "Merged.",
    ""
  ].join("\n"));
  const existing = (await pathExists(indexPath)) ? await readText(indexPath) : "# Knowledge Index\n";
  const line = `- [${item.metadata.uid}](lessons/${item.metadata.uid}.md) ${item.metadata.name}`;
  if (!existing.includes(line)) {
    await writeTextAtomic(indexPath, `${existing.trimEnd()}\n${line}\n`);
  }
}

async function writeFailureKnowledge(
  projectPath: string,
  item: WorkItem,
  title: string,
  summary: string,
  evidencePaths: string[],
  suffix = "failure"
): Promise<void> {
  const entry: KnowledgeEntry = {
    apiVersion,
    kind: "KnowledgeEntry",
    metadata: {
      uid: `KE-${Date.now()}-${item.metadata.uid}-${suffix}`,
      createdAt: nowIso(),
      sourceWorkItem: item.metadata.uid
    },
    spec: {
      category: "failure-pattern",
      title,
      summary: summary.slice(0, 2000),
      evidencePaths,
      action: "Include this failure context in repair prompts for related WorkItems."
    }
  };
  await writeKnowledgeEntryObject(projectPath, entry);
  const failurePath = path.join(orchestrationDir(projectPath), "knowledge", "failures", `${item.metadata.uid}-${suffix}.md`);
  await ensureDir(path.dirname(failurePath));
  await writeTextAtomic(failurePath, [`# ${title}`, "", summary.slice(0, 4000), ""].join("\n"));
}

export function describeWorkItem(item: WorkItem, projectPath: string): string {
  const active = item.status.activeWorktree ? relativeTo(projectPath, path.join(projectPath, item.status.activeWorktree)) : "";
  return [
    `${item.metadata.uid} ${item.metadata.name}`,
    `  phase: ${item.status.phase}`,
    `  attempts: ${item.status.attempts}`,
    `  repairs: ${item.status.repairAttempts}`,
    item.status.candidateId ? `  candidate: ${item.status.candidateId}` : undefined,
    active ? `  worktree: ${active}` : undefined,
    item.status.message ? `  message: ${item.status.message}` : undefined
  ].filter(Boolean).join("\n");
}

export function makeWorkItemFromGoal(uid: string, name: string, goal: string, planUid: string): WorkItem {
  return {
    apiVersion,
    kind: "WorkItem",
    metadata: {
      uid,
      name,
      createdAt: nowIso(),
      generation: 1,
      labels: {},
      ownerReferences: [{ kind: "Plan", uid: planUid }]
    },
    spec: {
      goal,
      contextPaths: [],
      constraints: [],
      acceptanceCriteria: [{ id: "AC-1", text: "The requested behavior is implemented and relevant validation passes." }],
      validationCommands: [],
      dependencies: [],
      risk: "medium",
      allowedPaths: [],
      protectedPaths: []
    },
    status: {
      phase: "Pending",
      observedGeneration: 0,
      attempts: 0,
      repairAttempts: 0,
      candidateIds: [],
      conditions: []
    }
  };
}

export function makePlanFromSpec(uid: string, sourcePath: string, goal: string, workItemRefs: string[]): Plan {
  return {
    apiVersion,
    kind: "Plan" as const,
    metadata: {
      uid,
      name: path.basename(sourcePath).replace(/\.[^.]+$/, "") || uid,
      createdAt: nowIso(),
      generation: 1
    },
    spec: {
      sourcePath,
      goal,
      workItemRefs
    },
    status: {
      phase: "Ready" as const,
      observedGeneration: 1
    }
  };
}

export function nextWorkItemId(existing: WorkItem[]): string {
  return makeId("WI", existing.length + 1);
}
