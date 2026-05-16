import path from "node:path";
import type { AgentRun } from "../domain.js";
import type { CodexExec } from "../codex.js";
import { makePlanFromSpec, makeWorkItemFromGoal } from "../controller.js";
import { readWorkItems, writeAgentRun, writePlan, writeWorkItem } from "../state/store.js";
import { ForemanError } from "../utils/errors.js";
import { readText } from "../utils/fs.js";
import { makeId } from "../utils/time.js";

export async function planCommand(projectPath: string, specPath: string, options: { codex?: CodexExec } = {}): Promise<string[]> {
  const absoluteSpecPath = path.resolve(projectPath, specPath);
  const spec = await readText(absoluteSpecPath);
  if (options.codex) {
    const managerOutputPath = path.join(projectPath, ".orchestration", "desired", "manager-plan.json");
    const run = await options.codex.run({
      projectPath,
      cwd: projectPath,
      workItemId: "PLAN",
      role: "manager",
      prompt: renderManagerPrompt(spec),
      sandbox: "read-only",
      outputPath: managerOutputPath,
      outputSchemaPath: path.join(projectPath, ".orchestration", "schemas", "manager-plan.schema.json")
    });
    await writeAgentRun(projectPath, run);
    assertRunSucceeded(run);
    const parsed = await readManagerPlan(managerOutputPath);
    if (parsed.length > 0) {
      return writeDerivedPlan(projectPath, absoluteSpecPath, spec, parsed);
    }
    throw new ForemanError("ManagerPlanEmpty", "Manager produced no WorkItems.");
  }
  return writeDerivedPlan(projectPath, absoluteSpecPath, spec, deriveWorkItems(spec));
}

async function writeDerivedPlan(
  projectPath: string,
  absoluteSpecPath: string,
  spec: string,
  derived: DerivedWorkItem[]
): Promise<string[]> {
  const existing = await readWorkItems(projectPath);
  const planUid = makeId("PLAN");
  const goal = extractGoal(spec);
  const items = derived.map((derivedItem, index) => {
    const uid = makeId("WI", existing.length + index + 1);
    const item = makeWorkItemFromGoal(uid, slugify(derivedItem.name), derivedItem.goal, planUid);
    item.spec.constraints = derivedItem.constraints;
    item.spec.acceptanceCriteria = derivedItem.acceptanceCriteria.length
      ? derivedItem.acceptanceCriteria.map((text, criterionIndex) => ({ id: `AC-${criterionIndex + 1}`, text }))
      : item.spec.acceptanceCriteria;
    item.spec.risk = derivedItem.risk;
    return item;
  });
  const dependencyMap = new Map<string, string>();
  for (let index = 0; index < derived.length; index += 1) {
    const derivedItem = derived[index];
    const item = items[index];
    if (!derivedItem || !item) continue;
    dependencyMap.set(derivedItem.name, item.metadata.uid);
    dependencyMap.set(slugify(derivedItem.name), item.metadata.uid);
    dependencyMap.set(item.metadata.name, item.metadata.uid);
  }
  for (let index = 0; index < derived.length; index += 1) {
    const derivedItem = derived[index];
    const item = items[index];
    if (!derivedItem || !item) continue;
    item.spec.dependencies = derivedItem.dependencies.map((dependency) => {
      const uid = dependencyMap.get(dependency) ?? dependencyMap.get(slugify(dependency));
      if (!uid) throw new ForemanError("UnknownDependency", `WorkItem ${derivedItem.name} depends on unknown item ${dependency}.`);
      return uid;
    });
  }
  const plan = makePlanFromSpec(planUid, path.relative(projectPath, absoluteSpecPath).replaceAll(path.sep, "/"), goal, items.map((item) => item.metadata.uid));
  await writePlan(projectPath, plan);
  await Promise.all(existing
    .filter((item) => !items.some((next) => next.metadata.uid === item.metadata.uid))
    .filter((item) => !["Merged", "Blocked", "Failed", "Abandoned"].includes(item.status.phase))
    .map((item) => {
      item.status.phase = "Abandoned";
      item.status.message = "Abandoned because a newer plan no longer references this WorkItem.";
      return writeWorkItem(projectPath, item);
    }));
  await Promise.all(items.map((item) => writeWorkItem(projectPath, item)));
  return [
    `wrote .orchestration/desired/plan.xml`,
    ...items.map((item) => `wrote .orchestration/workitems/${item.metadata.uid}.xml`)
  ];
}

