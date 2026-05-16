import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/domain.js";
import { apiVersion } from "../src/domain.js";
import type { CodexExec, CodexRunRequest } from "../src/codex.js";
import { installCommand } from "../src/commands/install.js";
import { planCommand } from "../src/commands/plan.js";
import { readPlan, readWorkItems } from "../src/state/store.js";
import { writeTextAtomic } from "../src/utils/fs.js";
import { tempRepo } from "./helpers.js";

describe("plan command", () => {
  it("creates multiple WorkItems from a WorkItems section", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 3, maxReviewers: 2 });
    await writeTextAtomic(path.join(repo, "feature.md"), [
      "# Feature",
      "",
      "## Goal",
      "Ship a local orchestration feature.",
      "",
      "## WorkItems",
      "- Add API: implement core behavior",
      "- Add UI: implement status output",
      "",
      "## Acceptance Criteria",
      "- Relevant tests pass"
    ].join("\n"));

    await planCommand(repo, "feature.md");
    const plan = await readPlan(repo);
    const items = await readWorkItems(repo);

    expect(plan.spec.workItemRefs).toHaveLength(2);
    expect(items.map((item) => item.metadata.name)).toEqual(["add-api", "add-ui"]);
    expect(items[0]?.spec.acceptanceCriteria[0]?.text).toBe("Relevant tests pass");
  });

  it("abandons superseded WorkItems when a new plan is written", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 3, maxReviewers: 2 });
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nShip a feature.\n");

    await planCommand(repo, "feature.md");
    const [oldItem] = await readWorkItems(repo);
    if (!oldItem) throw new Error("expected first WorkItem");
    await planCommand(repo, "feature.md");

    const plan = await readPlan(repo);
    const items = await readWorkItems(repo);
    const abandoned = items.find((item) => item.metadata.uid === oldItem.metadata.uid);
    const active = items.filter((item) => plan.spec.workItemRefs.includes(item.metadata.uid));

    expect(abandoned?.status.phase).toBe("Abandoned");
    expect(active).toHaveLength(1);
    expect(active[0]?.status.phase).toBe("Pending");
  });

  it("resolves manager dependency names to WorkItem UIDs", async () => {
    const repo = await tempRepo();
    await installCommand(repo, { mode: "existing", overwrite: "safe", maxCoders: 3, maxReviewers: 2 });
    await writeTextAtomic(path.join(repo, "feature.md"), "# Feature\n\n## Goal\nShip ordered work.\n");

    await planCommand(repo, "feature.md", {
      codex: new ManagerPlanCodexExec({
        workitems: [
          { name: "First", goal: "Do first.", dependencies: [], risk: "medium" },
          { name: "Second", goal: "Do second.", dependencies: ["First"], risk: "medium" }
        ]
      })
    });

    const items = await readWorkItems(repo);
    const first = items.find((item) => item.metadata.name === "first");
    const second = items.find((item) => item.metadata.name === "second");
    expect(first).toBeTruthy();
    expect(second?.spec.dependencies).toEqual([first?.metadata.uid]);
  });
});

class ManagerPlanCodexExec implements CodexExec {
  constructor(private readonly output: unknown) {}

  async run(request: CodexRunRequest): Promise<AgentRun> {
    if (!request.outputPath) throw new Error("expected output path");
    await writeTextAtomic(request.outputPath, `${JSON.stringify(this.output, null, 2)}\n`);
    const now = new Date().toISOString();
    return {
      apiVersion,
      kind: "AgentRun",
      metadata: {
        uid: `RUN-${Date.now()}`,
        workItemRef: request.workItemId,
        createdAt: now
      },
      spec: {
        role: request.role,
        cwd: request.cwd,
        sandbox: request.sandbox,
        outputPath: request.outputPath,
        outputSchemaPath: request.outputSchemaPath
      },
      status: {
        phase: "succeeded",
        startedAt: now,
        completedAt: now,
        jsonlPath: path.join(request.projectPath, ".orchestration/runs/test.jsonl"),
        exitCode: 0
      }
    };
  }
}
