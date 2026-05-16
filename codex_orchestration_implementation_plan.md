# Codex Orchestration 導入・実装計画書

作成日: 2026-05-16  
対象: 新規または途中から導入するモノレポ / 複数サービス構成リポジトリ  
目的: `codex-orchestrator install <project>` のようなCLIから、対象プロジェクトへ `AGENTS.md`、`.codex/`、`.agents/skills/`、`.orchestration/` を導入し、メインCodex、コーダーCodex、レビュワーCodexを協調させる仕組みを作る。

---

## 1. 結論

この計画で作るものは、単なる「複数のCodexを同時に起動するスクリプト」ではなく、**Codexをワーカーとして使う軽量な開発コントローラー**である。

最小構成は次の3層に分ける。

1. **Installer / Bootstrapper**  
   対象プロジェクトを受け取り、`AGENTS.md`、`.codex/config.toml`、`.codex/agents/*.toml`、`.agents/skills/orchestration-init/SKILL.md`、`.orchestration/` を生成する。

2. **Orchestration Controller**  
   Kubernetes controllerのreconcile loopのように、`.orchestration/desired/plan.xml` と `.orchestration/workitems/*.xml` に書かれた「あるべき状態」を読み、現在のgit/worktree/Codex実行結果/レビュー結果との差分を埋める。

3. **Codex Workers**  
   `codex exec` を使って、探索、実装、レビュー、修復、要約、知見更新を担当する。実装ワーカーは原則としてGit worktreeで隔離し、レビュワーはread-onlyで動かす。

MVPではTypeScript CLIまたはPython CLIのどちらでもよいが、Codex CLIがnpmで導入されることが多いこと、`npx` 配布がしやすいことから、**TypeScript CLI + Node.js child_processで`codex exec`を呼ぶ構成**を第一候補にする。Python版を作る場合は標準ライブラリ中心で十分実装できる。

---

## 2. 調査結果の要点

### 2.1 Codex公式機能から取り込むべきこと

- Codexは作業開始前に `AGENTS.md` を読む。グローバル、プロジェクト、サブディレクトリの順で命令が積み上がり、近いディレクトリの指示ほど後に入るため強くなる。`project_doc_max_bytes` は既定で32KiBなので、`AGENTS.md` は短くし、詳細は `.orchestration/knowledge/` や `docs/` に逃がす。[S1]
- `codex exec` は非対話モードで、CIやスクリプトから実行できる。標準出力に最終回答、標準エラーに進捗を出せるため、オーケストレーターから呼びやすい。[S2]
- `codex exec --json` はJSON Linesイベントを出す。イベントにはスレッド、ターン、コマンド実行、ファイル変更、MCP、plan updateなどが含まれるため、`.orchestration/runs/*.jsonl` に保存すれば監査ログと状態更新に使える。[S3]
- `codex exec` は `--cd`、`--sandbox`、`--ask-for-approval`、`--output-last-message`、`--output-schema` などを持つ。実装ワーカーは `workspace-write`、レビューワーカーは `read-only`、非対話実行では `--ask-for-approval never` を基本にする。ただし外部ネットワークや危険な操作は別途制御する。[S4]
- Skillsは `SKILL.md` と任意の `scripts/`、`references/`、`assets/` を持つディレクトリとして定義される。Codexはskillの名前・説明・パスだけを初期コンテキストに入れ、必要なときに本文を読む。repoスコープのskillは `.agents/skills` に置ける。[S5]
- Codexにはsubagentsがあり、明示的に依頼すると専門エージェントを並列に生成し、結果を集約できる。custom agentは `.codex/agents/*.toml` に置き、`name`、`description`、`developer_instructions` を定義する。[S6]
- Codex subagentsには `agents.max_threads`、`agents.max_depth` などの設定がある。既定の `max_depth = 1` は再帰的な無制限fan-outを防ぐため妥当である。[S6]
- Codex appのworktreesは、同じGitリポジトリの複数checkoutを使って並列作業を可能にする。各worktreeはファイルコピーを持つがGitメタデータを共有し、複数ブランチを並行して扱える。[S7]
- Sandboxとapprovalは別レイヤーで、sandboxは技術的境界、approval policyは境界を越えるときに止めるルールである。通常は `workspace-write + on-request` が対話向け、非対話では `never` と明示的sandbox境界を組み合わせる。[S8]

### 2.2 実例・周辺事例から取り込むべきこと

- GitHub Agent HQは、Copilot、Claude、Codex、custom agentなど複数エージェントをGitHub/VS Code内で選び、非同期に実行し、ログや成果物をレビューできる方向に進んでいる。これは「複数エージェントを同じ作業コンテキストに紐付け、比較・レビュー可能にする」設計の実例である。[S9]
- GitHubはAgent HQを「複数の専門エージェントを並列で割り当て、進捗を追跡するmission control」と説明している。今回作るものも、`.orchestration` をローカル版mission controlとして扱う。[S10]
- `ccswarm` はClaude Codeを対象にしたOSSのmulti-agent orchestrationで、task delegation、template scaffolding、Git worktree isolationを組み合わせている。Codex版でもこの3点は核になる。[S11]
- Agent Interviewsのparallel AI coding事例では、Git worktreeを複数作り、同じ仕様を複数エージェントに実装させ、`RESULTS.md` を出させ、比較して最良案をmergeする。これはMVPの実装・比較フローに近い。[S12]
- Git公式ドキュメントでも、`git worktree` は1つのリポジトリで複数のworking treeを管理し、複数ブランチを同時にcheckoutするための仕組みと説明されている。エージェント隔離の基礎として妥当である。[S13]
- Addy Osmani氏の「Code Agent Orchestra」は、単一エージェントの限界としてcontext overload、specialization不足、coordination不足を挙げ、複数エージェントと明確なspec、分解、検証が重要と述べている。これは今回の設計思想と一致する。[S14]
- Google Julesのプラン説明でも、同時タスク数や並列スレッド数が明示されており、AI coding agentは「一つの長い会話」から「複数タスクの並列運用」へ移っている。[S15]

### 2.3 Kubernetes controller風にする理由

Kubernetes controllerはdesired stateとcurrent stateを比較し、current stateをdesired stateに近づける変更を行い、その結果をstatusとして報告する。この制御ループを、エージェント開発に移植する。[S16]

この計画では、たとえば次のように対応させる。

