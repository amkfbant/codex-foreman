import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRun } from "../domain.js";
import type { CodexExec } from "../codex.js";
import { projectInfoDir } from "../paths.js";
import { writeAgentRun } from "../state/store.js";
import { ForemanError } from "../utils/errors.js";
import { ensureDir, writeTextAtomic } from "../utils/fs.js";

export async function initCommand(projectPath: string, options: { codex?: CodexExec } = {}): Promise<string[]> {
  const files = await listProjectFiles(projectPath);
  const packageManagers = detectPackageManagers(files);
  let commands = await detectCommands(projectPath, files, packageManagers);
  let codexAnalysis: InitAnalysis | undefined;
  const dir = projectInfoDir(projectPath);
  await ensureDir(dir);
  if (options.codex) {
    const outputPath = path.join(dir, "init-analysis.json");
    const run = await options.codex.run({
      projectPath,
      cwd: projectPath,
      workItemId: "INIT",
      role: "explorer",
      prompt: "Use the orchestration-init skill. Analyze this repository in read-only mode and return JSON with summary, package_map, validation_commands, and risks.",
      sandbox: "read-only",
      outputPath,
      outputSchemaPath: path.join(projectPath, ".orchestration", "schemas", "init-analysis.schema.json")
    });
    await writeAgentRun(projectPath, run);
    assertRunSucceeded(run);
    codexAnalysis = await readInitAnalysis(outputPath);
    commands = [...new Set([...commands, ...codexAnalysis.validation_commands])];
  }
  await writeTextAtomic(path.join(dir, "overview.md"), renderOverview(files, packageManagers, codexAnalysis));
  await writeTextAtomic(path.join(dir, "validation-matrix.md"), renderValidation(commands));
  await writeTextAtomic(path.join(dir, "validation-catalog.json"), renderValidationCatalog(commands));
  await writeTextAtomic(path.join(dir, "package-map.xml"), renderPackageMap(files));
  await writeTextAtomic(path.join(dir, "risk-register.md"), renderRiskRegister(files, codexAnalysis));
  return [
    "wrote .orchestration/project/overview.md",
    "wrote .orchestration/project/validation-matrix.md",
    "wrote .orchestration/project/validation-catalog.json",
    "wrote .orchestration/project/package-map.xml",
    "wrote .orchestration/project/risk-register.md",
    ...(options.codex ? ["wrote .orchestration/project/init-analysis.json"] : [])
  ];
}

type InitAnalysis = {
  summary: string;
  package_map: unknown[];
  validation_commands: string[];
  risks: string[];
};

async function listProjectFiles(projectPath: string): Promise<string[]> {
  const ignored = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".venv",
    "target",
    "vendor",
    "tmp",
    ".orchestration",
    ".codex",
    ".agents"
  ]);
  const results: string[] = [];
  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 8 || results.length >= 10_000) return;
    const entries = await readdir(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const rel = path.relative(projectPath, full).replaceAll(path.sep, "/");
      if ([...ignored].some((ignoredPath) => rel === ignoredPath || rel.startsWith(`${ignoredPath}/`))) continue;
      const stats = await lstat(full);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        if (stats.size > 1_000_000) continue;
        results.push(rel);
      }
    }
  }
  await walk(projectPath);
  return results.sort();
}

function detectPackageManagers(files: string[]): string[] {
  const managers: string[] = [];
  if (files.includes("pnpm-lock.yaml") || files.includes("pnpm-workspace.yaml")) managers.push("pnpm");
  if (files.includes("package-lock.json") || hasManifest(files, "package.json")) managers.push("npm");
  if (files.includes("yarn.lock")) managers.push("yarn");
  if (files.includes("bun.lockb") || files.includes("bun.lock")) managers.push("bun");
  if (hasManifest(files, "pyproject.toml")) managers.push("python");
  if (hasManifest(files, "Cargo.toml")) managers.push("cargo");
  if (hasManifest(files, "go.mod")) managers.push("go");
  return managers;
}

