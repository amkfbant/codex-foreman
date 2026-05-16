import { XMLBuilder, XMLParser } from "fast-xml-parser";
import {
  type AgentRun,
  apiVersion,
  type ControllerLease,
  type KnowledgeEntry,
  type OrchestrationConfig,
  type PatchCandidate,
  type Plan,
  type ReviewReport,
  type WorkItem
} from "../domain.js";
import { ForemanError } from "../utils/errors.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: true,
  parseTagValue: true,
  trimValues: true
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  format: true,
  suppressEmptyNode: true
});

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringArray(value: string | string[] | undefined): string[] {
  return arrayOf(value).map((item) => String(item));
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && "#text" in value) {
    return String((value as Record<string, unknown>)["#text"] ?? "");
  }
  return String(value);
}

function parseRoot<T extends Record<string, unknown>>(xml: string, kind: string): T {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const root = parsed[kind];
  if (!root || typeof root !== "object") {
    throw new ForemanError("InvalidXml", `Expected XML root <${kind}>.`);
  }
  return root as T;
}

export function configToXml(config: OrchestrationConfig): string {
  return `${builder.build({
    Config: {
      "@_apiVersion": config.apiVersion,
      "@_kind": config.kind,
      defaults: config.defaults,
      retryPolicy: config.retryPolicy,
      autoMerge: config.autoMerge,
      candidatePolicy: config.candidatePolicy,
      security: {
        forbidDependencyChanges: config.security.forbidDependencyChanges,
        highRiskRequiresManualMerge: config.security.highRiskRequiresManualMerge,
        dependencyFiles: { path: config.security.dependencyFiles }
      },
      validationPolicy: {
        allowedExecutables: { executable: config.validationPolicy.allowedExecutables },
        forbiddenArgPatterns: { pattern: config.validationPolicy.forbiddenArgPatterns }
      },
      dashboard: config.dashboard,
      protectedPaths: { path: config.protectedPaths }
    }
  })}\n`;
}

export function configFromXml(xml: string): OrchestrationConfig {
  const root = parseRoot<Record<string, unknown>>(xml, "Config");
  const validationPolicy = root.validationPolicy as Record<string, unknown> | undefined;
  return {
    apiVersion,
    kind: "Config",
    defaults: root.defaults as OrchestrationConfig["defaults"],
    retryPolicy: root.retryPolicy as OrchestrationConfig["retryPolicy"],
    autoMerge: root.autoMerge as OrchestrationConfig["autoMerge"],
    candidatePolicy: (root.candidatePolicy ?? {
      maxCandidates: 1,
      minScoreToSelect: 80,
      parallel: false
    }) as OrchestrationConfig["candidatePolicy"],
    security: {
      forbidDependencyChanges: Boolean((root.security as Record<string, unknown> | undefined)?.forbidDependencyChanges ?? true),
      highRiskRequiresManualMerge: Boolean((root.security as Record<string, unknown> | undefined)?.highRiskRequiresManualMerge ?? true),
      dependencyFiles: stringArray(((root.security as Record<string, unknown> | undefined)?.dependencyFiles as { path?: string | string[] } | undefined)?.path)
    },
    validationPolicy: validationPolicy ? {
      allowedExecutables: stringArray((validationPolicy.allowedExecutables as { executable?: string | string[] } | undefined)?.executable),
      forbiddenArgPatterns: stringArray((validationPolicy.forbiddenArgPatterns as { pattern?: string | string[] } | undefined)?.pattern)
    } : {
      allowedExecutables: ["pnpm", "npm", "yarn", "bun", "pytest", "cargo", "go", "make", "git", "node", "turbo", "nx"],
      forbiddenArgPatterns: ["(^|/)\\.env($|\\b)", "\\brm\\s+-rf\\b", "\\bcurl\\b.*\\|\\s*sh"]
    },
    dashboard: (root.dashboard ?? { defaultOutput: ".orchestration/dashboard/index.html" }) as OrchestrationConfig["dashboard"],
    protectedPaths: stringArray((root.protectedPaths as { path?: string | string[] } | undefined)?.path)
  };
}

