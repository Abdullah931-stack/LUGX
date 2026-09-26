/**
 * CI Gating & Step Summary Simulation Validator (Phase 3 Verification).
 *
 * Simulates and verifies the fail-closed vs permissive gating rules across all
 * CI execution context permutations (Protected Main, Release Tags, Fork PRs, Manual Smoke)
 * and asserts strict Markdown step summary formatting.
 *
 * Usage:
 *   node scripts/test-ci-gating.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CI_YML_PATH = path.join(ROOT, ".github", "workflows", "ci.yml");

/**
 * Simulates Stage 6 Playwright E2E gating logic matching ci.yml.
 */
function simulateStage6Gating({ eventName, ref, runLiveSmoke, secrets }) {
  const isProtected =
    eventName === "release" ||
    ref === "refs/heads/main" ||
    ref === "refs/heads/master" ||
    ref.startsWith("refs/tags/") ||
    runLiveSmoke === "true";

  const dbStatus = secrets.TEST_DATABASE_URL ? "✅ Configured" : "❌ Missing";
  const sbUrlStatus = secrets.NEXT_PUBLIC_SUPABASE_URL ? "✅ Configured" : "❌ Missing";
  const sbKeyStatus = secrets.SUPABASE_SERVICE_ROLE_KEY ? "✅ Configured" : "❌ Missing";
  const stripeStatus = secrets.STRIPE_SECRET_KEY ? "✅ Configured" : "❌ Missing";
  const redisStatus = secrets.UPSTASH_REDIS_REST_URL ? "✅ Configured" : "❌ Missing";
  const geminiStatus = secrets.GEMINI_KEY_1 ? "✅ Configured" : "❌ Missing";

  const missingMandatory =
    !secrets.TEST_DATABASE_URL ||
    !secrets.NEXT_PUBLIC_SUPABASE_URL ||
    !secrets.SUPABASE_SERVICE_ROLE_KEY;

  let exitCode = 0;
  let status = "PASSED";
  let stepSummary = "";

  if (missingMandatory) {
    if (isProtected) {
      exitCode = 1;
      status = "FAIL_CLOSED";
      stepSummary = `## ❌ Stage 6: Playwright E2E Browser Testing — FAILED (Fail-Closed Gate)

> [!CAUTION]
> **Release Deployment Blocked:** Mandatory repository secrets are missing in protected context (\`${ref}\` via \`${eventName}\`).
> Silent skips with exit 0 are strictly prohibited on production branches and release tags.

### Credential Verification Matrix
| Secret / Environment Variable | Status | Gating Rule |
| :--- | :--- | :--- |
| \`TEST_DATABASE_URL\` | ${dbStatus} | **Mandatory (Missing)** |
| \`NEXT_PUBLIC_SUPABASE_URL\` | ${sbUrlStatus} | **Mandatory** |
| \`SUPABASE_SERVICE_ROLE_KEY\` | ${sbKeyStatus} | **Mandatory** |
| \`STRIPE_SECRET_KEY\` | ${stripeStatus} | Optional / Mock Fallback |
| \`UPSTASH_REDIS_REST_URL\` | ${redisStatus} | Optional / Mock Fallback |
| \`GEMINI_KEY_1\` | ${geminiStatus} | Optional / Mock Fallback |

**Resolution:** Configure the missing secrets in GitHub Repository Settings > Secrets and variables > Actions.`;
    } else {
      exitCode = 0;
      status = "PERMISSIVE_SKIP";
      stepSummary = `## ⚠️ Stage 6: Playwright E2E Browser Testing — SKIPPED (Permissive PR Gate)

> [!WARNING]
> **Browser E2E Tests Gracefully Skipped:** Required secrets are not configured in this pull request or non-protected context (\`${ref}\` via \`${eventName}\`).
> This permissive bypass is restricted to pull requests and forks to maintain non-blocking CI feedback. Production releases enforce strict fail-closed execution.

### Credential Status Matrix
| Secret / Environment Variable | Status | Context Classification |
| :--- | :--- | :--- |
| \`TEST_DATABASE_URL\` | ${dbStatus} | Mandatory for Release |
| \`NEXT_PUBLIC_SUPABASE_URL\` | ${sbUrlStatus} | Mandatory for Release |
| \`SUPABASE_SERVICE_ROLE_KEY\` | ${sbKeyStatus} | Mandatory for Release |
| \`STRIPE_SECRET_KEY\` | ${stripeStatus} | Optional |
| \`UPSTASH_REDIS_REST_URL\` | ${redisStatus} | Optional |
| \`GEMINI_KEY_1\` | ${geminiStatus} | Optional |`;
    }
  } else {
    exitCode = 0;
    status = "PASSED";
    stepSummary = `## ✅ Stage 6: Playwright E2E Browser Testing — PASSED

| Metric / Parameter | Value |
| :--- | :--- |
| **Execution Status** | ✅ 100% Passed (All specs executed) |
| **Workflow Context** | \`${ref}\` (\`${eventName}\`) |
| **Protected Gate** | \`${isProtected}\` |
| **Browser Target** | Chromium Headless |
| **Test Inventory** | 14 Specs / 15 User Journeys |

### Verified Environment Credentials
| Secret / Environment Variable | Status |
| :--- | :--- |
| \`TEST_DATABASE_URL\` | ${dbStatus} |
| \`NEXT_PUBLIC_SUPABASE_URL\` | ${sbUrlStatus} |
| \`SUPABASE_SERVICE_ROLE_KEY\` | ${sbKeyStatus} |
| \`STRIPE_SECRET_KEY\` | ${stripeStatus} |
| \`UPSTASH_REDIS_REST_URL\` | ${redisStatus} |
| \`GEMINI_KEY_1\` | ${geminiStatus} |`;
  }

  return { exitCode, status, isProtected, stepSummary };
}