async function detectCommands(projectPath: string, files: string[], packageManagers: string[]): Promise<string[]> {
  const commands = new Set<string>();
  for (const manifest of files.filter((file) => file === "package.json" || file.endsWith("/package.json"))) {
    const pkg = JSON.parse(await readFile(path.join(projectPath, manifest), "utf8")) as { scripts?: Record<string, string> };
    const pm = packageManagers.find((manager) => ["pnpm", "npm", "yarn", "bun"].includes(manager)) ?? "npm";
    const packageDir = path.dirname(manifest) === "." ? "." : path.dirname(manifest);
    for (const script of ["test", "lint", "build"]) {
      if (pkg.scripts?.[script]) commands.add(packageScriptCommand(pm, packageDir, script));
    }
  }
  if (hasManifest(files, "pyproject.toml")) commands.add("pytest");
  if (hasManifest(files, "Cargo.toml")) commands.add("cargo test");
  if (hasManifest(files, "go.mod")) commands.add("go test ./...");
  if (files.includes("Makefile")) commands.add("make test");
  return [...commands];
}

function hasManifest(files: string[], name: string): boolean {
  return files.some((file) => file === name || file.endsWith(`/${name}`));
}

function packageScriptCommand(pm: string, packageDir: string, script: string): string {
  if (packageDir === ".") return `${pm} ${script}`;
  if (pm === "pnpm") return `pnpm --dir ${packageDir} ${script}`;
  if (pm === "yarn") return `yarn --cwd ${packageDir} ${script}`;
  if (pm === "bun") return `bun --cwd ${packageDir} run ${script}`;
  return `npm --prefix ${packageDir} ${script}`;
}

function renderOverview(files: string[], packageManagers: string[], analysis?: InitAnalysis): string {
  return [
    "# Project Overview",
    "",
    `Observed files: ${files.length}`,
    `Detected ecosystems: ${packageManagers.length ? packageManagers.join(", ") : "none"}`,
    ...(analysis ? ["", "## Codex Analysis", "", analysis.summary] : []),
    "",
    "## Top-Level Files",
    "",
    ...files.filter((file) => !file.includes("/")).map((file) => `- ${file}`)
  ].join("\n") + "\n";
}

function renderValidation(commands: string[]): string {
  return [
    "# Validation Matrix",
    "",
    commands.length ? "## Candidate Commands" : "No validation commands were detected.",
    "",
    ...commands.map((command) => `- \`${command}\``)
  ].join("\n") + "\n";
}

function renderValidationCatalog(commands: string[]): string {
  return `${JSON.stringify({
    commands: commands.map((command) => ({
      command,
      source: "init-detection",
      confidence: "medium"
    }))
  }, null, 2)}\n`;
}

function renderPackageMap(files: string[]): string {
  const packageFiles = files.filter((file) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(file));
  const body = packageFiles.map((file) => `  <package path="${escapeXml(path.dirname(file) === "." ? "." : path.dirname(file))}" manifest="${escapeXml(file)}" />`);
  return ["<PackageMap>", ...body, "</PackageMap>", ""].join("\n");
}

function renderRiskRegister(files: string[], analysis?: InitAnalysis): string {
  const risks = [
    files.some((file) => file.includes(".env")) ? "- Secret-like env files are present; keep them out of worker context." : undefined,
    files.some((file) => file.includes("migration")) ? "- Migration-like files are present; require human merge review." : undefined,
    files.some((file) => file.includes("auth")) ? "- Auth-related paths are present; require high-signal review for related WorkItems." : undefined,
    ...(analysis?.risks.map((risk) => `- ${risk}`) ?? [])
  ].filter(Boolean);
  return ["# Risk Register", "", ...(risks.length ? risks : ["No obvious static risks detected."]), ""].join("\n");
}

async function readInitAnalysis(filePath: string): Promise<InitAnalysis> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (!Array.isArray(raw.validation_commands) || !Array.isArray(raw.risks)) {
      throw new ForemanError("InitAnalysisInvalid", "Init analysis JSON is missing validation_commands or risks arrays.");
    }
    return {
      summary: String(raw.summary ?? ""),
      package_map: Array.isArray(raw.package_map) ? raw.package_map : [],
      validation_commands: raw.validation_commands.map(String),
      risks: raw.risks.map(String)
    };
  } catch (error) {
    throw error instanceof ForemanError
      ? error
      : new ForemanError("InitAnalysisInvalid", `Init analysis output was not valid JSON: ${(error as Error).message}`);
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

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
