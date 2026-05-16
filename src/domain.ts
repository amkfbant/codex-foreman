import { z } from "zod";

export const apiVersion = "orchestration.codex/v1" as const;

export const phaseSchema = z.enum([
  "Pending",
  "Planned",
  "Ready",
  "Implementing",
  "Validating",
  "Reviewing",
  "Repairing",
  "ReadyToMerge",
  "Merged",
  "Blocked",
  "Failed",
  "Abandoned"
]);

export type Phase = z.infer<typeof phaseSchema>;

export const conditionSchema = z.object({
  type: z.string(),
  status: z.enum(["True", "False", "Unknown"]),
  at: z.string(),
  reason: z.string().optional(),
  message: z.string().optional()
});

export type Condition = z.infer<typeof conditionSchema>;

export const configSchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("Config"),
  defaults: z.object({
    maxCoders: z.number().int().min(1).max(8),
    maxReviewers: z.number().int().min(1).max(4),
    validationTimeoutSeconds: z.number().int().min(1)
  }),
  retryPolicy: z.object({
    maxImplementationAttempts: z.number().int().min(0),
    maxRepairAttempts: z.number().int().min(0),
    backoffSeconds: z.number().int().min(0),
    onRepeatedFailure: z.literal("mark_blocked")
  }),
  autoMerge: z.object({
    enabled: z.boolean(),
    maxChangedFiles: z.number().int().min(1),
    allowHighRisk: z.boolean()
  }),
  candidatePolicy: z.object({
    maxCandidates: z.number().int().min(1).max(8),
    minScoreToSelect: z.number().int(),
    parallel: z.boolean()
  }),
  security: z.object({
    forbidDependencyChanges: z.boolean(),
    highRiskRequiresManualMerge: z.boolean(),
    dependencyFiles: z.array(z.string())
  }),
  validationPolicy: z.object({
    allowedExecutables: z.array(z.string()),
    forbiddenArgPatterns: z.array(z.string())
  }).default({
    allowedExecutables: ["pnpm", "npm", "yarn", "bun", "pytest", "cargo", "go", "make", "git", "node", "turbo", "nx"],
    forbiddenArgPatterns: ["(^|/)\\.env($|\\b)", "\\brm\\s+-rf\\b", "\\bcurl\\b.*\\|\\s*sh"]
  }),
  dashboard: z.object({
    defaultOutput: z.string()
  }),
  protectedPaths: z.array(z.string())
});

export type OrchestrationConfig = z.infer<typeof configSchema>;

export const planSchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("Plan"),
  metadata: z.object({
    uid: z.string(),
    name: z.string(),
    createdAt: z.string(),
    generation: z.number().int().min(1),
    resourceVersion: z.string().optional()
  }),
  spec: z.object({
    sourcePath: z.string(),
    goal: z.string(),
    workItemRefs: z.array(z.string())
  }),
  status: z.object({
    phase: z.enum(["Planning", "Ready", "Complete", "Blocked"]),
    observedGeneration: z.number().int().min(0),
    message: z.string().optional()
  })
});

export type Plan = z.infer<typeof planSchema>;

export const workItemSchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("WorkItem"),
  metadata: z.object({
    uid: z.string(),
    name: z.string(),
    createdAt: z.string(),
    generation: z.number().int().min(1),
    resourceVersion: z.string().optional(),
    labels: z.record(z.string()).default({}),
    ownerReferences: z.array(z.object({
      kind: z.string(),
      uid: z.string()
    })).default([])
  }),
  spec: z.object({
    goal: z.string(),
    contextPaths: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.object({
      id: z.string(),
      text: z.string()
    })).default([]),
    validationCommands: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),
    risk: z.enum(["low", "medium", "high"]).default("medium"),
    allowedPaths: z.array(z.string()).default([]),
    protectedPaths: z.array(z.string()).default([])
  }),
  status: z.object({
    phase: phaseSchema,
    observedGeneration: z.number().int().min(0),
    attempts: z.number().int().min(0),
    repairAttempts: z.number().int().min(0),
    lastRunId: z.string().optional(),
    activeWorktree: z.string().optional(),
    candidateId: z.string().optional(),
    candidateIds: z.array(z.string()).default([]),
    selectedCandidateId: z.string().optional(),
    conditions: z.array(conditionSchema).default([]),
    failureReason: z.string().optional(),
    message: z.string().optional()
  })
});

export type WorkItem = z.infer<typeof workItemSchema>;

