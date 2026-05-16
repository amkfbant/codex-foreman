#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { FakeCodexExec, RealCodexExec } from "./codex.js";
import { gcCommand } from "./commands/gc.js";
import { initCommand } from "./commands/init.js";
import { installCommand } from "./commands/install.js";
import { planCommand } from "./commands/plan.js";
import { retryCommand } from "./commands/retry.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { reconcileOnce } from "./controller.js";
import { resolveProject } from "./paths.js";
import { ForemanError, errorMessage } from "./utils/errors.js";

const program = new Command();

program
  .name("codex-foreman")
  .description("Local controller for orchestrating Codex workers.")
  .version("0.1.0");

program
  .command("install")
  .argument("<project-path>")
  .option("--mode <mode>", "auto|new|existing", "auto")
  .option("--overwrite <policy>", "none|safe|force", "safe")
  .option("--max-coders <n>", "maximum coder workers", parseNumber, 3)
  .option("--max-reviewers <n>", "maximum reviewer workers", parseNumber, 2)
  .action(wrap(async (projectPath, options) => {
    const messages = await installCommand(resolveProject(projectPath), options);
    printLines(messages);
  }));

program
  .command("init")
  .argument("<project-path>")
  .option("--codex <mode>", "fake|real|none", "none")
  .action(wrap(async (projectPath, options) => {
    printLines(await initCommand(resolveProject(projectPath), { codex: options.codex === "none" ? undefined : codexFor(options.codex) }));
  }));

program
  .command("plan")
  .argument("<project-path>")
  .argument("<spec-md>")
  .option("--codex <mode>", "fake|real|none", "none")
  .action(wrap(async (projectPath, specPath, options) => {
    printLines(await planCommand(resolveProject(projectPath), specPath, { codex: options.codex === "none" ? undefined : codexFor(options.codex) }));
  }));

program
  .command("reconcile")
  .argument("<project-path>")
  .option("--once", "run a single reconcile step", true)
  .option("--codex <mode>", "fake|real", process.env.CODEX_FOREMAN_CODEX ?? "fake")
  .action(wrap(async (projectPath, options) => {
    const result = await reconcileOnce(resolveProject(projectPath), { codex: codexFor(options.codex) });
    console.log(`${result.action}: ${result.message}`);
  }));

program
  .command("run")
  .argument("<project-path>")
  .option("--until <state>", "target state", "complete")
  .option("--max-steps <n>", "maximum reconcile steps", parseNumber, 50)
  .option("--codex <mode>", "fake|real", process.env.CODEX_FOREMAN_CODEX ?? "fake")
  .action(wrap(async (projectPath, options) => {
    printLines(await runCommand(resolveProject(projectPath), {
      codex: codexFor(options.codex),
      maxSteps: options.maxSteps,
      until: options.until
    }));
  }));

program
  .command("status")
  .argument("<project-path>")
  .option("--json", "print machine-readable status", false)
  .action(wrap(async (projectPath, options) => {
    process.stdout.write(await statusCommand(resolveProject(projectPath), { json: options.json }));
  }));

program
  .command("events")
  .argument("<project-path>")
  .option("--workitem <id>", "filter by WorkItem id")
  .option("--limit <n>", "maximum events", parseNumber, 20)
  .option("--json", "print JSON lines", false)
  .action(wrap(async (projectPath, options) => {
    const { eventsCommand } = await import("./commands/events.js");
    process.stdout.write(await eventsCommand(resolveProject(projectPath), options));
  }));

program
  .command("dashboard")
  .argument("<project-path>")
  .option("--output <path>", "output HTML path")
  .action(wrap(async (projectPath, options) => {
    const { dashboardCommand } = await import("./commands/dashboard.js");
    console.log(await dashboardCommand(resolveProject(projectPath), { output: options.output }));
  }));

program
  .command("retry")
  .argument("<project-path>")
  .requiredOption("--workitem <id>", "WorkItem id")
  .action(wrap(async (projectPath, options) => {
    console.log(await retryCommand(resolveProject(projectPath), options.workitem));
  }));

program
  .command("gc")
  .argument("<project-path>")
  .action(wrap(async (projectPath) => {
    printLines(await gcCommand(resolveProject(projectPath)));
  }));

program.parse();

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

function codexFor(mode: string) {
  if (mode === "real") return new RealCodexExec();
  if (mode === "fake") return new FakeCodexExec();
  throw new ForemanError("InvalidCodexMode", `Unknown Codex mode: ${mode}`);
}

function printLines(lines: string[]): void {
  for (const line of lines) console.log(line);
}

function wrap<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
  return (...args: T) => {
    fn(...args).catch((error) => {
      if (error instanceof ForemanError) {
        console.error(pc.red(`${error.code}: ${error.message}`));
      } else {
        console.error(pc.red(errorMessage(error)));
      }
      process.exitCode = 1;
    });
  };
}