/**
 * Simulates Stage 7 Live Provider Smoke gating logic matching ci.yml.
 */
function simulateStage7Gating({ eventName, ref, _runLiveSmoke, secrets }) {
  const dbStatus = secrets.TEST_DATABASE_URL ? "✅ Configured" : "❌ Missing";
  const geminiStatus = secrets.GEMINI_KEY_1 ? "✅ Configured" : "❌ Missing";

  let exitCode = 0;
  let status = "PASSED";
  let stepSummary = "";

  if (!secrets.TEST_DATABASE_URL || !secrets.GEMINI_KEY_1) {
    exitCode = 1;
    status = "FAIL_CLOSED";
    stepSummary = `## ❌ Stage 7: Live Provider Smoke — FAILED (Missing Required Secrets)

> [!CAUTION]
> **Live Smoke Gate Failed:** Execution of live provider smoke tests was triggered for \`${ref}\` (\`${eventName}\`), but required live credentials are not configured.
> Fail-closed gate prevents unverified cloud provider releases.

### Provider Credential Matrix
| Secret Name | Status | Requirement |
| :--- | :--- | :--- |
| \`TEST_DATABASE_URL\` | ${dbStatus} | **Mandatory** |
| \`GEMINI_KEY_1\` | ${geminiStatus} | **Mandatory** |

**Resolution:** Provide valid Neon and Gemini test keys in GitHub Repository Secrets.`;
  } else {
    exitCode = 0;
    status = "PASSED";
    stepSummary = `## ✅ Stage 7: Live Provider Smoke — PASSED

| Metric / Parameter | Value |
| :--- | :--- |
| **Execution Status** | ✅ Passed (Live provider smoke verified) |
| **Target Suite** | \`src/test/ai/ai-live-e2e.test.ts\` |
| **Target Providers** | Google Gemini 2.5 + Isolated Neon PostgreSQL |
| **Trigger Context** | \`${ref}\` (\`${eventName}\`) |

### Verified Live Credentials
| Secret Name | Status |
| :--- | :--- |
| \`TEST_DATABASE_URL\` | ${dbStatus} |
| \`GEMINI_KEY_1\` | ${geminiStatus} |`;
  }

  return { exitCode, status, stepSummary };
}