export function planToXml(plan: Plan): string {
  return `${builder.build({
    Plan: {
      "@_apiVersion": plan.apiVersion,
      "@_kind": plan.kind,
      metadata: plan.metadata,
      spec: {
        sourcePath: plan.spec.sourcePath,
        goal: plan.spec.goal,
        workItems: { workItemRef: plan.spec.workItemRefs }
      },
      status: plan.status
    }
  })}\n`;
}

export function planFromXml(xml: string): Plan {
  const root = parseRoot<Record<string, unknown>>(xml, "Plan");
  const metadata = root.metadata as Record<string, unknown>;
  const spec = root.spec as Record<string, unknown>;
  return {
    apiVersion,
    kind: "Plan",
    metadata: {
      uid: String(metadata.uid ?? ""),
      name: String(metadata.name ?? ""),
      createdAt: String(metadata.createdAt ?? ""),
      generation: Number(metadata.generation ?? 1),
      resourceVersion: metadata.resourceVersion ? String(metadata.resourceVersion) : undefined
    },
    spec: {
      sourcePath: String(spec.sourcePath ?? ""),
      goal: String(spec.goal ?? ""),
      workItemRefs: stringArray((spec.workItems as { workItemRef?: string | string[] } | undefined)?.workItemRef)
    },
    status: root.status as Plan["status"]
  };
}

export function workItemToXml(item: WorkItem): string {
  return `${builder.build({
    WorkItem: {
      "@_apiVersion": item.apiVersion,
      "@_kind": item.kind,
      metadata: {
        uid: item.metadata.uid,
        name: item.metadata.name,
        createdAt: item.metadata.createdAt,
        generation: item.metadata.generation,
        resourceVersion: item.metadata.resourceVersion,
        labels: {
          label: Object.entries(item.metadata.labels).map(([key, value]) => ({
            "@_key": key,
            "@_value": value
          }))
        },
        ownerReferences: {
          owner: item.metadata.ownerReferences.map((owner) => ({
            "@_kind": owner.kind,
            "@_uid": owner.uid
          }))
        }
      },
      spec: {
        goal: item.spec.goal,
        context: { path: item.spec.contextPaths },
        constraints: { constraint: item.spec.constraints },
        acceptanceCriteria: {
          criterion: item.spec.acceptanceCriteria.map((criterion) => ({
            "@_id": criterion.id,
            "#text": criterion.text
          }))
        },
        validation: { command: item.spec.validationCommands },
        dependencies: { dependency: item.spec.dependencies },
        risk: item.spec.risk,
        allowedScope: { path: item.spec.allowedPaths },
        protectedPaths: { path: item.spec.protectedPaths }
      },
      status: {
        phase: item.status.phase,
        observedGeneration: item.status.observedGeneration,
        attempts: item.status.attempts,
        repairAttempts: item.status.repairAttempts,
        lastRunId: item.status.lastRunId,
        activeWorktree: item.status.activeWorktree,
        candidateId: item.status.candidateId,
        candidateIds: { candidateId: item.status.candidateIds },
        selectedCandidateId: item.status.selectedCandidateId,
        failureReason: item.status.failureReason,
        message: item.status.message,
        conditions: {
          condition: item.status.conditions.map((condition) => ({
            "@_type": condition.type,
            "@_status": condition.status,
            "@_at": condition.at,
            "@_reason": condition.reason,
            "@_message": condition.message
          }))
        }
      }
    }
  })}\n`;
}

