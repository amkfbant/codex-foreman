import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  agentRunSchema,
  type AgentRun,
  configSchema,
  controllerLeaseSchema,
  type ControllerLease,
  knowledgeEntrySchema,
  type KnowledgeEntry,
  type OrchestrationConfig,
  patchCandidateSchema,
  type PatchCandidate,
  planSchema,
  type Plan,
  reviewReportSchema,
  type ReviewReport,
  workItemSchema,
  type WorkItem
} from "../domain.js";
import {
  candidatesDir,
  desiredDir,
  orchestrationDir,
  workItemsDir
} from "../paths.js";
import { ForemanError } from "../utils/errors.js";
import { ensureDir, pathExists, readText, writeTextAtomic } from "../utils/fs.js";
import {
  agentRunFromXml,
  agentRunToXml,
  configFromXml,
  configToXml,
  controllerLeaseFromXml,
  controllerLeaseToXml,
  knowledgeEntryFromXml,
  knowledgeEntryToXml,
  patchCandidateFromXml,
  patchCandidateToXml,
  planFromXml,
  planToXml,
  reviewFromXml,
  reviewToXml,
  workItemFromXml,
  workItemToXml
} from "./xml.js";

type Codec<T> = {
  schema: { parse(value: unknown): T };
  toXml(value: T): string;
  fromXml(xml: string): T;
};

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .filter((key) => input[key] !== undefined)
        .sort()
        .map((key) => [key, sortValue(input[key])])
    );
  }
  return value;
}

async function writePair<T>(xmlPath: string, jsonPath: string, value: T, codec: Codec<T>): Promise<void> {
  const versioned = await withNextResourceVersion(xmlPath, jsonPath, value, codec);
  const parsed = codec.schema.parse(versioned);
  await writeTextAtomic(xmlPath, codec.toXml(parsed));
  await writeTextAtomic(jsonPath, `${canonical(parsed)}\n`);
}

async function readPair<T>(xmlPath: string, jsonPath: string, codec: Codec<T>): Promise<T> {
  if (!(await pathExists(xmlPath))) {
    throw new ForemanError("StateMissing", `Missing state file: ${xmlPath}`);
  }
  const xmlValue = codec.schema.parse(codec.fromXml(await readText(xmlPath)));
  if (await pathExists(jsonPath)) {
    const jsonValue = codec.schema.parse(JSON.parse(await readText(jsonPath)) as unknown);
    if (canonical(xmlValue) !== canonical(jsonValue)) {
      throw new ForemanError("StateFormatMismatch", `XML and JSON sidecar differ for ${xmlPath}.`);
    }
  }
  return xmlValue;
}

async function withNextResourceVersion<T>(xmlPath: string, jsonPath: string, value: T, codec: Codec<T>): Promise<T> {
  if (!hasMetadata(value)) return value;
  const current = await readCurrentForCas(xmlPath, jsonPath, codec);
  const expected = value.metadata.resourceVersion;
  const actual = hasMetadata(current) ? current.metadata.resourceVersion : undefined;
  if (actual && expected && actual !== expected) {
    throw new ForemanError("ResourceVersionConflict", `State changed since it was read: ${xmlPath}.`);
  }
  if (actual && !expected && current && hasMetadata(current) && current.metadata.uid === value.metadata.uid) {
    throw new ForemanError("ResourceVersionConflict", `Refusing blind overwrite without resourceVersion: ${xmlPath}.`);
  }
  value.metadata.resourceVersion = nextResourceVersion(actual);
  return value;
}

async function readCurrentForCas<T>(xmlPath: string, jsonPath: string, codec: Codec<T>): Promise<T | undefined> {
  if (await pathExists(jsonPath)) {
    return codec.schema.parse(JSON.parse(await readText(jsonPath)) as unknown);
  }
  if (await pathExists(xmlPath)) {
    return codec.schema.parse(codec.fromXml(await readText(xmlPath)));
  }
  return undefined;
}

function hasMetadata(value: unknown): value is { metadata: { uid?: string; resourceVersion?: string } } {
  return Boolean(value && typeof value === "object" && "metadata" in value
    && (value as { metadata?: unknown }).metadata
    && typeof (value as { metadata?: unknown }).metadata === "object");
}

