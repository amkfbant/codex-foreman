import type { ReviewReport, WorkItem } from "./domain.js";

export function renderCoderPrompt(item: WorkItem): string {
  return [
    "You are the coder worker for Codex Foreman.",
    "",
    "Implement exactly one WorkItem. Keep the diff minimal and scoped.",
    "Do not edit .codex, .agents, or .orchestration except candidate reports explicitly requested by the controller.",
    "",
    "WorkItem:",
    "```json",
    JSON.stringify(item, null, 2),
    "```",
    "",
    "After changes, report summary, changed files, validation attempted, and risks."
  ].join("\n");
}

export function renderReviewerPrompt(item: WorkItem, diffStat: string, diff: string, validationLog: string): string {
  const renderedDiff = truncate(diff, 12_000);
  return [
    "You are the reviewer worker for Codex Foreman.",
    "Review this candidate patch against the WorkItem. Do not edit files.",
    "",
    "Focus on correctness, security, missing tests, behavior regressions, spec adherence, and unnecessary scope expansion.",
    "",
    "Return JSON with result, summary, findings, and next_prompt_hints.",
    "",
    "WorkItem:",
    "```json",
    JSON.stringify(item, null, 2),
    "```",
    "",
    "Diff stat:",
    "```text",
    diffStat || "(no diff)",
    "```",
    "",
    "Diff:",
    "```diff",
    renderedDiff || "(no diff)",
    "```",
    "",
    "Validation log:",
    "```text",
    validationLog || "(no validation log)",
    "```"
  ].join("\n");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[diff truncated after ${maxChars} characters; inspect changes.patch for the full patch]`;
}

export function renderRepairPrompt(item: WorkItem, review: ReviewReport | undefined, validationLog: string): string {
  return [
    "You are the repair worker for Codex Foreman.",
    "",
    "Fix only the listed review findings or validation failures. Do not broaden scope.",
    "",
    "WorkItem:",
    "```json",
    JSON.stringify(item, null, 2),
    "```",
    "",
    "Review findings:",
    "```json",
    JSON.stringify(review?.findings ?? [], null, 2),
    "```",
    "",
    "Validation log:",
    "```text",
    validationLog || "(no validation log)",
    "```",
    "",
    "After changes, summarize exact fixes and rerun relevant validation if possible."
  ].join("\n");
}