export function workItemFromXml(xml: string): WorkItem {
  const root = parseRoot<Record<string, unknown>>(xml, "WorkItem");
  const metadata = root.metadata as Record<string, unknown>;
  const spec = root.spec as Record<string, unknown>;
  const status = root.status as Record<string, unknown>;
  const labels = Object.fromEntries(
    arrayOf((metadata.labels as { label?: unknown | unknown[] } | undefined)?.label).map((label) => {
      const record = label as Record<string, unknown>;
      return [String(record["@_key"]), String(record["@_value"] ?? "")];
    }).filter(([key]) => key !== "undefined")
  );
  const ownerReferences = arrayOf((metadata.ownerReferences as { owner?: unknown | unknown[] } | undefined)?.owner)
    .map((owner) => owner as Record<string, unknown>)
    .filter((owner) => owner["@_uid"])
    .map((owner) => ({
      kind: String(owner["@_kind"] ?? ""),
      uid: String(owner["@_uid"] ?? "")
    }));
  const criteria = arrayOf(
    (spec.acceptanceCriteria as { criterion?: unknown | unknown[] } | undefined)?.criterion
  ).map((criterion, index) => {
    const record = criterion as Record<string, unknown>;
    return {
      id: String(record["@_id"] ?? `AC-${index + 1}`),
      text: textOf(criterion)
    };
  });
  const conditions = arrayOf((status.conditions as { condition?: unknown | unknown[] } | undefined)?.condition)
    .map((condition) => condition as Record<string, unknown>)
    .filter((condition) => condition["@_type"])
    .map((condition) => ({
      type: String(condition["@_type"]),
      status: String(condition["@_status"] ?? "Unknown") as "True" | "False" | "Unknown",
      at: String(condition["@_at"] ?? ""),
      reason: condition["@_reason"] ? String(condition["@_reason"]) : undefined,
      message: condition["@_message"] ? String(condition["@_message"]) : undefined
    }));
  return {
    apiVersion,
    kind: "WorkItem",
    metadata: {
      uid: String(metadata.uid ?? ""),
      name: String(metadata.name ?? ""),
      createdAt: String(metadata.createdAt ?? ""),
      generation: Number(metadata.generation ?? 1),
      resourceVersion: metadata.resourceVersion ? String(metadata.resourceVersion) : undefined,
      labels,
      ownerReferences
    },
    spec: {
      goal: String(spec.goal ?? ""),
      contextPaths: stringArray((spec.context as { path?: string | string[] } | undefined)?.path),
      constraints: stringArray((spec.constraints as { constraint?: string | string[] } | undefined)?.constraint),
      acceptanceCriteria: criteria,
      validationCommands: stringArray((spec.validation as { command?: string | string[] } | undefined)?.command),
      dependencies: stringArray((spec.dependencies as { dependency?: string | string[] } | undefined)?.dependency),
      risk: String(spec.risk ?? "medium") as WorkItem["spec"]["risk"],
      allowedPaths: stringArray((spec.allowedScope as { path?: string | string[] } | undefined)?.path),
      protectedPaths: stringArray((spec.protectedPaths as { path?: string | string[] } | undefined)?.path)
    },
    status: {
      phase: String(status.phase ?? "Pending") as WorkItem["status"]["phase"],
      observedGeneration: Number(status.observedGeneration ?? 0),
      attempts: Number(status.attempts ?? 0),
      repairAttempts: Number(status.repairAttempts ?? 0),
      lastRunId: status.lastRunId ? String(status.lastRunId) : undefined,
      activeWorktree: status.activeWorktree ? String(status.activeWorktree) : undefined,
      candidateId: status.candidateId ? String(status.candidateId) : undefined,
      candidateIds: stringArray((status.candidateIds as { candidateId?: string | string[] } | undefined)?.candidateId),
      selectedCandidateId: status.selectedCandidateId ? String(status.selectedCandidateId) : undefined,
      conditions,
      failureReason: status.failureReason ? String(status.failureReason) : undefined,
      message: status.message ? String(status.message) : undefined
    }
  };
}

export function agentRunToXml(run: AgentRun): string {
  return jsonPayloadToXml("AgentRun", run);
}

export function agentRunFromXml(xml: string): AgentRun {
  return jsonPayloadFromXml<AgentRun>(xml, "AgentRun");
}

export function patchCandidateToXml(candidate: PatchCandidate): string {
  return jsonPayloadToXml("PatchCandidate", candidate);
}

