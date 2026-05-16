import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiVersion, type WorkItem } from "../src/domain.js";
import { readWorkItem, writeWorkItem } from "../src/state/store.js";
import { ensureDir, readText, writeTextAtomic } from "../src/utils/fs.js";
import { tempRepo } from "./helpers.js";

describe("state persistence", () => {
  it("round-trips WorkItems through XML and JSON sidecars", async () => {
    const repo = await tempRepo();
    await ensureDir(path.join(repo, ".orchestration/workitems"));
    const item = sampleWorkItem();
    await writeWorkItem(repo, item);

    await expect(readWorkItem(repo, item.metadata.uid)).resolves.toEqual(item);
  });

  it("fails fast when XML and JSON sidecars diverge", async () => {
    const repo = await tempRepo();
    await ensureDir(path.join(repo, ".orchestration/workitems"));
    const item = sampleWorkItem();
    await writeWorkItem(repo, item);
    const jsonPath = path.join(repo, ".orchestration/workitems/WI-20260516-001.json");
    const sidecar = JSON.parse(await readText(jsonPath)) as WorkItem;
    sidecar.status.phase = "Blocked";
    await writeTextAtomic(jsonPath, `${JSON.stringify(sidecar, null, 2)}\n`);

    await expect(readWorkItem(repo, item.metadata.uid)).rejects.toMatchObject({
      code: "StateFormatMismatch"
    });
  });

  it("rejects stale resourceVersion writes", async () => {
    const repo = await tempRepo();
    await ensureDir(path.join(repo, ".orchestration/workitems"));
    const item = sampleWorkItem();
    await writeWorkItem(repo, item);
    const stale = {
      ...item,
      metadata: {
        ...item.metadata,
        resourceVersion: "0"
      }
    };

    await expect(writeWorkItem(repo, stale)).rejects.toMatchObject({
      code: "ResourceVersionConflict"
    });
  });
});

function sampleWorkItem(): WorkItem {
  return {
    apiVersion,
    kind: "WorkItem",
    metadata: {
      uid: "WI-20260516-001",
      name: "sample",
      createdAt: "2026-05-16T00:00:00.000Z",
      generation: 1,
      labels: { area: "test" },
      ownerReferences: [{ kind: "Plan", uid: "PLAN-20260516-001" }]
    },
    spec: {
      goal: "Do a small thing.",
      contextPaths: ["README.md"],
      constraints: ["Keep it small."],
      acceptanceCriteria: [{ id: "AC-1", text: "It works." }],
      validationCommands: [],
      dependencies: [],
      risk: "medium",
      allowedPaths: [],
      protectedPaths: []
    },
    status: {
      phase: "Pending",
      observedGeneration: 0,
      attempts: 0,
      repairAttempts: 0,
      candidateIds: [],
      conditions: []
    }
  };
}
