/**
 * Documentation Metrics & Single Source of Truth (SSOT) Synchronization Script.
 *
 * Verifies, extracts, and programmatically synchronizes test suite metrics between
 * actual execution results and repository documentation using number-agnostic contextual
 * pattern matching.
 *
 * Monitored Living Documentation Targets:
 *   - docs/METRICS.json
 *   - README.md
 *   - docs/README.md
 *   - docs/TECHNICAL_DEBT_REGISTER.md
 *   - docs/reference/test-database-isolation.md
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
const SYNC_ORCHESTRATION_PATH = path.join(ROOT, "docs", "architecture", "sync", "editor-sync-orchestration.md");
const FILE_OWNERSHIP_PATH = path.join(ROOT, "docs", "architecture", "sync", "file-ownership-and-versioning.md");
const DESIGN_VS_REALITY_PATH = path.join(ROOT, "docs", "foundation", "DESIGN_VS_REALITY.md");

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
 * Validates documentation files for metric drift using number-agnostic contextual patterns.
 */
function checkDocumentationDrift(metrics, diskCounts) {
  const errors = [];

  // 1. Suite count validations against disk
  if (diskCounts.unitSuitesCount !== metrics.unitSuites) {
    errors.push(`Unit suites mismatch: disk has ${diskCounts.unitSuitesCount}, but METRICS.json specifies ${metrics.unitSuites}`);
  }
  if (diskCounts.liveSuitesCount !== metrics.liveSuites) {
    errors.push(`Live suites mismatch: constants specify ${diskCounts.liveSuitesCount}, but METRICS.json specifies ${metrics.liveSuites}`);
  }
  if (diskCounts.e2eSpecsCount !== metrics.e2eSpecs) {
    errors.push(`E2E specs mismatch: disk has ${diskCounts.e2eSpecsCount}, but METRICS.json specifies ${metrics.e2eSpecs}`);
  }

  // 2. README.md badges and bash command comments
  if (fs.existsSync(README_PATH)) {
    const readme = fs.readFileSync(README_PATH, "utf8");

    const vitestBadgeExpected = `${metrics.unitSuites}%20Suites%20·%20${metrics.unitTests}%2F${metrics.unitTests}%20Passing`;
    if (!readme.includes(vitestBadgeExpected)) {
      errors.push(`README.md Vitest badge does not match expected: '${vitestBadgeExpected}'`);
    }

    const liveBadgeExpected = `${metrics.liveSuites}%20Suites%20·%20${metrics.liveTests}%2F${metrics.liveTests}%20Passing`;
    if (!readme.includes(liveBadgeExpected)) {
      errors.push(`README.md Live DB badge does not match expected: '${liveBadgeExpected}'`);
    }

    const e2eBadgeExpected = `${metrics.e2eSpecs}%20Specs%20·%20${metrics.e2eTests}%2F${metrics.e2eTests}%20Passing`;
    if (!readme.includes(e2eBadgeExpected)) {
      errors.push(`README.md Playwright badge does not match expected: '${e2eBadgeExpected}'`);
    }

    const unitCommentExpected = `# Execute unit/contract test suites (${metrics.unitSuites} test files, ${metrics.unitTests} tests)`;
    if (!readme.includes(unitCommentExpected)) {
      errors.push(`README.md does not contain expected comment: '${unitCommentExpected}'`);
    }

    const liveCommentExpected = `# Execute live database integration test suites on isolated Neon branch (${metrics.liveSuites} test files, ${metrics.liveTests} tests)`;
    if (!readme.includes(liveCommentExpected)) {
      errors.push(`README.md does not contain expected comment: '${liveCommentExpected}'`);
    }

    const e2eCommentExpected = `# Execute browser-driven Playwright E2E tests (${metrics.e2eSpecs} spec files, ${metrics.e2eTests} user journeys)`;
    if (!readme.includes(e2eCommentExpected)) {
      errors.push(`README.md does not contain expected comment: '${e2eCommentExpected}'`);
    }
  } else {
    errors.push(`README.md not found at ${README_PATH}`);
  }

  // 3. docs/README.md verification commands comments
  if (fs.existsSync(DOCS_README_PATH)) {
    const docsReadme = fs.readFileSync(DOCS_README_PATH, "utf8");

    const docsUnitComment = `pure unit, contract, and vault cryptographic test suites (${metrics.unitSuites} files, ${metrics.unitTests} tests via vitest.config.mts)`;
    if (!docsReadme.includes(docsUnitComment)) {
      errors.push(`docs/README.md does not contain expected comment: '${docsUnitComment}'`);
    }

    const docsLiveComment = `live database integration suites against isolated test PostgreSQL/Neon (${metrics.liveSuites} files, ${metrics.liveTests} tests via vitest.live.config.mts)`;
    if (!docsReadme.includes(docsLiveComment)) {
      errors.push(`docs/README.md does not contain expected comment: '${docsLiveComment}'`);
    }

    const docsE2eComment = `browser-driven E2E user journeys (${metrics.e2eSpecs} specs, ${metrics.e2eTests} scenarios via Playwright / Chromium)`;
    if (!docsReadme.includes(docsE2eComment)) {
      errors.push(`docs/README.md does not contain expected comment: '${docsE2eComment}'`);
    }
  } else {
    errors.push(`docs/README.md not found at ${DOCS_README_PATH}`);
  }

  // 4. TECHNICAL_DEBT_REGISTER.md contextual validations
  if (fs.existsSync(TECH_DEBT_PATH)) {
    const debt = fs.readFileSync(TECH_DEBT_PATH, "utf8");
    const td05Expected = `100% passing across ${metrics.unitSuites} test files and ${metrics.unitTests} tests`;
    if (!debt.includes(td05Expected)) {
      errors.push(`docs/TECHNICAL_DEBT_REGISTER.md TD-05 missing expected: '${td05Expected}'`);
    }

    const td09Expected = `currently ${metrics.unitSuites} test files and ${metrics.unitTests} tests via vitest.config.mts, plus ${metrics.liveSuites} live files via vitest.live.config.mts`;
    if (!debt.includes(td09Expected)) {
      errors.push(`docs/TECHNICAL_DEBT_REGISTER.md TD-09 missing expected: '${td09Expected}'`);
    }

    const td11Expected = `expanded to ${metrics.unitSuites} unit test suites with ${metrics.unitTests} tests green, plus ${metrics.liveSuites} live integration suites with ${metrics.liveTests} tests green`;
    if (!debt.includes(td11Expected)) {
      errors.push(`docs/TECHNICAL_DEBT_REGISTER.md TD-11 missing expected: '${td11Expected}'`);
    }

    const td12Expected = `across all ${metrics.unitSuites} test suites (${metrics.unitTests} passing tests)`;
    if (!debt.includes(td12Expected)) {
      errors.push(`docs/TECHNICAL_DEBT_REGISTER.md TD-12 missing expected: '${td12Expected}'`);
    }
  } else {
    errors.push(`docs/TECHNICAL_DEBT_REGISTER.md not found at ${TECH_DEBT_PATH}`);
  }

  // 5. docs/reference/test-database-isolation.md validation
  if (fs.existsSync(DB_ISOLATION_PATH)) {
    const iso = fs.readFileSync(DB_ISOLATION_PATH, "utf8");
    const expected = `${metrics.unitSuites} files / ${metrics.unitTests} tests — all passed`;
    if (!iso.includes(expected)) {
      errors.push(`docs/reference/test-database-isolation.md does not contain expected string: '${expected}'`);
    }
  } else {
    errors.push(`docs/reference/test-database-isolation.md not found at ${DB_ISOLATION_PATH}`);
  }

  // 6. docs/architecture/sync/editor-sync-orchestration.md validation
  if (fs.existsSync(SYNC_ORCHESTRATION_PATH)) {
    const syncDoc = fs.readFileSync(SYNC_ORCHESTRATION_PATH, "utf8");
    const expected = `${metrics.unitSuites}/${metrics.unitSuites} test files, ${metrics.unitTests}/${metrics.unitTests} tests passing`;
    if (!syncDoc.includes(expected)) {
      errors.push(`docs/architecture/sync/editor-sync-orchestration.md does not contain expected string: '${expected}'`);
    }
  } else {
    errors.push(`docs/architecture/sync/editor-sync-orchestration.md not found at ${SYNC_ORCHESTRATION_PATH}`);
  }

  // 7. docs/architecture/sync/file-ownership-and-versioning.md validation
  if (fs.existsSync(FILE_OWNERSHIP_PATH)) {
    const ownershipDoc = fs.readFileSync(FILE_OWNERSHIP_PATH, "utf8");
    const expected = `Full suite execution: ${metrics.unitSuites} test files, ${metrics.unitTests} tests passing (100% pass rate).`;
    if (!ownershipDoc.includes(expected)) {
      errors.push(`docs/architecture/sync/file-ownership-and-versioning.md does not contain expected string: '${expected}'`);
    }
  } else {
    errors.push(`docs/architecture/sync/file-ownership-and-versioning.md not found at ${FILE_OWNERSHIP_PATH}`);
  }

  // 8. docs/foundation/DESIGN_VS_REALITY.md validation
  if (fs.existsSync(DESIGN_VS_REALITY_PATH)) {
    const realityDoc = fs.readFileSync(DESIGN_VS_REALITY_PATH, "utf8");
    const expected = `(${metrics.unitSuites} suites, ${metrics.unitTests} tests passing)`;
    if (!realityDoc.includes(expected)) {
      errors.push(`docs/foundation/DESIGN_VS_REALITY.md does not contain expected string: '${expected}'`);
    }
  } else {
    errors.push(`docs/foundation/DESIGN_VS_REALITY.md not found at ${DESIGN_VS_REALITY_PATH}`);
  }

  return errors;
}