export const reviewFindingSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum(["correctness", "security", "tests", "maintainability", "spec"]),
  title: z.string(),
  evidence: z.array(z.object({
    path: z.string(),
    lines: z.string().optional()
  })).default([]),
  requiredChange: z.string()
});

export const reviewReportSchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("ReviewReport"),
  metadata: z.object({
    uid: z.string(),
    workItemRef: z.string(),
    candidateRef: z.string(),
    reviewer: z.string(),
    createdAt: z.string(),
    resourceVersion: z.string().optional()
  }),
  result: z.enum(["approve", "request_changes", "reject"]),
  summary: z.string(),
  findings: z.array(reviewFindingSchema).default([]),
  nextPromptHints: z.array(z.string()).default([])
});

export type ReviewReport = z.infer<typeof reviewReportSchema>;

export const agentRunSchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("AgentRun"),
  metadata: z.object({
    uid: z.string(),
    workItemRef: z.string(),
    candidateRef: z.string().optional(),
    createdAt: z.string(),
    resourceVersion: z.string().optional()
  }),
  spec: z.object({
    role: z.enum(["explorer", "coder", "reviewer", "repairer", "manager"]),
    cwd: z.string(),
    sandbox: z.enum(["read-only", "workspace-write"]),
    outputPath: z.string().optional(),
    outputSchemaPath: z.string().optional()
  }),
  status: z.object({
    phase: z.enum(["running", "succeeded", "failed", "timed_out"]),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    jsonlPath: z.string(),
    exitCode: z.number().int().optional(),
    failureReason: z.string().optional(),
    message: z.string().optional()
  })
});

export type AgentRun = z.infer<typeof agentRunSchema>;

export const validationCommandResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  logPath: z.string(),
  durationMs: z.number().int().min(0)
});

export const candidateScoreSchema = z.object({
  value: z.number().int(),
  reasons: z.array(z.string())
});

export const patchCandidateSchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("PatchCandidate"),
  metadata: z.object({
    uid: z.string(),
    workItemRef: z.string(),
    createdAt: z.string(),
    generation: z.number().int().min(1),
    resourceVersion: z.string().optional()
  }),
  spec: z.object({
    worktree: z.string(),
    branch: z.string(),
    candidateDir: z.string(),
    variant: z.string(),
    baseHead: z.string().optional()
  }),
  status: z.object({
    phase: z.enum(["Created", "Implemented", "Validated", "Reviewing", "Reviewed", "Repairing", "Selected", "Rejected", "Merged"]),
    coderRunId: z.string().optional(),
    reviewerRunId: z.string().optional(),
    repairRunIds: z.array(z.string()).default([]),
    validation: z.object({
      status: z.enum(["unknown", "passed", "failed", "skipped"]),
      commands: z.array(validationCommandResultSchema).default([]),
      logPath: z.string().optional()
    }),
    reviewResult: z.enum(["approve", "request_changes", "reject", "missing", "invalid"]).default("missing"),
    changedFiles: z.array(z.string()).default([]),
    diffStat: z.string().default(""),
    score: candidateScoreSchema.optional(),
    failureReason: z.string().optional(),
    message: z.string().optional()
  })
});

export type PatchCandidate = z.infer<typeof patchCandidateSchema>;
export type Candidate = PatchCandidate;

export const knowledgeEntrySchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("KnowledgeEntry"),
  metadata: z.object({
    uid: z.string(),
    createdAt: z.string(),
    sourceWorkItem: z.string().optional(),
    resourceVersion: z.string().optional()
  }),
  spec: z.object({
    category: z.enum(["decision", "lesson", "pattern", "failure-pattern"]),
    title: z.string(),
    summary: z.string(),
    evidencePaths: z.array(z.string()).default([]),
    action: z.string().optional()
  })
});

export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

export const controllerLeaseSchema = z.object({
  apiVersion: z.literal(apiVersion),
  kind: z.literal("ControllerLease"),
  metadata: z.object({
    uid: z.string(),
    resourceVersion: z.string().optional()
  }),
  spec: z.object({
    workItemRef: z.string(),
    holderIdentity: z.string(),
    acquiredAt: z.string(),
    renewTime: z.string(),
    ttlSeconds: z.number().int().min(1)
  })
});

export type ControllerLease = z.infer<typeof controllerLeaseSchema>;

export type ControllerEvent = {
  at: string;
  type: string;
  workItemId?: string;
  message: string;
  data?: Record<string, unknown>;
};
