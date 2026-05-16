import { apiVersion } from "./domain.js";

export function agentsMdTemplate(): string {
  return `# AGENTS.md

## Repository Expectations

- Treat this repository as managed by Codex Foreman when WorkItems are present.
- Before implementation, read the assigned WorkItem under \`.orchestration/workitems/\`.
- Keep changes minimal and scoped to the assigned WorkItem.
- Do not edit \`.codex/\`, \`.agents/\`, or \`.orchestration/\` unless the task explicitly asks for orchestration maintenance.
- Prefer validation commands listed in \`.orchestration/project/validation-matrix.md\`.
- Report exact commands and results.

## Done Means

- The requested behavior is implemented.
- Relevant tests pass, or any inability to run tests is explained with command output.
- No unrelated refactors are introduced.
- Reviewer-facing summary includes changed files, rationale, risks, and verification.

## Orchestration

- WorkItems live in \`.orchestration/workitems/*.xml\` with JSON sidecars.
- Human-readable knowledge lives in \`.orchestration/knowledge/\`.
- XML and JSON sidecars must stay semantically identical.
`;
}

export function codexConfigTemplate(maxCoders: number, maxReviewers: number): string {
  return `# .codex/config.toml

[agents]
max_threads = ${maxCoders + maxReviewers + 1}
max_depth = 1
job_max_runtime_seconds = 1800
sqlite_home = ".orchestration/.codex-sqlite"

[profiles.orchestrator-readonly]
sandbox_mode = "read-only"
approval_policy = "never"

[profiles.orchestrator-write]
sandbox_mode = "workspace-write"
approval_policy = "never"

[profiles.orchestrator-interactive]
sandbox_mode = "workspace-write"
approval_policy = "on-request"
`;
}

export function agentTomlTemplate(role: "manager" | "explorer" | "coder" | "reviewer" | "repairer"): string {
  const common = {
    manager: [
      "orchestration_manager",
      "Plans, decomposes, assigns, and integrates Codex Foreman WorkItems.",
      "Plan and coordinate. Prefer read-only exploration before assigning implementation."
    ],
    explorer: [
      "orchestration_explorer",
      "Read-only explorer for project structure, commands, package boundaries, and risks.",
      "Stay in exploration mode. Do not modify files. Cite evidence paths."
    ],
    coder: [
      "orchestration_coder",
      "Implementation worker for one WorkItem in an isolated worktree.",
      "Implement exactly one WorkItem. Keep the diff minimal. Run the smallest relevant validation."
    ],
    reviewer: [
      "orchestration_reviewer",
      "Read-only reviewer for correctness, security, tests, and spec adherence.",
      "Review like a code owner. Do not edit files. Return approve, request_changes, or reject."
    ],
    repairer: [
      "orchestration_repairer",
      "Repair worker for reviewer findings or validation failures.",
      "Fix only listed findings or failures. Preserve scope and rerun relevant checks."
    ]
  }[role];
  return `name = "${common[0]}"
description = "${common[1]}"
model_reasoning_effort = "${role === "explorer" ? "medium" : "high"}"
sandbox_mode = "${role === "reviewer" || role === "explorer" || role === "manager" ? "read-only" : "workspace-write"}"
developer_instructions = """
${common[2]}
"""
`;
}

export function orchestrationSkillTemplate(): string {
  return `---
name: orchestration-init
description: Initialize Codex orchestration by analyzing repository structure, commands, package boundaries, risks, and conventions.
---

# Orchestration Init Skill

You are onboarding a repository for multi-agent Codex orchestration.

## Rules

- Prefer read-only analysis unless the user explicitly asks you to write files.
- Identify package boundaries, service boundaries, test commands, lint commands, build commands, and risky areas.
- Distinguish facts observed from files from guesses.
- Look for existing docs before inferring behavior.
- Keep AGENTS.md short; put detailed knowledge under .orchestration/knowledge/.
- When returning structured output, include confidence and evidence paths.

## Output Sections

1. Repository summary
2. Monorepo/package map
3. Important commands
4. Test and validation strategy
5. Architectural constraints
6. Risk register
7. Suggested first WorkItems
8. Recommended AGENTS.md additions
`;
}

