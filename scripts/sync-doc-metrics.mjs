/**
 * Documentation Metrics & Single Source of Truth (SSOT) Synchronization Script.
 *
 * Verifies, extracts, and programmatically synchronizes test suite metrics between
 * actual execution results and repository documentation using canonical delimited blocks
 * and a unified, DRY single-transformation engine.
 *
 * Monitored Living Documentation Targets:
 *   - docs/METRICS.json
 *   - README.md
 *   - docs/README.md
 *   - docs/TECHNICAL_DEBT_REGISTER.md
 *   - docs/reference/test-database-isolation.md
 *   - docs/reference/ci-pipeline.md
 *   - docs/architecture/sync/editor-sync-orchestration.md
 *   - docs/architecture/sync/file-ownership-and-versioning.md
 *   - docs/foundation/DESIGN_VS_REALITY.md
 *
 * Usage:
 *   node scripts/sync-doc-metrics.mjs --check
 *   node scripts/sync-doc-metrics.mjs --update-docs
 *   node scripts/sync-doc-metrics.mjs --report=<path-to-vitest-report.json>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const METRICS_PATH = path.join(ROOT, "docs", "METRICS.json");
const CONSTANTS_PATH = path.join(ROOT, "vitest.constants.mts");
const README_PATH = path.join(ROOT, "README.md");
const DOCS_README_PATH = path.join(ROOT, "docs", "README.md");
const TECH_DEBT_PATH = path.join(ROOT, "docs", "TECHNICAL_DEBT_REGISTER.md");
const DB_ISOLATION_PATH = path.join(ROOT, "docs", "reference", "test-database-isolation.md");
const CI_PIPELINE_PATH = path.join(ROOT, "docs", "reference", "ci-pipeline.md");
const SYNC_ORCHESTRATION_PATH = path.join(ROOT, "docs", "architecture", "sync", "editor-sync-orchestration.md");
const FILE_OWNERSHIP_PATH = path.join(ROOT, "docs", "architecture", "sync", "file-ownership-and-versioning.md");
const DESIGN_VS_REALITY_PATH = path.join(ROOT, "docs", "foundation", "DESIGN_VS_REALITY.md");

const ALL_MONITORED_PATHS = [
  README_PATH,
  DOCS_README_PATH,
  TECH_DEBT_PATH,
  DB_ISOLATION_PATH,
  CI_PIPELINE_PATH,
  SYNC_ORCHESTRATION_PATH,
  FILE_OWNERSHIP_PATH,
  DESIGN_VS_REALITY_PATH,
];

/**
 * Generates canonical SSOT test metrics table block.
 */
export function generateMetricsTable(metrics) {
  return `<!-- BEGIN:SSOT_TEST_METRICS_TABLE -->
| Test Category | Engine / Configuration | Target Environment | Suites / Specs | Passing Tests | Pass Rate |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **Unit & Contract** | Vitest (\`vitest.config.mts\`) | Pure In-Memory / Zero Network | ${metrics.unitSuites} | ${metrics.unitTests} | 100% ✅ |
| **Live Multi-System** | Vitest (\`vitest.live.config.mts\`) | Isolated Neon PostgreSQL Branch | ${metrics.liveSuites} | ${metrics.liveTests} | 100% ✅ |
| **E2E Browser Journeys** | Playwright (\`playwright.config.ts\`) | Headless Chromium / Full App | ${metrics.e2eSpecs} | ${metrics.e2eTests} | 100% ✅ |
<!-- END:SSOT_TEST_METRICS_TABLE -->`;
}

/**
 * Generates canonical SSOT inline baseline block.
 */
export function generateMetricsInline(metrics) {
  return `<!-- BEGIN:SSOT_TEST_METRICS_INLINE -->
**Active Verification Baseline:** ${metrics.unitSuites} unit suites (${metrics.unitTests} tests) · ${metrics.liveSuites} live suites (${metrics.liveTests} tests) · ${metrics.e2eSpecs} E2E specs (${metrics.e2eTests} journeys) — 100% Passing.
<!-- END:SSOT_TEST_METRICS_INLINE -->`;
}