| Kubernetes | Codex Orchestration |
|---|---|
| Custom Resource | `.orchestration/workitems/*.xml` |
| spec | やりたいこと、制約、受け入れ条件、依存関係 |
| status | 現在phase、試行回数、最後のCodex run、レビュー結果 |
| controller | `codex-orchestrator reconcile` |
| pod/job | coder/reviewerの `codex exec` run |
| events | `.orchestration/events/*.jsonl` |
| finalizer | worktree cleanup、未merge patch保存 |
| ownerReference | plan -> workitem -> agentrun -> patchcandidate |

重要なのは、**planを一度作ったら最後まで走り切る**ことではなく、**途中で失敗・レビュー指摘・テスト失敗が出ても、その差分をstatusに残し、次のreconcileで修復する**ことである。

---

## 3. 作るシステムの全体像

### 3.1 推奨CLI

```bash
# 初期導入
codex-orchestrator install /path/to/monorepo \
  --mode existing \
  --profile default \
  --max-coders 3 \
  --max-reviewers 2

# プロジェクト理解と初期状態生成
codex-orchestrator init /path/to/monorepo

# plan投入
codex-orchestrator plan /path/to/monorepo specs/feature.md

# controller起動。1回だけreconcileする場合
codex-orchestrator reconcile /path/to/monorepo --once

# planから最後まで自律実行する場合
codex-orchestrator run /path/to/monorepo --until complete

# 状態確認
codex-orchestrator status /path/to/monorepo

# 失敗したrunの再試行
codex-orchestrator retry /path/to/monorepo --workitem WI-20260516-001

# worktreeと古いログの掃除
codex-orchestrator gc /path/to/monorepo
```

### 3.2 役割

#### Main Codex / Manager

目的は「作業する」ことではなく、**計画・分解・割り当て・統合判断**である。

- repo概要を理解する。
- planをworkitem DAGに分解する。
- coder/reviewerに渡すpromptを作る。
- Codex workerの結果を読み、次のreconcile方針を決める。
- merge前にレビュー・テスト・diffの整合性を確認する。
- 知見を `.orchestration/knowledge/` に更新する。

#### Explorer Codex

- read-onlyで動く。
- 既存プロジェクト導入時の構造理解、依存関係調査、危険箇所、テストコマンド候補の抽出を行う。
- 生成物は `project-overview.md`、`package-map.xml`、`validation-matrix.md`。

#### Coder Codex

- 原則として専用worktreeで動く。
- `workspace-write` sandboxで最小差分を実装する。
- 作業後に `RESULTS.md`、`changes.patch`、`validation.md` を出す。
- 自分でレビュー判断をしない。自己申告は参考扱い。

#### Reviewer Codex

- read-onlyで動く。
- correctness、security、テスト不足、保守性、仕様逸脱、diffの最小性を確認する。
- レビュー結果はXMLまたはJSONで構造化し、`approve`、`request_changes`、`reject` のいずれかを返す。

#### Repair Codex

- reviewer指摘やテスト失敗を入力に、同じworktreeで修復する。
- 修復回数はworkitemごとに上限を持つ。

---

## 4. 導入時に生成するディレクトリ構成

```text
<repo>/
├── AGENTS.md
├── .codex/
│   ├── config.toml
│   ├── agents/
│   │   ├── manager.toml
│   │   ├── explorer.toml
│   │   ├── coder.toml
│   │   ├── reviewer.toml
│   │   └── repairer.toml
│   └── rules/
│       └── orchestration.rules
├── .agents/
│   └── skills/
│       └── orchestration-init/
│           ├── SKILL.md
│           ├── references/
│           │   ├── project-analysis-checklist.md
│           │   └── monorepo-signals.md
│           └── scripts/
│               └── summarize_project.sh
└── .orchestration/
    ├── README.md
    ├── config.xml
    ├── desired/
    │   └── plan.xml
    ├── project/
    │   ├── overview.md
    │   ├── package-map.xml
    │   ├── validation-matrix.md
    │   └── risk-register.md
    ├── workitems/
    │   └── WI-YYYYMMDD-001.xml
    ├── runs/
    │   └── <workitem-id>/
    │       └── <run-id>.jsonl
    ├── candidates/
    │   └── <workitem-id>/
    │       └── <candidate-id>/
    │           ├── RESULTS.md
    │           ├── changes.patch
    │           ├── validation.md
    │           └── review.xml
    ├── knowledge/
    │   ├── index.md
    │   ├── decisions/
    │   ├── lessons/
    │   ├── patterns/
    │   └── failures/
    ├── events/
    │   └── events.jsonl
    ├── locks/
    ├── schemas/
    │   ├── workitem.xsd
    │   ├── review-result.schema.json
    │   └── coder-result.schema.json
    └── worktrees/
        └── .gitignore
```

### 4.1 `.codex` と `.orchestration` の分離

`.codex/` はCodexの設定、custom agent、rulesのための場所に限定する。実行状態や履歴は置かない。

`.orchestration/` はcontrollerのAPI server相当であり、複数managerが共有する状態、ログ、知見、workitem、成果物を置く。

この分離により、`.codex` は短く安定、`.orchestration` は長期的に増える履歴・知見・監査情報として扱える。

---

## 5. XMLとMarkdownの使い分け

### 5.1 Markdownが向いているもの

- 人間が読む概要
- AGENTS.md
- 実装計画
- 知見、失敗パターン、レビューの補足説明
- ADR、decision log
- `RESULTS.md` のような作業報告

### 5.2 XMLが向いているもの

- 状態機械を持つworkitem
- 依存関係を持つplan DAG
- agent runの入出力メタデータ
- reviewer判定の構造化結果
- package map、module map、validation matrix
- 複数managerが読む共有状態

XMLを使う理由は、LLMにとっても人間にとってもタグ境界が明確で、階層構造、属性、ステータス、参照関係を曖昧にしにくいためである。とくに「workitemのspec/status」「observedGeneration」「ownerReferences」のようなcontroller風データはXMLに向く。

### 5.3 `WorkItem` XML例

