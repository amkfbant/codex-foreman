# codex-foreman

`codex-foreman` は、Codex を複数の作業ロールとして扱うためのローカル orchestration controller です。

対象プロジェクトに `AGENTS.md`、`.codex/`、`.agents/skills/`、`.orchestration/` を導入し、WorkItem をもとに実装用 worktree、検証、レビュー、修復、ガード付き merge までを段階的に進めます。

CLI には、実装計画書内の例と互換にするため `codex-orchestrator` という別名も用意しています。

## 現在できること

- TypeScript 製 CLI として `codex-foreman` / `codex-orchestrator` を提供
- `install` で orchestration 用の設定、skill、state ディレクトリを生成
- conservative rules と各種 schema を生成
- `init` でリポジトリ構造、検証コマンド候補、リスク情報を静的に分析
- `plan` で Markdown spec から複数の `WorkItem` を生成し、`init` が作る `validation-catalog.json` から検証コマンドを引き継ぐ
- `reconcile --once` で WorkItem を1段階ずつ進める
- Codex 実行境界を adapter 化し、既定では deterministic な fake adapter を使用
- XML と JSON sidecar の両方で状態を保存し、不一致があれば `StateFormatMismatch` として停止
- git worktree を使って複数candidateを隔離
- validation、review、diff size、protected path、dependency file変更、repair回数でcandidateをscore
- validation、review、repair、ガード付き auto-merge の基本フローを実装
- validation が staged patch や worktree を変更した candidate は reject
- `events` と静的HTML `dashboard` を生成

## セットアップ

```bash
corepack pnpm install
corepack pnpm build
```

テスト:

```bash
corepack pnpm test
```

型チェック:

```bash
corepack pnpm typecheck
```

real `codex exec` のsmoke testは既定ではskipされます。明示的に実行する場合:

```bash
CODEX_FOREMAN_REAL_CODEX=1 corepack pnpm test tests/real-codex-smoke.test.ts
```

## コマンド

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

開発中に直接実行する場合:

```bash
corepack pnpm dev -- status .
```

## 基本フロー

1. 対象リポジトリに導入します。

```bash
codex-foreman install /path/to/project
```

2. プロジェクト情報を初期化します。

```bash
codex-foreman init /path/to/project
```

3. Markdown の仕様書から plan と WorkItem を作ります。

```bash
codex-foreman plan /path/to/project specs/feature.md
```

4. controller を1ステップ進めます。

```bash
codex-foreman reconcile /path/to/project --once
```

5. 状態を確認します。

```bash
codex-foreman status /path/to/project
```

## 状態管理

状態は `.orchestration/` に保存されます。

- `.orchestration/config.xml` / `.orchestration/config.json`: controller 設定
- `.orchestration/desired/plan.xml` / `.orchestration/desired/plan.json`: 目標状態
- `.orchestration/project/validation-catalog.json`: `init` が検出した検証コマンド候補
- `.orchestration/workitems/*.xml` / `*.json`: WorkItem 状態
- `.orchestration/runs/`: Codex JSONL と AgentRun XML/JSON
- `.orchestration/candidates/`: 候補差分、検証ログ、レビュー結果、score
- `.orchestration/knowledge/`: 完了した WorkItem から得た知見
- `.orchestration/dashboard/index.html`: 静的HTML dashboard
- `.orchestration/worktrees/`: worker 用 git worktree

XML と JSON sidecar は同じ意味内容である必要があります。差分がある場合、controller は状態を壊さず停止します。

`.orchestration/workitems`、`candidates`、`runs`、`events`、`locks`、`leases`、`worktrees`、`dashboard` は controller が更新する runtime state です。`install` はこれらを対象リポジトリの `.git/info/exclude` に追加します。設定、project 情報、knowledge、plan は必要に応じて Git 管理できますが、runtime state は明示的な運用を決めない限り commit しない前提です。

validation command は制限されています。既定では package manager の test/lint/build 系コマンドと read-only な Git コマンドのみを許可し、`git add`、`git reset`、`git clean`、`git push`、直接の `node -e` validation などは拒否します。

## Codex 実行モード

既定では fake adapter を使います。これはテストとローカル検証を安定させるためです。

実際に `codex exec` を呼びたい場合は、`--codex real` を指定します。

```bash
codex-foreman reconcile /path/to/project --once --codex real
```

または環境変数でも切り替えできます。

```bash
CODEX_FOREMAN_CODEX=real codex-foreman run /path/to/project --until complete
```

## Auto-Merge

auto-merge は実装されていますが、既定では無効です。

有効化する場合は `.orchestration/config.xml` と `.orchestration/config.json` の `autoMerge.enabled` を `true` にします。merge 前には、検証成功、レビュー承認、変更ファイル数、protected path、高リスク WorkItem などの guard が確認されます。

## 開発メモ

主要な実装箇所:

- `src/index.ts`: CLI entrypoint
- `src/controller.ts`: reconcile loop と phase 遷移
- `src/state/store.ts`: XML / JSON sidecar 永続化
- `src/codex.ts`: fake / real Codex execution adapter
- `src/commands/`: 各 CLI command
- `tests/`: state、install、reconcile のテスト
