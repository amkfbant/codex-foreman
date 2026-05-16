import { execa } from "execa";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { apiVersion, type AgentRun } from "./domain.js";
import { runsDir } from "./paths.js";
import { ensureDir, pathExists, readText, writeTextAtomic } from "./utils/fs.js";
import { nowIso } from "./utils/time.js";

export type CodexRole = AgentRun["spec"]["role"];

export type CodexRunRequest = {
  projectPath: string;
  cwd: string;
  workItemId: string;
  role: CodexRole;
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  outputPath?: string;
  outputSchemaPath?: string;
  timeoutSeconds?: number;
};

export interface CodexExec {
  run(request: CodexRunRequest): Promise<AgentRun>;
}

export class FakeCodexExec implements CodexExec {
  async run(request: CodexRunRequest): Promise<AgentRun> {
    const id = `RUN-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const runDir = path.join(runsDir(request.projectPath), request.workItemId);
    await ensureDir(runDir);
    const jsonlPath = path.join(runDir, `${id}.jsonl`);
    const startedAt = nowIso();
    if (request.role === "coder" || request.role === "repairer") {
      await appendFile(path.join(request.cwd, "README.md"), `\n${request.role} ${id}\n`, "utf8");
    }
    const output = fakeOutput(request);
    await writeTextAtomic(jsonlPath, `${JSON.stringify({ type: "run_started", id, role: request.role })}\n${JSON.stringify({ type: "run_completed", id })}\n`);
    if (request.outputPath) await writeTextAtomic(request.outputPath, output);
    return makeRun(request, id, startedAt, jsonlPath, "succeeded", 0);
  }
}

export class RealCodexExec implements CodexExec {
  async run(request: CodexRunRequest): Promise<AgentRun> {
    const id = `RUN-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const runDir = path.join(runsDir(request.projectPath), request.workItemId);
    await ensureDir(runDir);
    const jsonlPath = path.join(runDir, `${id}.jsonl`);
    const startedAt = nowIso();
    const profile = profileForRole(request.role);
    const args = [
      "exec",
      "--cd",
      request.cwd,
      "--sandbox",
      request.sandbox,
      "--ask-for-approval",
      "never",
      "--json"
    ];
    if (await codexProfileExists(request.projectPath, profile)) {
      args.splice(3, 0, "--profile", profile);
    }
    if (request.outputSchemaPath) args.push("--output-schema", request.outputSchemaPath);
    if (request.outputPath) args.push("--output-last-message", request.outputPath);
    args.push(request.prompt);
    const result = await execa("codex", args, {
      cwd: request.cwd,
      reject: false,
      timeout: (request.timeoutSeconds ?? 1800) * 1000,
      all: true
    });
    await writeTextAtomic(jsonlPath, result.stdout ? `${result.stdout}\n` : "");
    return makeRun(
      request,
      id,
      startedAt,
      jsonlPath,
      result.exitCode === 0 ? "succeeded" : "failed",
      result.exitCode ?? undefined,
      result.exitCode === 0 ? undefined : result.all,
      classifyFailure(result.all ?? "")
    );
  }
}

function profileForRole(role: CodexRole): string {
  return role === "coder" || role === "repairer" ? "orchestrator-write" : "orchestrator-readonly";
}

async function codexProfileExists(projectPath: string, profile: string): Promise<boolean> {
  const configPath = path.join(projectPath, ".codex", "config.toml");
  if (!(await pathExists(configPath))) return false;
  const content = await readText(configPath);
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[profiles\\.${escaped}\\]\\s*$`, "m").test(content);
}

function makeRun(
  request: CodexRunRequest,
  id: string,
  startedAt: string,
  jsonlPath: string,
  phase: AgentRun["status"]["phase"],
  exitCode?: number,
  message?: string,
  failureReason?: string
): AgentRun {
  return {
    apiVersion,
    kind: "AgentRun",
    metadata: {
      uid: id,
      workItemRef: request.workItemId,
      createdAt: startedAt
    },
    spec: {
      role: request.role,
      cwd: request.cwd,
      sandbox: request.sandbox,
      outputPath: request.outputPath,
      outputSchemaPath: request.outputSchemaPath
    },
    status: {
      phase,
      startedAt,
      completedAt: nowIso(),
      jsonlPath,
      exitCode,
      failureReason,
      message
    }
  };
}

function classifyFailure(output: string): string | undefined {
  const lower = output.toLowerCase();
  if (lower.includes("sandbox")) return "SandboxDenied";
  if (lower.includes("timed out") || lower.includes("timeout")) return "Timeout";
  if (lower.includes("schema")) return "OutputSchemaMismatch";
  return output ? "CodexError" : undefined;
}

function fakeOutput(request: CodexRunRequest): string {
  if (request.role === "manager") {
    return JSON.stringify({
      workitems: [{
        name: "fake-manager-workitem",
        goal: "Implement the requested change.",
        constraints: [],
        acceptanceCriteria: ["The requested behavior is implemented and relevant validation passes."],
        dependencies: [],
        validationCommands: [],
        contextPaths: [],
        allowedPaths: [],
        risk: "medium"
      }]
    }, null, 2);
  }
  if (request.role === "explorer") {
    return JSON.stringify({
      summary: "Fake explorer inspected the repository.",
      package_map: [],
      validation_commands: [],
      risks: []
    }, null, 2);
  }
  if (request.role === "reviewer") {
    return JSON.stringify({
      result: "approve",
      summary: "Fake reviewer approved the candidate.",
      findings: [],
      next_prompt_hints: []
    }, null, 2);
  }
  return [
    `# ${request.role} result`,
    "",
    "Summary: fake Codex adapter completed successfully.",
    "",
    "Validation: not run by adapter."
  ].join("\n");
}