```xml
<?xml version="1.0" encoding="UTF-8"?>
<WorkItem apiVersion="orchestration.codex/v1" kind="WorkItem">
  <metadata>
    <uid>WI-20260516-001</uid>
    <name>add-user-settings-api</name>
    <createdAt>2026-05-16T00:00:00+09:00</createdAt>
    <generation>3</generation>
    <ownerReferences>
      <owner kind="Plan" uid="PLAN-20260516-001" />
    </ownerReferences>
    <labels>
      <label key="area" value="backend" />
      <label key="risk" value="medium" />
    </labels>
  </metadata>

  <spec>
    <goal>Add API endpoint for user settings update.</goal>
    <context>
      <path>services/api</path>
      <path>packages/shared</path>
      <doc>.orchestration/project/overview.md</doc>
    </context>
    <constraints>
      <constraint>Do not change public response shape except adding documented optional fields.</constraint>
      <constraint>Follow existing auth middleware patterns.</constraint>
    </constraints>
    <acceptanceCriteria>
      <criterion id="AC-1">Existing API tests pass.</criterion>
      <criterion id="AC-2">New regression test covers unauthorized update.</criterion>
      <criterion id="AC-3">No migration unless required by existing schema.</criterion>
    </acceptanceCriteria>
    <validation>
      <command>pnpm --filter @repo/api test</command>
      <command>pnpm lint</command>
    </validation>
    <dependencies />
  </spec>

  <status>
    <phase>Reviewing</phase>
    <observedGeneration>3</observedGeneration>
    <attempts>2</attempts>
    <lastRunId>RUN-20260516-014</lastRunId>
    <activeWorktree>.orchestration/worktrees/WI-20260516-001-coder-a</activeWorktree>
    <conditions>
      <condition type="Implemented" status="True" at="2026-05-16T02:20:00+09:00" />
      <condition type="TestsPassed" status="True" at="2026-05-16T02:28:00+09:00" />
      <condition type="ReviewApproved" status="Unknown" at="2026-05-16T02:29:00+09:00" />
    </conditions>
  </status>
</WorkItem>
```

### 5.4 `ReviewReport` XML例

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ReviewReport apiVersion="orchestration.codex/v1" kind="ReviewReport">
  <metadata>
    <uid>RR-20260516-001</uid>
    <workItemRef>WI-20260516-001</workItemRef>
    <candidateRef>CAND-20260516-001-A</candidateRef>
    <reviewer>codex-reviewer</reviewer>
    <createdAt>2026-05-16T02:45:00+09:00</createdAt>
  </metadata>
  <result>request_changes</result>
  <summary>Implementation is mostly correct, but authorization test misses tenant isolation.</summary>
  <findings>
    <finding severity="high" category="correctness">
      <title>Tenant boundary is not enforced in settings update test.</title>
      <evidence path="services/api/src/settings.ts" lines="52-76" />
      <requiredChange>Add tenant mismatch test and ensure middleware rejects it.</requiredChange>
    </finding>
  </findings>
  <nextPromptHints>
    <hint>Focus only on tenant isolation. Do not refactor unrelated middleware.</hint>
  </nextPromptHints>
</ReviewReport>
```

---

## 6. Installer / Bootstrapper実装計画

### 6.1 CLI仕様

```bash
codex-orchestrator install <project-path> \
  [--mode new|existing|auto] \
  [--overwrite none|safe|force] \
  [--max-coders 1..8] \
  [--max-reviewers 1..4] \
  [--codex-home <path>] \
  [--no-run-init]
```

既定値:

```text
mode: auto
overwrite: safe
max-coders: 3
max-reviewers: 2
codex-home: user defaultを使う。必要時だけ専用automation homeを指定。
run-init: true
```

### 6.2 Preflight

Installerは次を確認する。

1. `<project-path>` が存在する。
2. Gitリポジトリである。なければ `--mode new` の場合のみ `git init` を提案または実行対象にする。
3. `codex` CLIがPATHにある。
4. 既存の `AGENTS.md`、`.codex/`、`.agents/`、`.orchestration/` の有無を確認する。
5. `.gitignore` を確認し、`.orchestration/worktrees/`、一時ログ、巨大キャッシュをignoreする提案を出す。
6. package manager、monorepo tool、test command候補を静的に推測する。

検出対象例:

```text
pnpm-workspace.yaml, package.json, turbo.json, nx.json, lerna.json,
Cargo.toml, go.work, pyproject.toml, poetry.lock, uv.lock,
Makefile, justfile, Taskfile.yml, docker-compose.yml,
apps/, packages/, services/, libs/, crates/, internal/
```

### 6.3 Safe overwrite

`overwrite=safe` では既存ファイルを破壊しない。

- 既存 `AGENTS.md` がある場合、追記候補を `AGENTS.orchestration.patch.md` として生成する。
- 既存 `.codex/config.toml` がある場合、差分patchを生成し、強制上書きしない。
- 既存 `.orchestration/` がある場合、`config.xml` のversionを確認し、migrationを実行する。

### 6.4 導入直後のinit skill実行

途中導入では、プロジェクト理解が最重要になる。Installer後に `orchestration-init` skillを使って、まずread-only探索を実行する。

推奨コマンド:

```bash
codex exec \
  --cd "$PROJECT" \
  --sandbox read-only \
  --ask-for-approval never \
  --json \
  --output-schema "$PROJECT/.orchestration/schemas/init-analysis.schema.json" \
  --output-last-message "$PROJECT/.orchestration/project/init-analysis.json" \
  "Use the orchestration-init skill. Analyze this repository for Codex orchestration onboarding. Do not modify files. Return JSON matching the schema."
```

その後、wrapperが `init-analysis.json` をもとに次を生成する。

```text
.orchestration/project/overview.md
.orchestration/project/package-map.xml
.orchestration/project/validation-matrix.md
.orchestration/project/risk-register.md
.orchestration/knowledge/index.md
```

Codex自身に直接これらを書かせることも可能だが、MVPでは「Codexは構造化JSONを返す」「wrapperがファイルを書く」に分けると再現性が高い。

---

## 7. `AGENTS.md` 設計

### 7.1 方針

`AGENTS.md` は「短く、実用的に、繰り返し失敗したことだけを入れる」。Codex公式ベストプラクティスでも、`AGENTS.md` にはrepo layout、run方法、build/test/lint、規約、do-not、doneの定義を書くのがよいとされる。[S17]

この計画では、`AGENTS.md` に巨大な知見を詰め込まない。詳細は `.orchestration/knowledge/` に置き、必要に応じてpromptで参照する。

### 7.2 生成する`AGENTS.md`例

```markdown
# AGENTS.md

## Repository expectations

- Treat this repository as a monorepo. Confirm the relevant package or service before editing.
- Before implementation, read `.orchestration/project/overview.md` and the target WorkItem XML when present.
- Keep changes minimal and scoped to the assigned WorkItem.
- Do not edit `.codex/`, `.agents/`, or `.orchestration/` unless the task explicitly asks for orchestration maintenance.
- Prefer existing scripts and package-manager conventions discovered in `.orchestration/project/validation-matrix.md`.
- After changes, run the smallest relevant test first, then broader checks if needed.
- Report exact commands and results.