function nextResourceVersion(previous: string | undefined): string {
  const current = Number(previous ?? 0);
  return Number.isFinite(current) ? String(current + 1) : String(Date.now());
}

const configCodec: Codec<OrchestrationConfig> = {
  schema: configSchema,
  toXml: configToXml,
  fromXml: configFromXml
};

const planCodec: Codec<Plan> = {
  schema: planSchema,
  toXml: planToXml,
  fromXml: planFromXml
};

const workItemCodec: Codec<WorkItem> = {
  schema: workItemSchema,
  toXml: workItemToXml,
  fromXml: workItemFromXml
};

const reviewCodec: Codec<ReviewReport> = {
  schema: reviewReportSchema,
  toXml: reviewToXml,
  fromXml: reviewFromXml
};

const agentRunCodec: Codec<AgentRun> = {
  schema: agentRunSchema,
  toXml: agentRunToXml,
  fromXml: agentRunFromXml
};

const patchCandidateCodec: Codec<PatchCandidate> = {
  schema: patchCandidateSchema,
  toXml: patchCandidateToXml,
  fromXml: patchCandidateFromXml
};

const knowledgeEntryCodec: Codec<KnowledgeEntry> = {
  schema: knowledgeEntrySchema,
  toXml: knowledgeEntryToXml,
  fromXml: knowledgeEntryFromXml
};

const controllerLeaseCodec: Codec<ControllerLease> = {
  schema: controllerLeaseSchema,
  toXml: controllerLeaseToXml,
  fromXml: controllerLeaseFromXml
};

export async function writeConfig(projectPath: string, config: OrchestrationConfig): Promise<void> {
  const dir = orchestrationDir(projectPath);
  await writePair(path.join(dir, "config.xml"), path.join(dir, "config.json"), config, configCodec);
}

export async function readConfig(projectPath: string): Promise<OrchestrationConfig> {
  const dir = orchestrationDir(projectPath);
  return readPair(path.join(dir, "config.xml"), path.join(dir, "config.json"), configCodec);
}

export async function writePlan(projectPath: string, plan: Plan): Promise<void> {
  const dir = desiredDir(projectPath);
  await writePair(path.join(dir, "plan.xml"), path.join(dir, "plan.json"), plan, planCodec);
}

export async function readPlan(projectPath: string): Promise<Plan> {
  const dir = desiredDir(projectPath);
  return readPair(path.join(dir, "plan.xml"), path.join(dir, "plan.json"), planCodec);
}

export async function writeWorkItem(projectPath: string, item: WorkItem): Promise<void> {
  const dir = workItemsDir(projectPath);
  await writePair(path.join(dir, `${item.metadata.uid}.xml`), path.join(dir, `${item.metadata.uid}.json`), item, workItemCodec);
}

export async function readWorkItem(projectPath: string, uid: string): Promise<WorkItem> {
  const dir = workItemsDir(projectPath);
  return readPair(path.join(dir, `${uid}.xml`), path.join(dir, `${uid}.json`), workItemCodec);
}

export async function readWorkItems(projectPath: string): Promise<WorkItem[]> {
  const dir = workItemsDir(projectPath);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir);
  const items = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".xml"))
      .sort()
      .map((entry) => readPair(path.join(dir, entry), path.join(dir, entry.replace(/\.xml$/, ".json")), workItemCodec))
  );
  return items.sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid));
}

export async function writeReview(projectPath: string, report: ReviewReport): Promise<void> {
  const dir = path.join(candidatesDir(projectPath), report.metadata.workItemRef, report.metadata.candidateRef);
  await writePair(path.join(dir, "review.xml"), path.join(dir, "review.json"), report, reviewCodec);
}

export async function readReview(projectPath: string, workItemId: string, candidateId: string): Promise<ReviewReport> {
  const dir = path.join(candidatesDir(projectPath), workItemId, candidateId);
  return readPair(path.join(dir, "review.xml"), path.join(dir, "review.json"), reviewCodec);
}

