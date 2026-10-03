#!/usr/bin/env node
/**
 * scripts/ci-audit.mjs
 *
 * Deterministic Dependency Security Audit Gate for CI.
 * Enforces zero-tolerance fail-closed policy on production dependencies while
 * supporting a developer-managed allowlist for unpatched latent advisories
 * strictly isolated within the development toolchain (e.g. TD-15).
 *
 * Usage:
 *   node scripts/ci-audit.mjs
 */

import { execSync } from "node:child_process";

// =============================================================================
// Developer-Managed Allowlist (Project Owner & Sole Developer Authority)
// =============================================================================
/**
 * Known, audited, latent upstream advisories permitted exclusively in devDependencies.
 * Each entry must be documented in docs/TECHNICAL_DEBT_REGISTER.md.
 */
const ALLOWLIST = new Map([
  [
    "GHSA-VFJ7-8CJW-P6XM",
    {
      cve: "CVE-2026-93687",
      package: "braces",
      severity: "high",
      scope: "dev", // Strictly prohibited from production runtime
      debtId: "TD-15",
      reason:
        "Uncontrolled AST recursion DoS in dev linter dependency chain; no official npm patch published yet; zero production attack surface.",
    },
  ],
]);

// =============================================================================
// Helper Functions
// =============================================================================
function runAuditJson(args = "") {
  try {
    const raw = execSync(`npm audit --json ${args}`.trim(), {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch (error) {
    // npm audit exits with 1 when vulnerabilities exist; stdout contains the JSON payload
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout.toString());
      } catch {
        // Fallback below
      }
    }
    throw new Error(`Failed to execute or parse npm audit: ${error.message}`);
  }
}

function extractRootAdvisories(auditReport) {
  const advisories = new Map();
  const vulnerabilities = auditReport?.vulnerabilities || {};

  for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
    const viaList = Array.isArray(vuln.via) ? vuln.via : [];
    for (const item of viaList) {
      if (typeof item === "object" && item !== null) {
        const ghsaMatch = item.url?.match(/GHSA-[a-z0-9-]+/i);
        const id = ghsaMatch ? ghsaMatch[0].toUpperCase() : String(item.source || item.name || pkgName).toUpperCase();
        if (!advisories.has(id)) {
          advisories.set(id, {
            id,
            package: item.name || pkgName,
            title: item.title || "Unknown advisory",
            url: item.url || "",
            severity: item.severity || vuln.severity || "unknown",
            range: item.range || vuln.range || "*",
          });
        }
      }
    }
  }

  return advisories;
}

// =============================================================================
// Main Execution Gate
// =============================================================================
console.log("=== LUGX Dependency Security Audit Gate ===");
console.log("[ci-audit] Executing deterministic security audit scan...\n");

// 1. Strict Fail-Closed Check on Production Runtime
console.log("Step 1: Auditing production runtime dependencies (--omit=dev)...");
const prodReport = runAuditJson("--omit=dev");
const prodAdvisories = extractRootAdvisories(prodReport);
const prodTotal = prodReport?.metadata?.vulnerabilities?.total || 0;

if (prodTotal > 0 || prodAdvisories.size > 0) {
  console.error("\n❌ FATAL: Vulnerabilities detected in PRODUCTION runtime dependencies!");
  console.error("Zero-tolerance policy violated. Production runtime must be 100% clean.\n");
  for (const [id, adv] of prodAdvisories) {
    console.error(`  - [${adv.severity.toUpperCase()}] ${adv.package} (${id}): ${adv.title}`);
    console.error(`    URL: ${adv.url}`);
  }
  process.exit(1);
}
console.log("  ✅ Production runtime dependencies: 0 vulnerabilities found.\n");

// 2. Comprehensive Check (Production + Development)
console.log("Step 2: Auditing full dependency tree (including devDependencies)...");
const fullReport = runAuditJson("");
const allAdvisories = extractRootAdvisories(fullReport);

const unapprovedAdvisories = [];
const approvedAdvisories = [];

for (const [id, adv] of allAdvisories) {
  const normalizedId = id.toUpperCase();
  const allowEntry = ALLOWLIST.get(normalizedId);

  if (allowEntry) {
    approvedAdvisories.push({ adv, allowEntry });
  } else {
    unapprovedAdvisories.push(adv);
  }
}

// 3. Verification of Results
if (unapprovedAdvisories.length > 0) {
  console.error(`\n❌ AUDIT FAILED: Found ${unapprovedAdvisories.length} unapproved vulnerability/vulnerabilities:\n`);
  for (const adv of unapprovedAdvisories) {
    console.error(`  - [${adv.severity.toUpperCase()}] Package: ${adv.package}`);
    console.error(`    Advisory: ${adv.id} (${adv.title})`);
    console.error(`    Affected Range: ${adv.range}`);
    console.error(`    Reference: ${adv.url}\n`);
  }
  console.error("Action Required: Remediate the dependency, or register it in ALLOWLIST with project owner approval.\n");
  process.exit(1);
}

if (approvedAdvisories.length > 0) {
  console.log(`⚠️  NOTICE: ${approvedAdvisories.length} approved latent advisory/advisories active in devDependencies:\n`);
  for (const { adv, allowEntry } of approvedAdvisories) {
    console.log(`  - [APPROVED] ${adv.package} -> ${adv.id} (${allowEntry.debtId})`);
    console.log(`    Severity: ${adv.severity.toUpperCase()} | Scope: ${allowEntry.scope}`);
    console.log(`    Reason: ${allowEntry.reason}`);
    console.log(`    Reference: ${adv.url}\n`);
  }
} else {
  console.log("  ✅ Full dependency tree: 0 vulnerabilities detected.\n");
}

console.log("✅ SUCCESS: Dependency Security Audit passed all gating criteria.");
process.exit(0);
