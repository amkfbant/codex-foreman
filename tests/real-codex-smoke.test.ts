import path from "node:path";
import { describe, expect, it } from "vitest";
import { RealCodexExec } from "../src/codex.js";
import { installCommand } from "../src/commands/install.js";
import { initCommand } from "../src/commands/init.js";
import { pathExists } from "../src/utils/fs.js";
import { tempRepo } from "./helpers.js";

const runRealCodex = process.env.CODEX_FOREMAN_REAL_CODEX === "1";

describe.skipIf(!runRealCodex)("real Codex smoke", () => {
  it("captures a read-only init analysis run", async () => {
    const repo = await tempRepo("codex-foreman-real-");
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 1, maxReviewers: 1 });
    await initCommand(repo, { codex: new RealCodexExec() });

    await expect(pathExists(path.join(repo, ".orchestration/project/init-analysis.json"))).resolves.toBe(true);
  }, 120_000);
});