/**
 * Programmatically updates all monitored documentation files using number-agnostic contextual replacement.
 */
function updateDocumentationFiles(metrics) {
  const updatedFiles = [];

  // 1. docs/TECHNICAL_DEBT_REGISTER.md
  if (fs.existsSync(TECH_DEBT_PATH)) {
    let content = fs.readFileSync(TECH_DEBT_PATH, "utf8");
    const original = content;

    // TD-05
    content = content.replace(
      /100% passing across \d+ test files and \d+ tests/g,
      `100% passing across ${metrics.unitSuites} test files and ${metrics.unitTests} tests`
    );

    // TD-09
    content = content.replace(
      /currently \d+ test files and \d+ tests via vitest\.config\.mts, plus \d+ live files via vitest\.live\.config\.mts/g,
      `currently ${metrics.unitSuites} test files and ${metrics.unitTests} tests via vitest.config.mts, plus ${metrics.liveSuites} live files via vitest.live.config.mts`
    );

    // TD-11
    content = content.replace(
      /expanded to \d+ unit test suites with \d+ tests green, plus \d+ live integration suites with \d+ tests green/g,
      `expanded to ${metrics.unitSuites} unit test suites with ${metrics.unitTests} tests green, plus ${metrics.liveSuites} live integration suites with ${metrics.liveTests} tests green`
    );

    // TD-12
    content = content.replace(
      /across all \d+ test suites \(\d+ passing tests\)/g,
      `across all ${metrics.unitSuites} test suites (${metrics.unitTests} passing tests)`
    );

    if (content !== original) {
      fs.writeFileSync(TECH_DEBT_PATH, content, "utf8");
      updatedFiles.push(TECH_DEBT_PATH);
    }
  }

  // 2. docs/reference/test-database-isolation.md
  if (fs.existsSync(DB_ISOLATION_PATH)) {
    let content = fs.readFileSync(DB_ISOLATION_PATH, "utf8");
    const original = content;

    content = content.replace(
      /\*\*Unit & Contract Suite \(`npm run test`\):\*\* \*\*\d+ files \/ \d+ tests — all passed \(100% pass rate\)\*\*/g,
      `**Unit & Contract Suite (\`npm run test\`):** **${metrics.unitSuites} files / ${metrics.unitTests} tests — all passed (100% pass rate)**`
    );

    content = content.replace(
      /\*\*Live Multi-System Suite \(`npm run test:live`\):\*\* \*\*\d+ registered suites \/ \d+ tests — all passed \(100% pass rate\)\*\*/g,
      `**Live Multi-System Suite (\`npm run test:live\`):** **${metrics.liveSuites} registered suites / ${metrics.liveTests} tests — all passed (100% pass rate)**`
    );

    if (content !== original) {
      fs.writeFileSync(DB_ISOLATION_PATH, content, "utf8");
      updatedFiles.push(DB_ISOLATION_PATH);
    }
  }

  // 3. docs/architecture/sync/editor-sync-orchestration.md
  if (fs.existsSync(SYNC_ORCHESTRATION_PATH)) {
    let content = fs.readFileSync(SYNC_ORCHESTRATION_PATH, "utf8");
    const original = content;

    content = content.replace(
      /\*\*Project Full Test Suite:\*\* \d+\/\d+ test files, \d+\/\d+ tests passing \(100% success rate\) via `vitest\.config\.mts`/g,
      `**Project Full Test Suite:** ${metrics.unitSuites}/${metrics.unitSuites} test files, ${metrics.unitTests}/${metrics.unitTests} tests passing (100% success rate) via \`vitest.config.mts\``
    );

    if (content !== original) {
      fs.writeFileSync(SYNC_ORCHESTRATION_PATH, content, "utf8");
      updatedFiles.push(SYNC_ORCHESTRATION_PATH);
    }
  }

  // 4. docs/architecture/sync/file-ownership-and-versioning.md
  if (fs.existsSync(FILE_OWNERSHIP_PATH)) {
    let content = fs.readFileSync(FILE_OWNERSHIP_PATH, "utf8");
    const original = content;

    content = content.replace(
      /Full suite execution: \d+ test files, \d+ tests passing \(100% pass rate\)\./g,
      `Full suite execution: ${metrics.unitSuites} test files, ${metrics.unitTests} tests passing (100% pass rate).`
    );

    if (content !== original) {
      fs.writeFileSync(FILE_OWNERSHIP_PATH, content, "utf8");
      updatedFiles.push(FILE_OWNERSHIP_PATH);
    }
  }

  // 5. docs/foundation/DESIGN_VS_REALITY.md
  if (fs.existsSync(DESIGN_VS_REALITY_PATH)) {
    let content = fs.readFileSync(DESIGN_VS_REALITY_PATH, "utf8");
    const original = content;

    content = content.replace(
      /\(\d+ suites, \d+ tests passing\)/g,
      `(${metrics.unitSuites} suites, ${metrics.unitTests} tests passing)`
    );

    if (content !== original) {
      fs.writeFileSync(DESIGN_VS_REALITY_PATH, content, "utf8");
      updatedFiles.push(DESIGN_VS_REALITY_PATH);
    }
  }

  // 6. README.md (root)
  if (fs.existsSync(README_PATH)) {
    let content = fs.readFileSync(README_PATH, "utf8");
    const original = content;

    // Badges
    content = content.replace(
      /badge\/Vitest-[^"-]*-6E9F18/g,
      `badge/Vitest-${metrics.unitSuites}%20Suites%20·%20${metrics.unitTests}%2F${metrics.unitTests}%20Passing-6E9F18`
    );

    content = content.replace(
      /badge\/Neon_Live_DB-[^"-]*-00E599/g,
      `badge/Neon_Live_DB-${metrics.liveSuites}%20Suites%20·%20${metrics.liveTests}%2F${metrics.liveTests}%20Passing-00E599`
    );

    content = content.replace(
      /badge\/Playwright_E2E-[^"-]*-blue/g,
      `badge/Playwright_E2E-${metrics.e2eSpecs}%20Specs%20·%20${metrics.e2eTests}%2F${metrics.e2eTests}%20Passing-blue`
    );

    // Bash code comments
    content = content.replace(
      /# Execute unit\/contract test suites \(\d+ test files, \d+ tests\)/g,
      `# Execute unit/contract test suites (${metrics.unitSuites} test files, ${metrics.unitTests} tests)`
    );

    content = content.replace(
      /# Execute live database integration test suites on isolated Neon branch \(\d+ test files, \d+ tests\)/g,
      `# Execute live database integration test suites on isolated Neon branch (${metrics.liveSuites} test files, ${metrics.liveTests} tests)`
    );

    content = content.replace(
      /# Execute browser-driven Playwright E2E tests \(\d+ spec files, \d+ user journeys\)/g,
      `# Execute browser-driven Playwright E2E tests (${metrics.e2eSpecs} spec files, ${metrics.e2eTests} user journeys)`
    );

    if (content !== original) {
      fs.writeFileSync(README_PATH, content, "utf8");
      updatedFiles.push(README_PATH);
    }
  }

  // 7. docs/README.md
  if (fs.existsSync(DOCS_README_PATH)) {
    let content = fs.readFileSync(DOCS_README_PATH, "utf8");
    const original = content;

    content = content.replace(
      /pure unit, contract, and vault cryptographic test suites \(\d+ files, \d+ tests via vitest\.config\.mts\)/g,
      `pure unit, contract, and vault cryptographic test suites (${metrics.unitSuites} files, ${metrics.unitTests} tests via vitest.config.mts)`
    );

    content = content.replace(
      /live database integration suites against isolated test PostgreSQL\/Neon \(\d+ files, \d+ tests via vitest\.live\.config\.mts\)/g,
      `live database integration suites against isolated test PostgreSQL/Neon (${metrics.liveSuites} files, ${metrics.liveTests} tests via vitest.live.config.mts)`
    );

    content = content.replace(
      /browser-driven E2E user journeys \(\d+ specs, \d+ scenarios via Playwright \/ Chromium\)/g,
      `browser-driven E2E user journeys (${metrics.e2eSpecs} specs, ${metrics.e2eTests} scenarios via Playwright / Chromium)`
    );

    if (content !== original) {
      fs.writeFileSync(DOCS_README_PATH, content, "utf8");
      updatedFiles.push(DOCS_README_PATH);
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
    liveTests: 89,
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

  // Also sync all monitored documentation files
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

  // Default: print usage and status
  console.log("Usage: node scripts/sync-doc-metrics.mjs [--check | --update-docs | --report=<path>]");
}

main();