type DerivedWorkItem = {
  name: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  risk: "low" | "medium" | "high";
};

function deriveWorkItems(markdown: string): DerivedWorkItem[] {
  const taskSection = markdown.match(/##\s*(WorkItems|Tasks|Implementation Steps)\s*\n+([\s\S]*?)(\n##\s|\n#\s|$)/i)?.[2];
  const bulletTasks = taskSection
    ?.split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value)) ?? [];
  const headingTasks = [...markdown.matchAll(/^###\s+(.+)$/gm)].map((match) => match[1]).filter((value): value is string => Boolean(value));
  const candidates = bulletTasks.length ? bulletTasks : headingTasks;
  if (candidates.length === 0) {
    const goal = extractGoal(markdown);
    return [{
      name: firstHeading(markdown) ?? (goal.slice(0, 48) || "workitem"),
      goal,
      constraints: extractList(markdown, "Constraints"),
      acceptanceCriteria: extractList(markdown, "Acceptance Criteria"),
      dependencies: [],
      risk: inferRisk(markdown)
    }];
  }
  return candidates.map((candidate) => {
    const [rawName, ...rest] = candidate.split(":");
    const name = rawName ?? "workitem";
    const goal = rest.join(":").trim() || candidate;
    return {
      name: name.trim(),
      goal,
      constraints: extractList(markdown, "Constraints"),
      acceptanceCriteria: extractList(markdown, "Acceptance Criteria"),
      dependencies: [],
      risk: inferRisk(candidate)
    };
  });
}

function extractList(markdown: string, heading: string): string[] {
  const section = markdown.match(new RegExp(`##\\s*${heading}\\s*\\n+([\\s\\S]*?)(\\n##\\s|\\n#\\s|$)`, "i"))?.[1];
  return section
    ?.split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value)) ?? [];
}

function inferRisk(text: string): "low" | "medium" | "high" {
  return /auth|security|billing|payment|migration|credential|secret/i.test(text) ? "high" : "medium";
}

function renderManagerPrompt(spec: string): string {
  return [
    "You are the manager worker for Codex Foreman.",
    "Decompose this Markdown specification into WorkItems.",
    "Return JSON only: {\"workitems\":[{\"name\":\"...\",\"goal\":\"...\",\"constraints\":[],\"acceptanceCriteria\":[],\"dependencies\":[],\"risk\":\"low|medium|high\"}]}",
    "",
    spec
  ].join("\n");
}

async function readManagerPlan(filePath: string): Promise<DerivedWorkItem[]> {
  try {
    const raw = JSON.parse(await readText(filePath)) as { workitems?: unknown[] };
    if (!Array.isArray(raw.workitems)) {
      throw new ForemanError("ManagerPlanInvalid", "Manager output did not contain a workitems array.");
    }
    return raw.workitems.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        name: String(record.name ?? "workitem"),
        goal: String(record.goal ?? record.name ?? "Implement the requested change."),
        constraints: Array.isArray(record.constraints) ? record.constraints.map(String) : [],
        acceptanceCriteria: Array.isArray(record.acceptanceCriteria) ? record.acceptanceCriteria.map(String) : [],
        dependencies: Array.isArray(record.dependencies) ? record.dependencies.map(String) : [],
        risk: record.risk === "low" || record.risk === "high" ? record.risk : "medium"
      };
    });
  } catch (error) {
    throw error instanceof ForemanError
      ? error
      : new ForemanError("ManagerPlanInvalid", `Manager output was not valid JSON: ${(error as Error).message}`);
  }
}

function assertRunSucceeded(run: AgentRun): void {
  if (run.status.phase !== "succeeded" || run.status.exitCode !== 0) {
    throw new ForemanError(
      run.status.failureReason ?? "CodexRunFailed",
      run.status.message ?? `Codex run ${run.metadata.uid} failed.`
    );
  }
}

function firstHeading(markdown: string): string | undefined {
  return markdown.split(/\r?\n/).map((line) => line.match(/^#\s+(.+)$/)?.[1]).find(Boolean);
}

function extractGoal(markdown: string): string {
  const goalSection = markdown.match(/##\s*Goal\s*\n+([\s\S]*?)(\n##\s|\n#\s|$)/i)?.[1]?.trim();
  if (goalSection) return goalSection.replace(/\s+/g, " ");
  const paragraphs = markdown
    .replace(/^#.*$/gm, "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (paragraphs[0] ?? "Implement the requested change.").replace(/\s+/g, " ");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "workitem";
}