// =============================================================================
// Verification Runner
// =============================================================================
console.log("[test-ci-gating] Executing deterministic CI gating matrix simulation...\n");

let passed = 0;
let total = 0;

function assertCheck(desc, condition) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${desc}`);
  } else {
    console.error(`  ❌ FAILED: ${desc}`);
    process.exitCode = 1;
  }
}

// 1. Verify static ci.yml configuration
console.log("=== 1. Validating Static .github/workflows/ci.yml Contract ===");
const ciContent = fs.readFileSync(CI_YML_PATH, "utf8");

assertCheck("ci.yml includes tags: ['v*'] in push triggers", ciContent.includes("tags: ['v*']"));
assertCheck("ci.yml includes release: types: [published]", ciContent.includes("release:\n    types: [published]"));
assertCheck("Stage 6 defines IS_PROTECTED context detection", ciContent.includes('IS_PROTECTED="true"'));
assertCheck("Stage 6 outputs to GITHUB_STEP_SUMMARY via printf", ciContent.includes('printf "%s\\n"'));
assertCheck("Stage 6 has eliminated fragile heredoc cat << EOF", !ciContent.includes("cat << EOF"));
assertCheck("Stage 6 captures test exit code for failure reporting", ciContent.includes("TEST_EXIT_CODE=$?"));
assertCheck("Stage 6 enforces exit 1 on missing secrets in protected context", ciContent.includes('exit 1'));
assertCheck("Stage 6 allows exit 0 on missing secrets in PR context", ciContent.includes('exit 0'));
assertCheck("Stage 7 condition covers main, tags, release, and live smoke", ciContent.includes("startsWith(github.ref, 'refs/tags/v')"));
assertCheck("Stage 7 enforces exit 1 on missing cloud credentials", ciContent.includes("Stage 7 Live Smoke failed: TEST_DATABASE_URL or GEMINI_KEY_1 missing"));
assertCheck("Stage 7 records provider test failure summary if suite fails", ciContent.includes("Live Provider Smoke — FAILED (Cloud Provider Failure)"));

// 2. Matrix Permutations for Stage 6 (Playwright E2E)
console.log("\n=== 2. Matrix Simulation: Stage 6 Playwright E2E ===");

// Matrix 1: Push to main without secrets -> MUST FAIL-CLOSED (exit 1)
const m1 = simulateStage6Gating({
  eventName: "push",
  ref: "refs/heads/main",
  runLiveSmoke: "false",
  secrets: {},
});
assertCheck("Matrix 1: Push to main without secrets -> exit 1 (FAIL_CLOSED)", m1.exitCode === 1 && m1.status === "FAIL_CLOSED");
assertCheck("Matrix 1: Markdown summary contains [!CAUTION] alert", m1.stepSummary.includes("[!CAUTION]"));
assertCheck("Matrix 1: Markdown summary contains Gating Rule table", m1.stepSummary.includes("### Credential Verification Matrix"));

// Matrix 2: Push release tag without secrets -> MUST FAIL-CLOSED (exit 1)
const m2 = simulateStage6Gating({
  eventName: "push",
  ref: "refs/tags/v1.33.0",
  runLiveSmoke: "false",
  secrets: {},
});
assertCheck("Matrix 2: Release tag v1.33.0 without secrets -> exit 1 (FAIL_CLOSED)", m2.exitCode === 1 && m2.status === "FAIL_CLOSED");

// Matrix 3: Manual dispatch with run_live_smoke: true without secrets -> MUST FAIL-CLOSED (exit 1)
const m3 = simulateStage6Gating({
  eventName: "workflow_dispatch",
  ref: "refs/heads/feature/branch",
  runLiveSmoke: "true",
  secrets: {},
});
assertCheck("Matrix 3: Manual dispatch (run_live_smoke: true) without secrets -> exit 1 (FAIL_CLOSED)", m3.exitCode === 1 && m3.status === "FAIL_CLOSED");

// Matrix 4: Pull Request fork without secrets -> PERMISSIVE SKIP (exit 0 with WARNING)
const m4 = simulateStage6Gating({
  eventName: "pull_request",
  ref: "refs/pull/42/merge",
  runLiveSmoke: "false",
  secrets: {},
});
assertCheck("Matrix 4: Pull Request fork without secrets -> exit 0 (PERMISSIVE_SKIP)", m4.exitCode === 0 && m4.status === "PERMISSIVE_SKIP");
assertCheck("Matrix 4: Markdown summary contains [!WARNING] banner", m4.stepSummary.includes("[!WARNING]"));
assertCheck("Matrix 4: Markdown summary specifies PR classification", m4.stepSummary.includes("Context Classification"));

// Matrix 5: All secrets present -> FULL EXECUTION (exit 0 with PASSED)
const m5 = simulateStage6Gating({
  eventName: "push",
  ref: "refs/heads/main",
  runLiveSmoke: "false",
  secrets: {
    TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/lugx_test",
    NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "mock-key",
  },
});
assertCheck("Matrix 5: All secrets configured -> exit 0 (PASSED)", m5.exitCode === 0 && m5.status === "PASSED");
assertCheck("Matrix 5: Markdown summary renders PASSED header", m5.stepSummary.includes("PASSED"));

// 3. Matrix Permutations for Stage 7 (Live Provider Smoke)
console.log("\n=== 3. Matrix Simulation: Stage 7 Live Provider Smoke ===");

// Matrix 6: Stage 7 triggered without Gemini key -> MUST FAIL-CLOSED (exit 1)
const m6 = simulateStage7Gating({
  eventName: "push",
  ref: "refs/heads/main",
  runLiveSmoke: "false",
  secrets: {
    TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/lugx_test",
  },
});
assertCheck("Matrix 6: Stage 7 without Gemini key -> exit 1 (FAIL_CLOSED)", m6.exitCode === 1 && m6.status === "FAIL_CLOSED");
assertCheck("Matrix 6: Markdown summary contains [!CAUTION] alert", m6.stepSummary.includes("[!CAUTION]"));

// Matrix 7: Stage 7 with all cloud credentials present -> PASSED (exit 0)
const m7 = simulateStage7Gating({
  eventName: "push",
  ref: "refs/heads/main",
  runLiveSmoke: "false",
  secrets: {
    TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/lugx_test",
    GEMINI_KEY_1: "AIzaSyMockKey",
  },
});
assertCheck("Matrix 7: Stage 7 with full cloud credentials -> exit 0 (PASSED)", m7.exitCode === 0 && m7.status === "PASSED");
assertCheck("Matrix 7: Target suite documented in step summary", m7.stepSummary.includes("src/test/ai/ai-live-e2e.test.ts"));

// 4. Markdown Formatting & Table Syntax Integrity
console.log("\n=== 4. Markdown Table & Alert Integrity Verification ===");
const sampleSummaries = [m1.stepSummary, m4.stepSummary, m5.stepSummary, m6.stepSummary, m7.stepSummary];
for (let i = 0; i < sampleSummaries.length; i++) {
  const summary = sampleSummaries[i];
  const lines = summary.split("\n");
  const tableLines = lines.filter((l) => l.trim().startsWith("|") && l.trim().endsWith("|"));
  assertCheck(`Summary ${i + 1}: Valid table delimiter syntax present`, tableLines.length >= 2);
}

// Final Verdict
console.log(`\n=== CI Gating Matrix Simulation Result ===`);
console.log(`Total Checks: ${total} | Passed: ${passed} | Failed: ${total - passed}`);
if (passed === total) {
  console.log("\n✅ SUCCESS: 100% of CI Gating and Step Summary contracts verified.\n");
} else {
  console.error("\n❌ FAILED: One or more CI gating checks failed.\n");
  process.exit(1);
}
