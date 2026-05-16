import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { isGitRepo } from "../git.js";
import { schemasDir } from "../paths.js";
import { defaultConfig } from "../state/defaults.js";
import { ensureStateDirs, writeConfig } from "../state/store.js";
import { configToXml } from "../state/xml.js";
import {
  agentTomlTemplate,
  agentsMdTemplate,
  coderResultSchemaTemplate,
  codexConfigTemplate,
  initAnalysisSchemaTemplate,
  managerPlanSchemaTemplate,
  orchestrationReadmeTemplate,
  orchestrationRulesTemplate,
  orchestrationSkillTemplate,
  reviewSchemaTemplate,
  stateKindSchemaTemplate
} from "../templates.js";
import { ForemanError } from "../utils/errors.js";
import { ensureDir, pathExists, writeTextAtomic } from "../utils/fs.js";

export type InstallOptions = {
  mode: "auto" | "new" | "existing";
  overwrite: "none" | "safe" | "force";
  maxCoders: number;
  maxReviewers: number;
};

export async function installCommand(projectPath: string, options: InstallOptions): Promise<string[]> {
  await ensureProject(projectPath, options.mode);
  const messages: string[] = [];
  const gitRepo = await isGitRepo(projectPath);
  if (!gitRepo && options.mode !== "new") {
    throw new ForemanError("NotGitRepo", `${projectPath} is not a git repository. Use --mode new after initializing git.`);
  }
  await ensureStateDirs(projectPath);

  const config = defaultConfig();
  config.defaults.maxCoders = options.maxCoders;
  config.defaults.maxReviewers = options.maxReviewers;
  const configXmlPath = path.join(projectPath, ".orchestration/config.xml");
  const configJsonPath = path.join(projectPath, ".orchestration/config.json");
  if (options.overwrite === "force" || !(await pathExists(configXmlPath)) || !(await pathExists(configJsonPath))) {
    await writeConfig(projectPath, config);
    messages.push("wrote .orchestration/config.xml and config.json");
  } else if (options.overwrite === "safe") {
    await writeTextAtomic(path.join(projectPath, ".orchestration/config.orchestration.patch.xml"), configToXml(config));
    await writeTextAtomic(path.join(projectPath, ".orchestration/config.orchestration.patch.json"), `${JSON.stringify(config, null, 2)}\n`);
    messages.push("kept existing .orchestration/config files; wrote config orchestration patches");
  } else {
    messages.push("kept existing .orchestration/config files");
  }

  await writeManagedFile(projectPath, "AGENTS.md", agentsMdTemplate(), options.overwrite, "AGENTS.orchestration.patch.md", messages);
  await writeManagedFile(projectPath, ".codex/config.toml", codexConfigTemplate(options.maxCoders, options.maxReviewers), options.overwrite, ".codex/config.orchestration.patch.toml", messages);
  await writeManagedFile(projectPath, ".codex/rules/orchestration.rules", orchestrationRulesTemplate(), options.overwrite, ".codex/rules/orchestration.rules.patch", messages);

  for (const role of ["manager", "explorer", "coder", "reviewer", "repairer"] as const) {
    await writeManagedFile(projectPath, `.codex/agents/${role}.toml`, agentTomlTemplate(role), options.overwrite, `.codex/agents/${role}.orchestration.patch.toml`, messages);
  }

  await writeManagedFile(projectPath, ".agents/skills/orchestration-init/SKILL.md", orchestrationSkillTemplate(), options.overwrite, ".agents/skills/orchestration-init/SKILL.orchestration.patch.md", messages);
  await writeManagedFile(projectPath, ".orchestration/README.md", orchestrationReadmeTemplate(), options.overwrite, ".orchestration/README.orchestration.patch.md", messages);
  await writeManagedFile(projectPath, ".orchestration/worktrees/.gitignore", "*\n!.gitignore\n", options.overwrite, ".orchestration/worktrees/.gitignore.patch", messages);
  await writeManagedFile(projectPath, ".orchestration/knowledge/index.md", "# Knowledge Index\n\nNo durable project knowledge has been recorded yet.\n", options.overwrite, ".orchestration/knowledge/index.patch.md", messages);
  await writeManagedFile(projectPath, path.join(schemasDir("."), "review-result.schema.json"), reviewSchemaTemplate(), options.overwrite, ".orchestration/schemas/review-result.schema.patch.json", messages);
  await writeManagedFile(projectPath, path.join(schemasDir("."), "coder-result.schema.json"), coderResultSchemaTemplate(), options.overwrite, ".orchestration/schemas/coder-result.schema.patch.json", messages);
  await writeManagedFile(projectPath, path.join(schemasDir("."), "init-analysis.schema.json"), initAnalysisSchemaTemplate(), options.overwrite, ".orchestration/schemas/init-analysis.schema.patch.json", messages);
  await writeManagedFile(projectPath, path.join(schemasDir("."), "manager-plan.schema.json"), managerPlanSchemaTemplate(), options.overwrite, ".orchestration/schemas/manager-plan.schema.patch.json", messages);
  for (const kind of ["Plan", "WorkItem", "PatchCandidate", "AgentRun", "ReviewReport", "KnowledgeEntry", "ControllerLease"]) {
    await writeManagedFile(projectPath, path.join(schemasDir("."), `${kind}.schema.json`), stateKindSchemaTemplate(kind), options.overwrite, `.orchestration/schemas/${kind}.schema.patch.json`, messages);
  }
  await writeManagedFile(projectPath, ".orchestration/project/overview.md", "# Project Overview\n\nRun `codex-foreman init <project>` to populate this file.\n", options.overwrite, ".orchestration/project/overview.patch.md", messages);
  await writeManagedFile(projectPath, ".orchestration/project/validation-matrix.md", "# Validation Matrix\n\nRun `codex-foreman init <project>` to populate validation commands.\n", options.overwrite, ".orchestration/project/validation-matrix.patch.md", messages);
  await writeManagedFile(projectPath, ".orchestration/project/package-map.xml", "<PackageMap />\n", options.overwrite, ".orchestration/project/package-map.patch.xml", messages);
  await writeManagedFile(projectPath, ".orchestration/project/risk-register.md", "# Risk Register\n\nNo risks recorded yet.\n", options.overwrite, ".orchestration/project/risk-register.patch.md", messages);
  return messages;
}

async function ensureProject(projectPath: string, mode: InstallOptions["mode"]): Promise<void> {
  try {
    const stats = await stat(projectPath);
    if (!stats.isDirectory()) throw new ForemanError("InvalidProjectPath", `${projectPath} is not a directory.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && mode === "new") {
      await mkdir(projectPath, { recursive: true });
      return;
    }
    throw error;
  }
}

async function writeManagedFile(
  projectPath: string,
  relativePath: string,
  content: string,
  overwrite: InstallOptions["overwrite"],
  patchRelativePath: string,
  messages: string[]
): Promise<void> {
  const target = path.join(projectPath, relativePath);
  if (!(await pathExists(target)) || overwrite === "force") {
    await ensureDir(path.dirname(target));
    await writeTextAtomic(target, content);
    messages.push(`wrote ${relativePath}`);
    return;
  }
  if (overwrite === "safe") {
    const patchTarget = path.join(projectPath, patchRelativePath);
    await ensureDir(path.dirname(patchTarget));
    await writeTextAtomic(patchTarget, content);
    messages.push(`kept existing ${relativePath}; wrote ${patchRelativePath}`);
    return;
  }
  messages.push(`kept existing ${relativePath}`);
}