export function orchestrationReadmeTemplate(): string {
  return `# .orchestration

This directory stores Codex Foreman desired state, observed state, run logs, candidate artifacts, and accumulated project knowledge.

- \`config.xml\` and \`config.json\` configure the controller.
- \`desired/plan.xml\` and \`desired/plan.json\` describe the active plan.
- \`workitems/*.xml\` and matching \`*.json\` files are controller objects.
- \`runs/\` stores Codex JSONL logs.
- \`candidates/\` stores candidate reports, patches, validation logs, and reviews.
- \`knowledge/\` stores durable human-readable project knowledge.
`;
}

export function reviewSchemaTemplate(): string {
  return `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Codex Foreman Review Result",
    type: "object",
    required: ["result", "summary", "findings", "next_prompt_hints"],
    properties: {
      result: { enum: ["approve", "request_changes", "reject"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["severity", "category", "title", "evidence", "required_change"],
          properties: {
            severity: { enum: ["low", "medium", "high", "critical"] },
            category: { enum: ["correctness", "security", "tests", "maintainability", "spec"] },
            title: { type: "string" },
            evidence: {
              type: "array",
              items: {
                type: "object",
                required: ["path"],
                properties: {
                  path: { type: "string" },
                  lines: { type: "string" }
                }
              }
            },
            required_change: { type: "string" }
          }
        }
      },
      next_prompt_hints: { type: "array", items: { type: "string" } }
    }
  }, null, 2)}\n`;
}

export function initAnalysisSchemaTemplate(): string {
  return jsonSchema({
    title: "Codex Foreman Init Analysis",
    type: "object",
    required: ["summary", "package_map", "validation_commands", "risks"],
    properties: {
      summary: { type: "string" },
      package_map: { type: "array", items: { type: "object" } },
      validation_commands: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } }
    }
  });
}

export function coderResultSchemaTemplate(): string {
  return jsonSchema({
    title: "Codex Foreman Coder Result",
    type: "object",
    required: ["summary", "changed_files", "validation", "risks"],
    properties: {
      summary: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } },
      validation: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } }
    }
  });
}

export function managerPlanSchemaTemplate(): string {
  return jsonSchema({
    title: "Codex Foreman Manager Plan",
    type: "object",
    required: ["workitems"],
    properties: {
      workitems: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "goal"],
          properties: {
            name: { type: "string" },
            goal: { type: "string" },
            constraints: { type: "array", items: { type: "string" } },
            acceptanceCriteria: { type: "array", items: { type: "string" } },
            dependencies: { type: "array", items: { type: "string" } },
            risk: { enum: ["low", "medium", "high"] }
          }
        }
      }
    }
  });
}

export function stateKindSchemaTemplate(kind: string): string {
  return jsonSchema({
    title: `Codex Foreman ${kind}`,
    type: "object",
    required: ["apiVersion", "kind", "metadata"],
    properties: {
      apiVersion: { const: apiVersion },
      kind: { const: kind },
      metadata: { type: "object" },
      spec: { type: "object" },
      status: { type: "object" }
    }
  });
}

export function orchestrationRulesTemplate(): string {
  return `# Codex Foreman orchestration rules

# This file is intentionally conservative and documents the intended command policy.
# Installers keep it as project-local policy text because Codex CLI rule syntax can vary by version.

allow: git status
allow: git diff
allow: git log
allow: git worktree list
allow: npm test
allow: pnpm test
allow: pytest
allow: cargo test
allow: go test
prompt: git push
prompt: gh pr create
forbid: rm -rf /
forbid: curl | sh
forbid: reading ~/.ssh
forbid: reading .env
`;
}

function jsonSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...schema
  }, null, 2)}\n`;
}

export function configXmlComment(): string {
  return `Codex Foreman config uses apiVersion ${apiVersion}.`;
}
