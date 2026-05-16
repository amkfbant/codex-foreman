import path from "node:path";
import { eventsCommand } from "./events.js";
import { readConfig, readPatchCandidates, readWorkItems } from "../state/store.js";
import { writeTextAtomic } from "../utils/fs.js";

export async function dashboardCommand(projectPath: string, options: { output?: string } = {}): Promise<string> {
  const config = await readConfig(projectPath);
  const outputPath = path.resolve(projectPath, options.output ?? config.dashboard.defaultOutput);
  const items = await readWorkItems(projectPath);
  const candidateGroups = await Promise.all(items.map(async (item) => ({
    item,
    candidates: await readPatchCandidates(projectPath, item.metadata.uid)
  })));
  const recentEvents = await eventsCommand(projectPath, { limit: 20 });
  const html = renderDashboard(candidateGroups, recentEvents);
  await writeTextAtomic(outputPath, html);
  return `wrote ${path.relative(projectPath, outputPath).replaceAll(path.sep, "/")}`;
}

function renderDashboard(groups: Awaited<ReturnType<typeof readDashboardData>>, recentEvents: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Foreman Dashboard</title>
  <style>
    body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f7f8fa; }
    header { padding: 20px 28px; background: #102033; color: white; }
    main { padding: 24px 28px; max-width: 1160px; margin: 0 auto; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d9dee7; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e6e9ef; text-align: left; vertical-align: top; }
    th { background: #eef2f7; font-weight: 650; }
    .phase { font-weight: 700; }
    .score { font-variant-numeric: tabular-nums; }
    pre { white-space: pre-wrap; background: #111827; color: #f9fafb; padding: 14px; overflow: auto; }
  </style>
</head>
<body>
  <header><h1>Codex Foreman Dashboard</h1></header>
  <main>
    <h2>WorkItems</h2>
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Phase</th><th>Selected</th><th>Candidates</th><th>Message</th></tr></thead>
      <tbody>
        ${groups.map(({ item, candidates }) => `<tr>
          <td>${escapeHtml(item.metadata.uid)}</td>
          <td>${escapeHtml(item.metadata.name)}</td>
          <td class="phase">${escapeHtml(item.status.phase)}</td>
          <td>${escapeHtml(item.status.selectedCandidateId ?? item.status.candidateId ?? "")}</td>
          <td>${candidates.map((candidate) => `${escapeHtml(candidate.metadata.uid)} <span class="score">${candidate.status.score?.value ?? "n/a"}</span> ${escapeHtml(candidate.status.reviewResult)}`).join("<br>")}</td>
          <td>${escapeHtml(item.status.message ?? "")}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <h2>Recent Events</h2>
    <pre>${escapeHtml(recentEvents.trim())}</pre>
  </main>
</body>
</html>
`;
}

async function readDashboardData(projectPath: string) {
  const items = await readWorkItems(projectPath);
  return Promise.all(items.map(async (item) => ({ item, candidates: await readPatchCandidates(projectPath, item.metadata.uid) })));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

