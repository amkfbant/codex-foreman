# codex-foreman

`codex-foreman` is a TypeScript CLI for running a local Codex orchestration controller. It installs project scaffolding, stores desired/current state under `.orchestration`, isolates implementation workers in git worktrees, and coordinates validation, review, repair, and guarded merge flow.

The CLI also exposes the `codex-orchestrator` binary alias used by the implementation plan.

## Capabilities

- Installs `AGENTS.md`, `.codex/`, `.agents/skills/`, generated schemas, conservative rules, and `.orchestration/`.
- Stores controller state as XML plus JSON sidecars and stops on sidecar divergence.
- Decomposes Markdown specs into one or more WorkItems.
- Runs multiple candidate worktrees per WorkItem and scores candidates by validation, review, diff size, protected paths, dependency file changes, and repair count.
- Supports fake and real `codex exec` adapters.
- Records AgentRun, PatchCandidate, ReviewReport, and KnowledgeEntry state.
- Provides CLI status/events output and a static HTML dashboard.
- Keeps auto-merge disabled by default and guards it with review, validation, risk, protected path, and dependency checks.

## Development

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Real Codex smoke tests are skipped by default. Enable them explicitly:

```bash
CODEX_FOREMAN_REAL_CODEX=1 corepack pnpm test tests/real-codex-smoke.test.ts
```

## Commands

```bash
codex-foreman install <project-path>
codex-foreman init <project-path> [--codex fake|real|none]
codex-foreman plan <project-path> <spec.md> [--codex fake|real|none]
codex-foreman reconcile <project-path> --once [--codex fake|real]
codex-foreman run <project-path> --until complete [--codex fake|real]
codex-foreman status <project-path> [--json]
codex-foreman events <project-path> [--workitem <id>] [--limit <n>] [--json]
codex-foreman dashboard <project-path> [--output <path>]
codex-foreman retry <project-path> --workitem <id>
codex-foreman gc <project-path>
```

## State Layout

- `.orchestration/config.xml` / `.orchestration/config.json`: controller policy
- `.orchestration/desired/plan.xml` / `.orchestration/desired/plan.json`: active desired plan
- `.orchestration/workitems/*.xml` / `*.json`: WorkItem state
- `.orchestration/candidates/<workitem>/<candidate>/`: candidate patch, validation, review, and score artifacts
- `.orchestration/runs/<workitem>/`: Codex JSONL plus AgentRun XML/JSON
- `.orchestration/knowledge/`: lessons and failure patterns
- `.orchestration/dashboard/index.html`: static dashboard output