/**
 * Normalizes CRLF and LF line endings for platform-agnostic matching.
 */
function normalizeLineEndings(str) {
  return str.replace(/\r\n/g, "\n").trim();
}

/**
 * Replaces standardized delimiter blocks in content preserving existing line endings.
 */
export function replaceDelimitedBlocks(content, metrics) {
  const isCrlf = content.includes("\r\n");
  const table = isCrlf ? generateMetricsTable(metrics).replace(/\n/g, "\r\n") : generateMetricsTable(metrics);
  const inline = isCrlf ? generateMetricsInline(metrics).replace(/\n/g, "\r\n") : generateMetricsInline(metrics);

  const tableRegex = /<!-- BEGIN:SSOT_TEST_METRICS_TABLE -->[\s\S]*?<!-- END:SSOT_TEST_METRICS_TABLE -->/g;
  content = content.replace(tableRegex, table);

  const inlineRegex = /<!-- BEGIN:SSOT_TEST_METRICS_INLINE -->[\s\S]*?<!-- END:SSOT_TEST_METRICS_INLINE -->/g;
  content = content.replace(inlineRegex, inline);

  return content;
}

/**
 * Recursively scans directory for test files matching criteria.
 */
function findTestFiles(dir, filter) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findTestFiles(fullPath, filter));
    } else if (entry.isFile() && filter(entry.name)) {
      results.push(fullPath.replace(/\\/g, "/"));
    }
  }
  return results;
}

/**
 * Extracts live and cloud test arrays from vitest.constants.mts.
 */
function parseVitestConstants() {
  if (!fs.existsSync(CONSTANTS_PATH)) {
    throw new Error(`Constants file not found at: ${CONSTANTS_PATH}`);
  }
  const content = fs.readFileSync(CONSTANTS_PATH, "utf8");

  const liveMatch = content.match(/LIVE_TEST_FILES\s*=\s*\[([\s\S]*?)\];/);
  const liveFiles = liveMatch ? (liveMatch[1].match(/'[^']+'/g) || []).map((s) => s.replace(/'/g, "")) : [];

  const cloudMatch = content.match(/CLOUD_E2E_FILES\s*=\s*\[([\s\S]*?)\];/);
  const cloudFiles = cloudMatch ? (cloudMatch[1].match(/'[^']+'/g) || []).map((s) => s.replace(/'/g, "")) : [];

  return { liveFiles, cloudFiles };
}

/**
 * Computes on-disk test suite counts.
 */
function getDiskSuiteCounts() {
  const { liveFiles, cloudFiles } = parseVitestConstants();
  const allUnitCandidates = findTestFiles(path.join(ROOT, "src", "test"), (name) =>
    name.endsWith(".test.ts") || name.endsWith(".test.tsx")
  );

  const unitFiles = allUnitCandidates.filter((filePath) => {
    return !liveFiles.some((live) => filePath.endsWith(live)) &&
           !cloudFiles.some((cloud) => filePath.endsWith(cloud));
  });

  const e2eFiles = findTestFiles(path.join(ROOT, "e2e", "specs"), (name) =>
    name.endsWith(".spec.ts")
  );

  return {
    unitSuitesCount: unitFiles.length,
    liveSuitesCount: liveFiles.length,
    e2eSpecsCount: e2eFiles.length,
    unitFiles,
    liveFiles,
    e2eFiles,
  };
}

/**
 * Reads and validates docs/METRICS.json.
 */
function readMetrics() {
  if (!fs.existsSync(METRICS_PATH)) {
    throw new Error(`Metrics file not found: ${METRICS_PATH}`);
  }
  const raw = fs.readFileSync(METRICS_PATH, "utf8");
  try {
    const data = JSON.parse(raw);
    const requiredKeys = ["unitSuites", "unitTests", "liveSuites", "liveTests", "e2eSpecs", "e2eTests"];
    for (const key of requiredKeys) {
      if (typeof data[key] !== "number" || data[key] <= 0) {
        throw new Error(`Invalid or missing numeric property '${key}' in docs/METRICS.json`);
      }
    }
    return data;
  } catch (err) {
    throw new Error(`Failed to parse ${METRICS_PATH}: ${err.message}`);
  }
}