## Done means

- The requested behavior is implemented.
- Relevant tests pass, or any inability to run tests is explained with command output.
- No unrelated refactors are introduced.
- Reviewer-facing summary includes changed files, rationale, risks, and verification.

## Orchestration

- WorkItems live in `.orchestration/workitems/*.xml`.
- Human-readable knowledge lives in `.orchestration/knowledge/`.
- Use XML for shared state and Markdown for explanations.
```

---

## 8. `.codex/config.toml` とcustom agents

### 8.1 `.codex/config.toml`例

```toml
# .codex/config.toml

[agents]
max_threads = 6
max_depth = 1
job_max_runtime_seconds = 1800

# SQLite-backed Codex state for agent jobs, if used by native subagent batch features.
sqlite_home = ".orchestration/.codex-sqlite"

[profiles.orchestrator-readonly]
sandbox_mode = "read-only"
approval_policy = "never"

[profiles.orchestrator-write]
sandbox_mode = "workspace-write"
approval_policy = "never"

[profiles.orchestrator-interactive]
sandbox_mode = "workspace-write"
approval_policy = "on-request"
```

注意: 実際にCodex CLIが読む設定キーはバージョンで変わる可能性があるため、installerは `codex --version` と `codex features list` を記録し、テンプレート生成後に `codex exec --ephemeral "Summarize active config"` のような検証runを行う。

### 8.2 `.codex/agents/explorer.toml`

```toml
name = "orchestration_explorer"
description = "Read-only explorer for understanding monorepo structure, package boundaries, validation commands, and risk areas before orchestration work."
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
developer_instructions = """
Stay in exploration mode. Do not modify files.
Map the repository structure, package boundaries, key commands, test strategy, and risky areas.
Cite file paths and symbols. Prefer targeted reads over broad scans.
Return concise, structured findings suitable for `.orchestration/project/*`.
"""
```

### 8.3 `.codex/agents/coder.toml`

```toml
name = "orchestration_coder"
description = "Implementation worker that makes scoped code changes for one WorkItem in an isolated worktree."
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
Implement exactly one assigned WorkItem.
Read the WorkItem XML, relevant project overview, and validation matrix before editing.
Keep the diff minimal. Do not perform unrelated refactors.
Run the smallest relevant validation command.
Write a concise implementation summary with changed files, rationale, commands run, and remaining risks.
"""
```

### 8.4 `.codex/agents/reviewer.toml`

```toml
name = "orchestration_reviewer"
description = "Read-only reviewer focused on correctness, security, missing tests, and spec adherence for one candidate patch."
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
Review like a code owner. Do not edit files.
Focus on correctness, security, behavior regressions, test coverage, and whether the patch satisfies the WorkItem.
Avoid style-only feedback unless it hides a real maintainability or correctness issue.
Return approve, request_changes, or reject with concrete evidence and next prompt hints.
"""
```

### 8.5 `.codex/agents/repairer.toml`

```toml
name = "orchestration_repairer"
description = "Implementation worker that fixes reviewer findings or validation failures without broadening scope."
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
Repair only the listed findings or validation failures.
Do not restart the implementation from scratch.
Preserve passing behavior and minimize the diff.
After repair, rerun the relevant checks and report exact results.
"""
```

---

## 9. `orchestration-init` skill

### 9.1 目的

途中導入時に、Codex managerが毎回ゼロからリポジトリを読むのを防ぐ。導入直後にプロジェクト理解を体系化し、以降のworkitem promptの共通文脈にする。

### 9.2 `SKILL.md`例

```markdown
---
name: orchestration-init
description: Initialize Codex orchestration for a new or existing monorepo by analyzing repository structure, commands, package boundaries, risks, and conventions. Use when onboarding a project into `.orchestration`.
---

# Orchestration Init Skill

You are onboarding a repository for multi-agent Codex orchestration.

## Rules

- Prefer read-only analysis unless the user explicitly asks you to write files.
- Identify package boundaries, service boundaries, test commands, lint commands, build commands, and risky areas.
- Distinguish facts observed from files from guesses.
- Look for existing docs before inferring behavior.
- Keep `AGENTS.md` short; put detailed knowledge under `.orchestration/knowledge/`.
- When returning structured output, include confidence and evidence paths.

## Output sections

1. Repository summary
2. Monorepo/package map
3. Important commands
4. Test and validation strategy
5. Architectural constraints
6. Risk register
7. Suggested first WorkItems
8. Recommended AGENTS.md additions
```

---

## 10. `.orchestration` の状態モデル

### 10.1 Object kinds

MVPで扱うkind:

```text
Plan
WorkItem
AgentRun
PatchCandidate
ReviewReport
KnowledgeEntry
ControllerLease
```

### 10.2 Phase一覧

`WorkItem.status.phase` は次を使う。

```text
Pending
Planned
Ready
Implementing
Validating
Reviewing
Repairing
ReadyToMerge
Merged
Blocked
Failed
Abandoned
```

### 10.3 Conditions

Kubernetes風にconditionsを持たせる。

```text
ContextReady
WorktreeReady
Implemented
TestsPassed
ReviewApproved
Merged
KnowledgeUpdated
```

それぞれ `True | False | Unknown`、時刻、理由、messageを持つ。

### 10.4 GenerationとobservedGeneration

`spec` が変わったら `metadata.generation` をincrementする。controllerがそのspecを処理したら `status.observedGeneration` を合わせる。

これにより、複数managerが同じworkitemを見る場合でも「古いstatusを見ていないか」を判定できる。

### 10.5 Lock / Lease

複数managerが作業するため、workitem単位でleaseを取る。

```xml
<ControllerLease apiVersion="orchestration.codex/v1" kind="ControllerLease">
  <metadata>
    <uid>LEASE-WI-20260516-001</uid>
  </metadata>
  <spec>
    <workItemRef>WI-20260516-001</workItemRef>
    <holderIdentity>hostA:pid12345:manager-1</holderIdentity>
    <acquiredAt>2026-05-16T01:00:00+09:00</acquiredAt>
    <renewTime>2026-05-16T01:02:00+09:00</renewTime>
    <ttlSeconds>120</ttlSeconds>
  </spec>
</ControllerLease>
```

実装は以下でよい。

- POSIX環境: `flock` またはatomic `mkdir`。
- クロスプラットフォーム: `locks/<workitem>.lock` をatomic createし、TTL切れならsteal可能。
- 状態更新: temp fileに書いて `rename()` でatomic replace。

---

## 11. Reconcile loop設計

### 11.1 基本ループ

```text
1. Load desired state
   - .orchestration/desired/plan.xml
   - .orchestration/workitems/*.xml

2. Observe current state
   - git status
   - worktree existence
   - candidate patch existence
   - last AgentRun status
   - review result
   - validation result

3. Diff desired/current
   - Pending WorkItem exists?
   - Worktree missing?
   - Implementation missing?
   - Tests failed?
   - Review requested changes?
   - ReadyToMerge but not merged?

4. Decide next action
   - create_worktree
   - run_explorer
   - run_coder
   - run_validation
   - run_reviewer
   - run_repairer
   - merge_candidate
   - update_knowledge
   - mark_blocked/failed

5. Act
   - execute git/codex commands
   - collect logs
   - write status

6. Report
   - append event
   - update WorkItem.status
   - optionally notify user/GitHub
```

### 11.2 擬似コード

```ts
async function reconcile(project: Project) {
  const state = await loadState(project);
  const queue = buildWorkQueue(state);

  for (const item of queue) {
    const lease = await tryAcquireLease(item.uid);
    if (!lease.acquired) continue;

    try {
      const observed = await observeWorkItem(project, item);
      const action = decideNextAction(item, observed);

      switch (action.type) {
        case "CREATE_WORKTREE":
          await createWorktree(project, item);
          break;
        case "RUN_CODER":
          await runCoder(project, item, action.variant);
          break;
        case "RUN_VALIDATION":
          await runValidation(project, item);
          break;
        case "RUN_REVIEWER":
          await runReviewer(project, item, action.candidate);
          break;
        case "RUN_REPAIRER":
          await runRepairer(project, item, action.findings);
          break;
        case "MERGE_CANDIDATE":
          await mergeCandidate(project, item, action.candidate);
          break;
        case "UPDATE_KNOWLEDGE":
          await updateKnowledge(project, item);
          break;
        case "MARK_BLOCKED":
          await markBlocked(project, item, action.reason);
          break;
      }
    } finally {
      await releaseLease(lease);
    }
  }
}
```

### 11.3 Idempotency

各actionは再実行しても壊れないようにする。

- worktree作成: 既に存在すれば再利用またはstatusと照合。
- coder run: 同じ `runId` は再実行しない。新規attemptとして作る。
- patch保存: `candidate-id` ごとにimmutable。
- review: 同じcandidate hashならreviewを再利用できる。
- merge: merge済みcommit hashをstatusに記録。
- cleanup: finalizerが外れるまでworktreeを消さない。

### 11.4 Retry policy

```xml
<retryPolicy>
  <maxImplementationAttempts>3</maxImplementationAttempts>
  <maxRepairAttempts>3</maxRepairAttempts>
  <backoffSeconds>30</backoffSeconds>
  <onRepeatedFailure>mark_blocked</onRepeatedFailure>
</retryPolicy>
```

失敗理由の分類:

```text
PromptAmbiguous
ValidationCommandMissing
TestFailed
ReviewRejected
MergeConflict
SandboxDenied
Timeout
CodexError
HumanInputRequired
```

`HumanInputRequired` は自律継続せず `Blocked` にする。

---

## 12. Worktree戦略

### 12.1 基本方針

- 1 WorkItemにつき1〜N個のcandidate worktreeを作る。
- 同じbranchを複数worktreeでcheckoutしない。
- worktree名はworkitemとcandidate idで一意にする。
- finalizerで未保存patchを回収してから削除する。

### 12.2 例

```bash
git worktree add \
  .orchestration/worktrees/WI-20260516-001-coder-a \
  -b orch/WI-20260516-001-coder-a \
  HEAD
```

### 12.3 依存関係の扱い

モノレポでは依存タスクがあるため、workitem DAGを持つ。

- 依存タスクが `Merged` になるまで次を `Ready` にしない。
- 依存タスクのpatchを同じbaseに積む場合は、controllerがworktree作成時のbase commitを選ぶ。
- 複数候補を比較する場合は同一base commitに揃える。

### 12.4 Candidate比較

同一WorkItemに複数coderを走らせる場合:

```text
CAND-A: minimal diff, tests pass, review request_changes
CAND-B: larger diff, tests pass, review approve
CAND-C: tests fail
```

選定基準:

1. acceptance criteriaを満たす。
2. tests pass。
3. reviewer approve。
4. diffが小さい。
5. 既存設計への適合が高い。
6. repair回数が少ない。

controllerは自動merge可能な条件を厳しめにする。

```text
auto merge allowed only if:
- ReviewApproved=True
- TestsPassed=True
- risk != high
- no protected paths changed
- changed file count <= configured threshold
```

それ以外は `ReadyToMerge` で人間確認に止める。

---

## 13. Codex worker実行設計

### 13.1 Coder実行

```bash
codex exec \
  --cd "$WORKTREE" \
  --sandbox workspace-write \
  --ask-for-approval never \
  --json \
  --output-last-message "$CANDIDATE_DIR/RESULTS.md" \
  "$(cat .orchestration/prompts/coder-prompt.md)"
```

Promptに含めるもの:

```text
- role: coder
- WorkItem XML全文
- project overviewへのパス
- validation matrixへのパス
- allowed scope
- forbidden scope
- output requirements
- exact files/directories that are likely relevant, if known
- retry context, if any
```

Coderへの重要指示:

```text
- WorkItem以外を直さない。
- まず関連箇所を読む。
- 実装後、最小テストを実行する。
- 実行できない場合は理由とエラーを記録する。
- 変更ファイル、設計判断、リスクを報告する。
```

### 13.2 Validation実行

ValidationはCodexに任せる場合とcontrollerが直接実行する場合がある。

MVPでは、controllerが直接実行する。

```bash
cd "$WORKTREE"
pnpm --filter @repo/api test 2>&1 | tee "$CANDIDATE_DIR/validation.log"
```

理由:

- 判定が安定する。
- Codexの自己申告に依存しない。
- 失敗ログをrepair promptにそのまま渡せる。

### 13.3 Reviewer実行

```bash
codex exec \
  --cd "$WORKTREE" \
  --sandbox read-only \
  --ask-for-approval never \
  --json \
  --output-schema "$PROJECT/.orchestration/schemas/review-result.schema.json" \
  --output-last-message "$CANDIDATE_DIR/review.json" \
  "$(cat .orchestration/prompts/reviewer-prompt.md)"
```

Reviewer promptに含めるもの:

```text
- WorkItem XML
- candidate summary
- git diff --stat
- git diff
- validation results
- project constraints
- output schema
```

Reviewerの出力はwrapperが `review.xml` に変換するか、JSONのまま保存する。

### 13.4 Repairer実行

```bash
codex exec \
  --cd "$WORKTREE" \
  --sandbox workspace-write \
  --ask-for-approval never \
  --json \
  --output-last-message "$CANDIDATE_DIR/repair-$N.md" \
  "Repair only the following review findings. Do not broaden scope. ..."
```

修復後は必ずvalidationとreviewに戻す。

---

## 14. Planから最後まで進める流れ

### 14.1 入力Plan

人間またはCodex managerが `specs/feature.md` を作る。

```markdown
# Feature: User settings API

## Goal
...

## Requirements
...

## Acceptance Criteria
...

## Constraints
...
```

### 14.2 Plan展開

`codex-orchestrator plan` がManager Codexをread-only中心で呼ぶ。

出力:

```text
.orchestration/desired/plan.xml
.orchestration/workitems/WI-*.xml
.orchestration/knowledge/decisions/ADR-*.md, if needed
```

### 14.3 自律実行

```bash
codex-orchestrator run . --until complete
```

処理:

```text
Pending -> Ready -> Implementing -> Validating -> Reviewing
    if review approve -> ReadyToMerge
    if review request_changes -> Repairing -> Validating -> Reviewing
    if validation fail -> Repairing
    if max retries exceeded -> Blocked
ReadyToMerge -> Merged -> KnowledgeUpdated
```

### 14.4 途中で止まる条件

- 仕様が曖昧で人間判断が必要。
- destructive operationが必要。
- migrationやsecurity-sensitive changeで自動merge禁止。
- 連続失敗。
- 依存タスクが失敗。
- merge conflictが自動解決不能。

---

## 15. 知見の累積

### 15.1 知見の種類

```text
knowledge/index.md
knowledge/decisions/ADR-*.md
knowledge/lessons/YYYYMMDD-*.md
knowledge/patterns/<area>.md
knowledge/failures/<signature>.md
```

### 15.2 知見更新タイミング

- init完了時
- WorkItem完了時
- 同じ失敗が2回出た時
- reviewerが重要な設計制約を指摘した時
- test commandやpackage boundaryの新事実が見つかった時
- merge conflictの解決パターンが見つかった時

### 15.3 KnowledgeEntry XML

```xml
<KnowledgeEntry apiVersion="orchestration.codex/v1" kind="KnowledgeEntry">
  <metadata>
    <uid>KE-20260516-001</uid>
    <createdAt>2026-05-16T03:00:00+09:00</createdAt>
    <sourceWorkItem>WI-20260516-001</sourceWorkItem>
  </metadata>
  <spec>
    <category>failure-pattern</category>
    <title>API tests require tenant fixture setup before auth helper.</title>
    <summary>When adding API tests under services/api, create tenant fixture before calling auth helper or tests fail with 403.</summary>
    <evidence>
      <path>services/api/test/helpers/auth.ts</path>
      <runId>RUN-20260516-014</runId>
    </evidence>
    <action>Update future coder prompts for services/api tests.</action>
  </spec>
</KnowledgeEntry>
```

### 15.4 AGENTS.mdへの昇格ルール

知見は最初から `AGENTS.md` に入れない。次の条件を満たしたものだけ昇格する。

```text
- 2回以上同じ失敗を防げる。
- repo全体に影響する。
- 短い一文で表現できる。
- 変わりにくい。
```

---

## 16. セキュリティ・権限設計

### 16.1 原則

- ReviewerとExplorerはread-only。
- CoderとRepairerはworktree内のworkspace-write。
- `danger-full-access` と `--yolo` は通常禁止。使う場合はDocker/CIなど外部で隔離したrunnerのみ。
- ネットワークは既定でoff。依存追加や外部調査が必要な場合は人間承認、またはallowlistされた環境で別runにする。
- `.env`、秘密鍵、cloud credentials、production configはread deny対象にする。

### 16.2 Codex rules

`.codex/rules/orchestration.rules` では安全なコマンドだけallow、危険なものは禁止またはpromptにする。

概念例:

```text
allow: git status, git diff, git log, git worktree list
allow: pnpm test, npm test, pytest, cargo test, go test
prompt: git push, gh pr create
forbid: rm -rf /, curl ... | sh, reading ~/.ssh, reading *.env
```

実際のrules構文はCodex公式の `prefix_rule()` に合わせ、installerがバージョンに応じて生成する。

### 16.3 Protected paths

Codex公式ではdefault `workspace-write` でも `.git`、`.agents`、`.codex` などが保護される。これは良い挙動なので、orchestration workerが勝手に自分のskillやagent定義を書き換えない設計にする。[S8]

### 16.4 Supply-chain対策

- 依存追加はWorkItemに明示されている場合だけ。
- package installが必要な場合は専用phase `DependencyProposal` を作り、人間確認に止める。
- `curl | bash`、remote script実行は禁止。
- lockfile変更はreviewerが重点確認する。

---

## 17. 実装ロードマップ

### Phase 0: Spike / PoC

期間目安: 1〜2日

Deliverables:

- 手動で `.orchestration/` とworktreeを作るサンプル。
- `codex exec --json` を呼び、JSONLを保存するwrapper。
- 1 WorkItemを実装、validation、reviewまで通す。

Acceptance:

- `codex-orchestrator reconcile --once` が1つのworkitemを1段階進める。
- Codex runのログが `.orchestration/runs/` に残る。

### Phase 1: Installer

Deliverables:

- `install <project>` コマンド。
- 既存ファイル検出とsafe overwrite。
- `AGENTS.md`、`.codex/agents`、`.agents/skills`、`.orchestration` 生成。
- preflight report。

Acceptance:

- 空repo、新規repo、既存monorepo fixtureに安全に導入できる。
- 既存 `AGENTS.md` を破壊しない。

### Phase 2: Project init skill連携

Deliverables:

- `orchestration-init` skill。
- read-only Codex分析run。
- `overview.md`、`package-map.xml`、`validation-matrix.md`、`risk-register.md` 生成。

Acceptance:

- 既存monorepoで主要packageとtest command候補を抽出できる。
- 不明点は推測として明記し、事実と混ぜない。

### Phase 3: WorkItem / Planモデル

Deliverables:

- `plan <spec.md>` コマンド。
- `Plan` と `WorkItem` XML生成。
- DAG依存関係。
- schema validation。

Acceptance:

- 1つのspecから複数workitemに分解される。
- `status` にReady/Pendingが正しく設定される。

### Phase 4: Controller MVP

Deliverables:

- `reconcile --once`。
- lease/lock。
- worktree作成。
- coder run。
- validation run。
- reviewer run。
- status更新。

Acceptance:

- 同じworkitemに対してreconcileを繰り返しても壊れない。
- 失敗時に原因がstatus/eventsに残る。

### Phase 5: Repair loop

Deliverables:

- reviewer `request_changes` をrepair promptへ変換。
- validation failureをrepair promptへ変換。
- retry上限。
- Blocked/Failed判定。

Acceptance:

- テスト失敗 -> repair -> 再validation -> review のループが動く。
- 上限超過時に無限ループしない。

### Phase 6: Candidate比較とmerge

Deliverables:

- 複数coder candidate。
- candidate score。
- auto merge guard。
- patch保存。
- conflict時のBlocked化。

Acceptance:

- 3候補を生成し、review結果とtest結果で選定できる。
- auto merge条件を満たすものだけmergeされる。

### Phase 7: Knowledge accumulation

Deliverables:

- WorkItem完了時の知見更新。
- failure pattern記録。
- AGENTS.md昇格候補生成。
- knowledge index更新。

Acceptance:

- 同じエラーの再発時に過去のfailure patternがpromptに入る。

### Phase 8: Observability / Dashboard

Deliverables:

- `status` コマンド。
- `events` 表示。
- run logs要約。
- Markdown/HTML dashboard optional。

Acceptance:

- 進行中workitem、失敗理由、次actionが1コマンドでわかる。

### Phase 9: CI/GitHub連携

Deliverables:

- GitHub PR作成optional。
- GitHub Actionsでreview/validation optional。
- issue/PRコメントからworkitem生成 optional。

Acceptance:

- ローカルMVPを壊さず、GitHub運用にも拡張できる。

---

## 18. テスト戦略

### 18.1 Unit tests

- XML parser/serializer。
- WorkItem phase遷移。
- retry policy。
- lock/lease。
- worktree name生成。
- candidate score。
- prompt rendering。

### 18.2 Golden tests

fixture repoを用意し、入力specから生成される `plan.xml`、`workitem.xml`、promptをsnapshot比較する。

### 18.3 Mock Codex tests

`codex exec` をfake binaryに差し替え、JSONLイベントと最終出力を返す。

確認:

- JSONL保存。
- failure handling。
- output schema mismatch。
- timeout。
- sandbox denied。

### 18.4 Integration tests

小さいサンプルrepoで実際に以下を行う。

```text
install -> init -> plan -> reconcile coder -> validation -> review -> merge
```

### 18.5 Chaos tests

- controllerを途中でkill。
- lockを残したまま終了。
- worktreeを手動削除。
- run logが途中で切れる。
- review JSONが壊れる。
- merge conflictを起こす。

Reconcileで復旧またはBlocked化できることを確認する。

---

## 19. 成功指標

MVP後に見る指標:

```text
- WorkItem完了率
- 平均attempt数
- validation pass率
- reviewer request_changes率
- auto merge率
- Blocked理由分布
- 1 WorkItemあたりのCodex run数
- 1 WorkItemあたりの経過時間
- merge後の人間修正量
- 同じ失敗の再発率
```

初期目標:

```text
- 小〜中規模WorkItemの70%以上がBlockedなしでReadyToMergeまで進む。
- reviewer request_changes後のrepair成功率が50%以上。
- 同じ失敗の再発率が導入2週間で下がる。
```

---

## 20. リスクと対策

| リスク | 内容 | 対策 |
|---|---|---|
| 無限ループ | テスト失敗と修復を繰り返す | retry上限、failure分類、Blocked化 |
| merge chaos | 複数worktreeの差分が衝突 | WorkItem DAG、ファイルscope、merge guard |
| context肥大化 | AGENTS.mdやpromptが大きくなる | AGENTS.md短文化、knowledge index、必要箇所だけ引用 |
| 誤った知見蓄積 | Codexの推測が事実化する | evidence path必須、confidence記録、人間review可能にする |
| security事故 | 秘密情報読み取り、外部通信 | read deny、network off、rules、sandbox、no yolo |
| reviewerの甘さ | 実装Codexの自己評価を信じる | 別run/read-only reviewer、validationはcontroller直実行 |
| 複数manager競合 | 同じworkitemを同時処理 | lease/lock、generation、atomic update |
| 既存repo破壊 | 導入時に設定を上書き | safe overwrite、patch生成、backup |
| Codex CLI仕様変更 | flags/configが変わる | version記録、preflight検証、adapter層 |
| コスト増 | 並列agentでtoken消費増 | max concurrency、task size制御、review reuse |

---

## 21. 最初に実装するMVPの範囲

MVPでは以下に絞る。

```text
必須:
- install
- init read-only analysis
- WorkItem XML
- reconcile --once
- one coder in one worktree
- direct validation command
- one reviewer
- repair loop up to 2回
- status command

後回し:
- 複数candidate比較
- GitHub PR作成
- dashboard
- MCP統合
- Codex native spawn_agents_on_csv連携
- SQLite state DB
```

理由: 最初から複数candidate、GitHub、dashboardまで入れると、controllerの正しさより周辺機能に実装が流れる。まずは「1 workitemがreconcileで最後まで進む」ことを証明する。

---

## 22. 具体的な実装コンポーネント

TypeScript案:

```text
packages/cli/src/
├── index.ts
├── commands/
│   ├── install.ts
│   ├── init.ts
│   ├── plan.ts
│   ├── reconcile.ts
│   ├── run.ts
│   ├── status.ts
│   └── gc.ts
├── codex/
│   ├── exec.ts
│   ├── jsonl.ts
│   ├── prompts.ts
│   └── schemas.ts
├── controller/
│   ├── observe.ts
│   ├── decide.ts
│   ├── actions.ts
│   ├── phases.ts
│   └── retry.ts
├── state/
│   ├── xml.ts
│   ├── workitem.ts
│   ├── plan.ts
│   ├── lease.ts
│   └── atomic-write.ts
├── git/
│   ├── worktree.ts
│   ├── diff.ts
│   ├── merge.ts
│   └── status.ts
├── templates/
│   ├── AGENTS.md
│   ├── config.toml
│   ├── agents/*.toml
│   └── skills/orchestration-init/*
└── utils/
    ├── fs.ts
    ├── logger.ts
    └── time.ts
```

推奨ライブラリ:

```text
commander or clipanion: CLI
execa: subprocess
fast-xml-parser: XML parse/serialize
zod: runtime validation
proper-lockfile or custom atomic lock: lock
picocolors: CLI output
```

ただし、依存追加リスクを減らすなら、MVPはNode標準ライブラリ中心でもよい。

---

## 23. Promptテンプレート

### 23.1 Coder prompt骨子

```text
You are the coder worker for Codex Orchestration.

Read this WorkItem XML carefully:
<workitem>
...
</workitem>

Project context:
- Overview: .orchestration/project/overview.md
- Validation matrix: .orchestration/project/validation-matrix.md
- Relevant knowledge: ...

Rules:
- Implement only this WorkItem.
- Keep changes minimal.
- Do not edit .codex, .agents, or .orchestration except writing candidate report files if explicitly asked.
- Run the smallest relevant validation command.
- If validation cannot run, explain why with exact command output.

Output final response with:
1. Summary
2. Changed files
3. Validation commands and results
4. Risks
5. Follow-up suggestions only if required
```

### 23.2 Reviewer prompt骨子

```text
You are the reviewer worker for Codex Orchestration.

Review this candidate patch against the WorkItem.
Do not edit files.

Inputs:
- WorkItem XML
- git diff --stat
- git diff
- validation logs
- project constraints

Focus:
- correctness
- security
- missing tests
- behavior regressions
- spec adherence
- unnecessary scope expansion

Return JSON matching the schema:
{
  "result": "approve | request_changes | reject",
  "summary": "...",
  "findings": [
    {
      "severity": "low | medium | high | critical",
      "category": "correctness | security | tests | maintainability | spec",
      "title": "...",
      "evidence": [{"path":"...", "lines":"..."}],
      "required_change": "..."
    }
  ],
  "next_prompt_hints": ["..."]
}
```

### 23.3 Repair prompt骨子

```text
You are the repair worker.

Do not broaden scope. Fix only the findings below.

Findings:
...

Previous validation log:
...

After changes:
- rerun relevant validation
- summarize exact fixes
- explain why the reviewer finding is addressed
```

---

## 24. Status表示例

```text
$ codex-orchestrator status .

Project: my-monorepo
Plan: PLAN-20260516-001

WorkItems:
  WI-20260516-001 add-user-settings-api
    phase: Reviewing
    attempts: 2
    candidate: CAND-001-A
    tests: passed
    review: pending

  WI-20260516-002 add-settings-ui
    phase: Pending
    waiting for: WI-20260516-001

  WI-20260516-003 update-docs
    phase: Ready

Recent events:
  02:20 coder completed WI-001 RUN-014
  02:28 validation passed WI-001
  02:29 reviewer started WI-001 RUN-015
```

---

## 25. 導入チェックリスト

### 導入前

```text
[ ] codex CLI installed
[ ] git repo clean or current dirty state accepted
[ ] team agrees whether .orchestration is committed or partially ignored
[ ] secret files identified
[ ] default test/lint/build commands known or discoverable
```

### install後

```text
[ ] AGENTS.md created or patch generated
[ ] .codex/config.toml created or patch generated
[ ] .codex/agents/*.toml exists
[ ] .agents/skills/orchestration-init/SKILL.md exists
[ ] .orchestration/project/overview.md generated
[ ] .orchestration/project/validation-matrix.md generated
[ ] status command works
```

### 初回run前

```text
[ ] WorkItem XML reviewed
[ ] validation commands safe
[ ] sandbox mode confirmed
[ ] network access disabled unless explicitly needed
[ ] max retries configured
[ ] auto merge disabled for first trial
```

---

## 26. 推奨する運用開始方法

1. 既存プロジェクトでは、最初の1週間はauto mergeを無効にする。
2. WorkItemは小さくする。1 WorkItemは「1 PRで自然にレビューできる大きさ」にする。
3. まずはread-only ExplorerとReviewerを多用し、実装自動化は小さな変更から始める。
4. 繰り返し起きた失敗だけを `AGENTS.md` に昇格する。
5. `.orchestration/knowledge/` を週1で棚卸しし、古くなった知見を削除またはdeprecatedにする。
6. 高リスク領域、migration、認証認可、課金、セキュリティ関連は必ず人間mergeにする。

---

## 27. 参考資料

[S1] OpenAI Developers, “Custom instructions with AGENTS.md – Codex”  
https://developers.openai.com/codex/guides/agents-md

[S2] OpenAI Developers, “Non-interactive mode – Codex”  
https://developers.openai.com/codex/noninteractive

[S3] OpenAI Developers, “Non-interactive mode – Make output machine-readable”  
https://developers.openai.com/codex/noninteractive

[S4] OpenAI Developers, “Command line options – Codex CLI”  
https://developers.openai.com/codex/cli/reference

[S5] OpenAI Developers, “Agent Skills – Codex”  
https://developers.openai.com/codex/skills

[S6] OpenAI Developers, “Subagents – Codex”  
https://developers.openai.com/codex/subagents

[S7] OpenAI Developers, “Worktrees – Codex app”  
https://developers.openai.com/codex/app/worktrees

[S8] OpenAI Developers, “Agent approvals & security – Codex” and “Sandbox – Codex”  
https://developers.openai.com/codex/agent-approvals-security  
https://developers.openai.com/codex/concepts/sandboxing

[S9] GitHub Blog, “Pick your agent: Use Claude and Codex on Agent HQ”  
https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/

[S10] GitHub Blog, “Introducing Agent HQ: Any agent, any way you work”  
https://github.blog/news-insights/company-news/welcome-home-agents/

[S11] nwiizo/ccswarm, “AI Multi-Agent Orchestration System”  
https://github.com/nwiizo/ccswarm

[S12] Agent Interviews, “Parallel AI Coding with Git Worktrees and Custom Claude Code Commands”  
https://docs.agentinterviews.com/blog/parallel-ai-coding-with-gitworktrees/

[S13] Git, “git-worktree Documentation”  
https://git-scm.com/docs/git-worktree

[S14] Addy Osmani, “The Code Agent Orchestra - what makes multi-agent coding work”  
https://addyosmani.com/blog/code-agent-orchestra/

[S15] Google Jules, “An Autonomous Coding Agent”  
https://jules.google/

[S16] Kubernetes Docs, “Controllers”  
https://kubernetes.io/docs/concepts/architecture/controller/

[S17] OpenAI Developers, “Best practices – Codex”  
https://developers.openai.com/codex/learn/best-practices
