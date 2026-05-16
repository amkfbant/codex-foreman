import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { installCommand } from "../src/commands/install.js";
import { pathExists, readText } from "../src/utils/fs.js";
import { tempRepo } from "./helpers.js";

describe("install command", () => {
  it("creates orchestration scaffolding", async () => {
    const repo = await tempRepo();
    const messages = await installCommand(repo, {
      mode: "existing",
      overwrite: "safe",
      maxCoders: 3,
      maxReviewers: 2
    });

    expect(messages.some((message) => message.includes(".orchestration/config.xml"))).toBe(true);
    await expect(pathExists(path.join(repo, "AGENTS.md"))).resolves.toBe(true);
    await expect(pathExists(path.join(repo, ".codex/agents/coder.toml"))).resolves.toBe(true);
    await expect(pathExists(path.join(repo, ".codex/rules/orchestration.rules"))).resolves.toBe(true);
    await expect(pathExists(path.join(repo, ".agents/skills/orchestration-init/SKILL.md"))).resolves.toBe(true);
    await expect(pathExists(path.join(repo, ".orchestration/schemas/PatchCandidate.schema.json"))).resolves.toBe(true);
    await expect(pathExists(path.join(repo, ".orchestration/schemas/coder-result.schema.json"))).resolves.toBe(true);
    await expect(pathExists(path.join(repo, ".orchestration/project/validation-catalog.json"))).resolves.toBe(true);
  });

  it("uses patch files instead of overwriting existing managed files in safe mode", async () => {
    const repo = await tempRepo();
    await writeFile(path.join(repo, "AGENTS.md"), "# Existing\n", "utf8");

    await installCommand(repo, {
      mode: "existing",
      overwrite: "safe",
      maxCoders: 3,
      maxReviewers: 2
    });

    await expect(readText(path.join(repo, "AGENTS.md"))).resolves.toBe("# Existing\n");
    await expect(pathExists(path.join(repo, "AGENTS.orchestration.patch.md"))).resolves.toBe(true);
  });
});