export async function writeAgentRun(projectPath: string, run: AgentRun): Promise<void> {
  const dir = path.join(orchestrationDir(projectPath), "runs", run.metadata.workItemRef);
  await writePair(path.join(dir, `${run.metadata.uid}.xml`), path.join(dir, `${run.metadata.uid}.json`), run, agentRunCodec);
}

export async function readAgentRuns(projectPath: string, workItemId: string): Promise<AgentRun[]> {
  const dir = path.join(orchestrationDir(projectPath), "runs", workItemId);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir);
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".xml"))
      .sort()
      .map((entry) => readPair(path.join(dir, entry), path.join(dir, entry.replace(/\.xml$/, ".json")), agentRunCodec))
  );
  return runs.sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid));
}

export async function writePatchCandidate(projectPath: string, candidate: PatchCandidate): Promise<void> {
  const dir = path.join(candidatesDir(projectPath), candidate.metadata.workItemRef, candidate.metadata.uid);
  await writePair(path.join(dir, "candidate.xml"), path.join(dir, "candidate.json"), candidate, patchCandidateCodec);
}

export async function readPatchCandidate(projectPath: string, workItemId: string, candidateId: string): Promise<PatchCandidate> {
  const dir = path.join(candidatesDir(projectPath), workItemId, candidateId);
  return readPair(path.join(dir, "candidate.xml"), path.join(dir, "candidate.json"), patchCandidateCodec);
}

export async function readPatchCandidates(projectPath: string, workItemId: string): Promise<PatchCandidate[]> {
  const dir = path.join(candidatesDir(projectPath), workItemId);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir);
  const candidates = await Promise.all(
    entries.sort().map(async (entry) => {
      const candidateDir = path.join(dir, entry);
      const xmlPath = path.join(candidateDir, "candidate.xml");
      if (!(await pathExists(xmlPath))) return undefined;
      return readPair(xmlPath, path.join(candidateDir, "candidate.json"), patchCandidateCodec);
    })
  );
  return candidates.filter((candidate): candidate is PatchCandidate => candidate !== undefined)
    .sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid));
}

export async function writeKnowledgeEntry(projectPath: string, entry: KnowledgeEntry): Promise<void> {
  const dir = path.join(orchestrationDir(projectPath), "knowledge", "entries");
  await writePair(path.join(dir, `${entry.metadata.uid}.xml`), path.join(dir, `${entry.metadata.uid}.json`), entry, knowledgeEntryCodec);
}

export async function readKnowledgeEntries(projectPath: string): Promise<KnowledgeEntry[]> {
  const dir = path.join(orchestrationDir(projectPath), "knowledge", "entries");
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir);
  const values = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".xml"))
      .sort()
      .map((entry) => readPair(path.join(dir, entry), path.join(dir, entry.replace(/\.xml$/, ".json")), knowledgeEntryCodec))
  );
  return values.sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid));
}

export async function writeControllerLease(projectPath: string, lease: ControllerLease): Promise<void> {
  const dir = path.join(orchestrationDir(projectPath), "leases");
  await writePair(path.join(dir, `${lease.metadata.uid}.xml`), path.join(dir, `${lease.metadata.uid}.json`), lease, controllerLeaseCodec);
}

export async function ensureStateDirs(projectPath: string): Promise<void> {
  await Promise.all([
    ensureDir(orchestrationDir(projectPath)),
    ensureDir(desiredDir(projectPath)),
    ensureDir(workItemsDir(projectPath)),
    ensureDir(path.join(orchestrationDir(projectPath), "events")),
    ensureDir(path.join(orchestrationDir(projectPath), "project")),
    ensureDir(path.join(orchestrationDir(projectPath), "knowledge")),
    ensureDir(path.join(orchestrationDir(projectPath), "schemas")),
    ensureDir(path.join(orchestrationDir(projectPath), "locks")),
    ensureDir(path.join(orchestrationDir(projectPath), "leases")),
    ensureDir(path.join(orchestrationDir(projectPath), "runs")),
    ensureDir(path.join(orchestrationDir(projectPath), "candidates")),
    ensureDir(path.join(orchestrationDir(projectPath), "dashboard")),
    ensureDir(path.join(orchestrationDir(projectPath), "knowledge", "entries")),
    ensureDir(path.join(orchestrationDir(projectPath), "worktrees"))
  ]);
}
