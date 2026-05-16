import { apiVersion, type OrchestrationConfig } from "../domain.js";

export function defaultConfig(): OrchestrationConfig {
  return {
    apiVersion,
    kind: "Config",
    defaults: {
      maxCoders: 3,
      maxReviewers: 2,
      validationTimeoutSeconds: 600
    },
    retryPolicy: {
      maxImplementationAttempts: 3,
      maxRepairAttempts: 2,
      backoffSeconds: 30,
      onRepeatedFailure: "mark_blocked"
    },
    autoMerge: {
      enabled: false,
      maxChangedFiles: 12,
      allowHighRisk: false
    },
    candidatePolicy: {
      maxCandidates: 3,
      minScoreToSelect: 80,
      parallel: true
    },
    security: {
      forbidDependencyChanges: true,
      highRiskRequiresManualMerge: true,
      dependencyFiles: [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "Cargo.toml",
        "Cargo.lock",
        "go.mod",
        "go.sum",
        "pyproject.toml",
        "poetry.lock",
        "uv.lock"
      ]
    },
    validationPolicy: {
      allowedExecutables: ["pnpm", "npm", "yarn", "bun", "pytest", "cargo", "go", "make", "git", "node", "turbo", "nx"],
      forbiddenArgPatterns: ["(^|/)\\.env($|\\b)", "\\brm\\s+-rf\\b", "\\bcurl\\b.*\\|\\s*sh"]
    },
    dashboard: {
      defaultOutput: ".orchestration/dashboard/index.html"
    },
    protectedPaths: [
      ".git/",
      ".env",
      ".env.*",
      ".codex/",
      ".agents/",
      ".orchestration/config.xml",
      ".orchestration/config.json"
    ]
  };
}