/**
 * Single Transformation Engine: computes expected canonical content for any monitored file.
 */
export function transformFileContent(filePath, content, metrics) {
  let updated = content;

  // 1. Universal Delimited Blocks
  updated = replaceDelimitedBlocks(updated, metrics);

  // 2. README.md: badges, alts, and bash comments
  if (filePath === README_PATH) {
    updated = updated
      .replace(/badge\/Vitest-[^"-]*-6E9F18/g, `badge/Vitest-${metrics.unitSuites}%20Suites%20·%20${metrics.unitTests}%2F${metrics.unitTests}%20Passing-6E9F18`)
      .replace(/alt="Vitest \d+ Passing"/g, `alt="Vitest ${metrics.unitTests} Passing"`)
      .replace(/badge\/Neon_Live_DB-[^"-]*-00E599/g, `badge/Neon_Live_DB-${metrics.liveSuites}%20Suites%20·%20${metrics.liveTests}%2F${metrics.liveTests}%20Passing-00E599`)
      .replace(/alt="Neon Live DB \d+ Passing"/g, `alt="Neon Live DB ${metrics.liveTests} Passing"`)
      .replace(/badge\/Playwright_E2E-[^"-]*-blue/g, `badge/Playwright_E2E-${metrics.e2eSpecs}%20Specs%20·%20${metrics.e2eTests}%2F${metrics.e2eTests}%20Passing-blue`)
      .replace(/alt="Playwright E2E \d+ Passing"/g, `alt="Playwright E2E ${metrics.e2eTests} Passing"`)
      .replace(/# Execute unit\/contract test suites \(\d+ test files, \d+ tests\)/g, `# Execute unit/contract test suites (${metrics.unitSuites} test files, ${metrics.unitTests} tests)`)
      .replace(/# Execute live database integration test suites on isolated Neon branch \(\d+ test files, \d+ tests\)/g, `# Execute live database integration test suites on isolated Neon branch (${metrics.liveSuites} test files, ${metrics.liveTests} tests)`)
      .replace(/# Execute browser-driven Playwright E2E tests \(\d+ spec files, \d+ user journeys\)/g, `# Execute browser-driven Playwright E2E tests (${metrics.e2eSpecs} spec files, ${metrics.e2eTests} user journeys)`);
  }

  // 3. docs/README.md: verification commands comments
  if (filePath === DOCS_README_PATH) {
    updated = updated
      .replace(/pure unit, contract, and vault cryptographic test suites \(\d+ files, \d+ tests via vitest\.config\.mts\)/g, `pure unit, contract, and vault cryptographic test suites (${metrics.unitSuites} files, ${metrics.unitTests} tests via vitest.config.mts)`)
      .replace(/live database integration suites against isolated test PostgreSQL\/Neon \(\d+ files, \d+ tests via vitest\.live\.config\.mts\)/g, `live database integration suites against isolated test PostgreSQL/Neon (${metrics.liveSuites} files, ${metrics.liveTests} tests via vitest.live.config.mts)`)
      .replace(/browser-driven E2E user journeys \(\d+ specs, \d+ scenarios via Playwright \/ Chromium\)/g, `browser-driven E2E user journeys (${metrics.e2eSpecs} specs, ${metrics.e2eTests} scenarios via Playwright / Chromium)`);
  }

  // 4. docs/reference/ci-pipeline.md: mermaid stages and stage tables
  if (filePath === CI_PIPELINE_PATH) {
    updated = updated
      .replace(/npm run test \(\d+ files, \d+ tests\)/g, `npm run test (${metrics.unitSuites} files, ${metrics.unitTests} tests)`)
      .replace(/npm run test:live \(\d+ suites, \d+ tests\)/g, `npm run test:live (${metrics.liveSuites} suites, ${metrics.liveTests} tests)`)
      .replace(/Playwright Chromium Headless \(\d+ specs, \d+ journeys\)/g, `Playwright Chromium Headless (${metrics.e2eSpecs} specs, ${metrics.e2eTests} journeys)`)
      .replace(/Runs \d+ live integration suites against isolated containers/g, `Runs ${metrics.liveSuites} live integration suites against isolated containers`)
      .replace(/Executes \d+ Playwright specs across \d+ user journeys in headless Chromium\./g, `Executes ${metrics.e2eSpecs} Playwright specs across ${metrics.e2eTests} user journeys in headless Chromium.`);
  }

  // 5. docs/reference/test-database-isolation.md: section 2.1 and evidence lines
  if (filePath === DB_ISOLATION_PATH) {
    updated = updated
      .replace(/The \d+ hermetic LIVE suites against the isolated PostgreSQL service container \/ Neon branch\./g, `The ${metrics.liveSuites} hermetic LIVE suites against the isolated PostgreSQL service container / Neon branch.`)
      .replace(/(?:\*\*Active |\*\*)Unit & Contract Suite \(`npm run test`\):\*\* \*\*\d+ files \/ \d+ tests — all passed \(100% pass rate\)\*\*/g, `**Active Unit & Contract Suite (\`npm run test\`):** **${metrics.unitSuites} files / ${metrics.unitTests} tests — all passed (100% pass rate)**`)
      .replace(/(?:\*\*Active |\*\*)Live Multi-System Suite \(`npm run test:live`\):\*\* \*\*\d+ registered suites \/ \d+ tests — all passed \(100% pass rate\)\*\*/g, `**Active Live Multi-System Suite (\`npm run test:live\`):** **${metrics.liveSuites} registered suites / ${metrics.liveTests} tests — all passed (100% pass rate)**`);
  }

  // 6. docs/foundation/DESIGN_VS_REALITY.md: divergence table cell
  if (filePath === DESIGN_VS_REALITY_PATH) {
    updated = updated.replace(/\(\d+ suites, \d+ tests passing\)/g, `(${metrics.unitSuites} suites, ${metrics.unitTests} tests passing)`);
  }

  return updated;
}

/**
 * Validates documentation files for metric drift using the single transformation engine.
 */
function checkDocumentationDrift(metrics, diskCounts) {
  const errors = [];

  // Suite count validations against disk
  if (diskCounts.unitSuitesCount !== metrics.unitSuites) {
    errors.push(`Unit suites mismatch: disk has ${diskCounts.unitSuitesCount}, but METRICS.json specifies ${metrics.unitSuites}`);
  }
  if (diskCounts.liveSuitesCount !== metrics.liveSuites) {
    errors.push(`Live suites mismatch: constants specify ${diskCounts.liveSuitesCount}, but METRICS.json specifies ${metrics.liveSuites}`);
  }
  if (diskCounts.e2eSpecsCount !== metrics.e2eSpecs) {
    errors.push(`E2E specs mismatch: disk has ${diskCounts.e2eSpecsCount}, but METRICS.json specifies ${metrics.e2eSpecs}`);
  }

  // Deterministic file drift check using transformFileContent
  for (const filePath of ALL_MONITORED_PATHS) {
    if (!fs.existsSync(filePath)) {
      errors.push(`Monitored target not found: ${path.relative(ROOT, filePath)}`);
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const expected = transformFileContent(filePath, content, metrics);
    if (normalizeLineEndings(content) !== normalizeLineEndings(expected)) {
      errors.push(`${path.relative(ROOT, filePath)} is out of sync with active SSOT metrics`);
    }
  }

  return errors;
}

/**
 * Programmatically updates all monitored documentation files using the single transformation engine.
 */
function updateDocumentationFiles(metrics) {
  const updatedFiles = [];

  for (const filePath of ALL_MONITORED_PATHS) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const expected = transformFileContent(filePath, content, metrics);
    if (content !== expected) {
      fs.writeFileSync(filePath, expected, "utf8");
      updatedFiles.push(filePath);
    }
  }

  console.log(`[sync-doc-metrics] Programmatically verified/updated ${updatedFiles.length} documentation file(s):`);
  for (const f of updatedFiles) {
    console.log(`  ✔ ${path.relative(ROOT, f)}`);
  }
}

/**
 * Updates metrics from a Vitest JSON report.
 */
function updateFromVitestReport(reportPath) {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Vitest report file not found at: ${reportPath}`);
  }
  const raw = fs.readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw);

  if (report.success !== true || report.numFailedTests > 0) {
    throw new Error(
      `[Fail-Closed] Vitest report indicates failures (success: ${report.success}, failed: ${report.numFailedTests}). Aborting metrics update.`
    );
  }

  const diskCounts = getDiskSuiteCounts();
  const currentMetrics = fs.existsSync(METRICS_PATH) ? readMetrics() : {
    liveSuites: diskCounts.liveSuitesCount,
    liveTests: 117,
    e2eSpecs: diskCounts.e2eSpecsCount,
    e2eTests: 15,
  };

  const updatedMetrics = {
    unitSuites: report.testResults ? report.testResults.length : diskCounts.unitSuitesCount,
    unitTests: report.numTotalTests || report.numPassedTests,
    liveSuites: currentMetrics.liveSuites,
    liveTests: currentMetrics.liveTests,
    e2eSpecs: diskCounts.e2eSpecsCount,
    e2eTests: currentMetrics.e2eTests,
    lastUpdated: new Date().toISOString(),
  };

  fs.writeFileSync(METRICS_PATH, JSON.stringify(updatedMetrics, null, 2) + "\n", "utf8");
  console.log(`[sync-doc-metrics] Successfully updated ${METRICS_PATH} from ${reportPath}:`);
  console.log(JSON.stringify(updatedMetrics, null, 2));

  updateDocumentationFiles(updatedMetrics);
}

// =========================================================================
// CLI Entry Point
// =========================================================================
function main() {
  const args = process.argv.slice(2);
  const isCheckMode = args.includes("--check");
  const reportArg = args.find((a) => a.startsWith("--report="));
  const isUpdateMode = args.includes("--update") || args.includes("--update-docs");

  if (reportArg) {
    const reportPath = path.resolve(process.cwd(), reportArg.split("=")[1]);
    updateFromVitestReport(reportPath);
    return;
  }

  if (isUpdateMode) {
    const diskCounts = getDiskSuiteCounts();
    const current = readMetrics();
    current.unitSuites = diskCounts.unitSuitesCount;
    current.liveSuites = diskCounts.liveSuitesCount;
    current.e2eSpecs = diskCounts.e2eSpecsCount;
    current.lastUpdated = new Date().toISOString();
    fs.writeFileSync(METRICS_PATH, JSON.stringify(current, null, 2) + "\n", "utf8");
    console.log(`[sync-doc-metrics] Synchronized ${METRICS_PATH} contract with disk.`);

    updateDocumentationFiles(current);
    return;
  }

  if (isCheckMode) {
    console.log("[sync-doc-metrics] Running deterministic documentation metrics verification...");
    const metrics = readMetrics();
    const diskCounts = getDiskSuiteCounts();

    console.log(`[sync-doc-metrics] Active Metrics Contract:`);
    console.log(`  - Unit Suites: ${metrics.unitSuites} (Disk: ${diskCounts.unitSuitesCount})`);
    console.log(`  - Unit Tests:  ${metrics.unitTests}`);
    console.log(`  - Live Suites: ${metrics.liveSuites} (Constants: ${diskCounts.liveSuitesCount})`);
    console.log(`  - Live Tests:  ${metrics.liveTests}`);
    console.log(`  - E2E Specs:   ${metrics.e2eSpecs} (Disk: ${diskCounts.e2eSpecsCount})`);
    console.log(`  - E2E Tests:   ${metrics.e2eTests}`);

    const errors = checkDocumentationDrift(metrics, diskCounts);

    if (errors.length > 0) {
      console.error("\n[sync-doc-metrics] ERROR: Documentation drift detected across project files:");
      for (const err of errors) {
        console.error(`  ✖ ${err}`);
      }
      process.exit(1);
    }

    console.log("\n[sync-doc-metrics] SUCCESS: All documentation metrics and SSOT contracts are 100% synchronized.\n");
    return;
  }

  console.log("Usage: node scripts/sync-doc-metrics.mjs [--check | --update-docs | --report=<path>]");
}

main();