export function patchCandidateFromXml(xml: string): PatchCandidate {
  return jsonPayloadFromXml<PatchCandidate>(xml, "PatchCandidate");
}

export function knowledgeEntryToXml(entry: KnowledgeEntry): string {
  return jsonPayloadToXml("KnowledgeEntry", entry);
}

export function knowledgeEntryFromXml(xml: string): KnowledgeEntry {
  return jsonPayloadFromXml<KnowledgeEntry>(xml, "KnowledgeEntry");
}

export function controllerLeaseToXml(lease: ControllerLease): string {
  return jsonPayloadToXml("ControllerLease", lease);
}

export function controllerLeaseFromXml(xml: string): ControllerLease {
  return jsonPayloadFromXml<ControllerLease>(xml, "ControllerLease");
}

function jsonPayloadToXml(kind: string, value: unknown): string {
  return `${builder.build({
    [kind]: {
      "@_apiVersion": apiVersion,
      "@_kind": kind,
      json: JSON.stringify(value)
    }
  })}\n`;
}

function jsonPayloadFromXml<T>(xml: string, kind: string): T {
  const root = parseRoot<Record<string, unknown>>(xml, kind);
  const payload = textOf(root.json);
  if (!payload) {
    throw new ForemanError("InvalidXml", `Expected JSON payload in <${kind}>.`);
  }
  return JSON.parse(payload) as T;
}

export function reviewToXml(report: ReviewReport): string {
  return `${builder.build({
    ReviewReport: {
      "@_apiVersion": report.apiVersion,
      "@_kind": report.kind,
      metadata: report.metadata,
      result: report.result,
      summary: report.summary,
      findings: {
        finding: report.findings.map((finding) => ({
          "@_severity": finding.severity,
          "@_category": finding.category,
          title: finding.title,
          evidence: {
            item: finding.evidence.map((evidence) => ({
              "@_path": evidence.path,
              "@_lines": evidence.lines
            }))
          },
          requiredChange: finding.requiredChange
        }))
      },
      nextPromptHints: { hint: report.nextPromptHints }
    }
  })}\n`;
}

export function reviewFromXml(xml: string): ReviewReport {
  const root = parseRoot<Record<string, unknown>>(xml, "ReviewReport");
  const findings = arrayOf((root.findings as { finding?: unknown | unknown[] } | undefined)?.finding)
    .map((finding) => finding as Record<string, unknown>)
    .map((finding) => ({
      severity: String(finding["@_severity"] ?? "medium") as ReviewReport["findings"][number]["severity"],
      category: String(finding["@_category"] ?? "correctness") as ReviewReport["findings"][number]["category"],
      title: String(finding.title ?? ""),
      evidence: arrayOf((finding.evidence as { item?: unknown | unknown[] } | undefined)?.item)
        .map((evidence) => evidence as Record<string, unknown>)
        .map((evidence) => ({
          path: String(evidence["@_path"] ?? ""),
          lines: evidence["@_lines"] ? String(evidence["@_lines"]) : undefined
        })),
      requiredChange: String(finding.requiredChange ?? "")
    }));
  return {
    apiVersion,
    kind: "ReviewReport",
    metadata: reviewMetadata(root.metadata),
    result: String(root.result ?? "request_changes") as ReviewReport["result"],
    summary: String(root.summary ?? ""),
    findings,
    nextPromptHints: stringArray((root.nextPromptHints as { hint?: string | string[] } | undefined)?.hint)
  };
}

function reviewMetadata(value: unknown): ReviewReport["metadata"] {
  const metadata = value as Record<string, unknown>;
  return {
    uid: String(metadata.uid ?? ""),
    workItemRef: String(metadata.workItemRef ?? ""),
    candidateRef: String(metadata.candidateRef ?? ""),
    reviewer: String(metadata.reviewer ?? ""),
    createdAt: String(metadata.createdAt ?? ""),
    resourceVersion: metadata.resourceVersion ? String(metadata.resourceVersion) : undefined
  };
}
