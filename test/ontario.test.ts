import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkJurisdiction } from "../src/jurisdiction.ts";
import type { PayRange, Posting } from "../src/model.ts";
import type { OntarioManifest, OntarioReport } from "../src/rules/ontario.ts";
import {
  COMPENSATION_MISSING,
  ONTARIO_RULES,
  RANGE_TOO_WIDE,
  VACANCY_NOT_STATED,
  checkOntario,
} from "../src/rules/ontario.ts";
import type { Rule } from "../src/rules/registry.ts";
import { RULES, registryProblems, ruleProblems, severityOf } from "../src/rules/registry.ts";
import { isAllowedSourceUrl } from "../src/rules/sources.ts";

const CAD_YEAR: PayRange = {
  min: 100000,
  max: 150000,
  currency: "CAD",
  period: "YEAR",
  stated: "$100,000 - $150,000 per year",
};

const POSTING: Posting = {
  visibleText: "Acme Robotics is hiring a Staff Engineer in Toronto. Apply at jobs.example.com.",
  datePosted: "2026-02-01",
  existingVacancy: true,
  payRange: CAD_YEAR,
};

const SILENT: Posting = { ...POSTING, payRange: undefined, existingVacancy: undefined };

const EMPLOYER: OntarioManifest = { employerHeadcount: 40 };

function reportFor(payRange: PayRange | undefined, manifest: OntarioManifest = EMPLOYER): OntarioReport {
  return checkOntario({ ...POSTING, payRange }, manifest, "2026-02-01");
}

function ruleIds(report: OntarioReport): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

test("a spread of 50,000 passes and 50,001 fails", () => {
  const passes = reportFor({ ...CAD_YEAR, min: 100000, max: 150000 });
  assert.deepEqual(passes.findings, []);
  assert.equal(passes.spread, 50000);

  const fails = reportFor({ ...CAD_YEAR, min: 100000, max: 150001 });
  assert.deepEqual(ruleIds(fails), [RANGE_TOO_WIDE.id]);
  assert.equal(fails.spread, 50001);
  assert.equal(fails.findings[0]?.at, "/payRange/max");
  assert.equal(fails.findings[0]?.severity, severityOf(RANGE_TOO_WIDE));
});

test("a top above 200,000 a year is exempt; at 200,000 it is not", () => {
  const exempt = reportFor({ ...CAD_YEAR, min: 150000, max: 200001 });
  assert.deepEqual(exempt.findings, []);
  assert.equal(exempt.exempt, true);
  assert.equal(exempt.thresholdComputed, true);

  const atThreshold = reportFor({ ...CAD_YEAR, min: 149999, max: 200000 });
  assert.deepEqual(ruleIds(atThreshold), [RANGE_TOO_WIDE.id]);
  assert.equal(atThreshold.exempt, false);
});

test("the exemption is computed for a YEAR range only", () => {
  for (const period of ["HOUR", "DAY", "WEEK", "MONTH"]) {
    const report = reportFor({ ...CAD_YEAR, min: 10000, max: 210000, period });
    assert.deepEqual(ruleIds(report), [RANGE_TOO_WIDE.id]);
    assert.equal(report.thresholdComputed, false);
    assert.equal(report.exempt, false);
    assert.ok(
      report.notes.some((note) => /threshold was not computed/.test(note)),
      period,
    );
  }
});

test("24 employees is not applied, 25 is", () => {
  const report = checkOntario(SILENT, { employerHeadcount: 24 }, "2026-02-01");
  assert.equal(report.applies, false);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.notApplied.map((entry) => entry.ruleId).sort(),
    ONTARIO_RULES.map((rule) => rule.id).sort(),
  );
  for (const entry of report.notApplied) {
    assert.match(entry.reason, /25 employees or more/);
  }
  assert.equal(checkOntario(SILENT, { employerHeadcount: 25 }, "2026-02-01").applies, true);
});

test("an internal posting or a general recruitment campaign is not applied", () => {
  for (const manifest of [
    { employerHeadcount: 40, internalPosting: true },
    { employerHeadcount: 40, generalRecruitmentCampaign: true },
  ]) {
    const report = checkOntario(SILENT, manifest, "2026-02-01");
    assert.equal(report.applies, false);
    assert.deepEqual(report.findings, []);
    assert.equal(report.notApplied.length, ONTARIO_RULES.length);
    for (const entry of report.notApplied) {
      assert.match(entry.reason, /not a publicly advertised job posting/);
    }
  }
});

test("a posting before 2026-01-01 is not applied", () => {
  const report = checkOntario(SILENT, EMPLOYER, "2025-12-31");
  assert.equal(report.applies, false);
  assert.deepEqual(report.findings, []);
  for (const entry of report.notApplied) {
    assert.match(entry.reason, /takes effect on 2026-01-01/);
  }
  assert.equal(checkOntario(POSTING, EMPLOYER, "2026-01-01").applies, true);
});

test("a posting with neither expected pay nor a range fails", () => {
  const report = reportFor(undefined);
  assert.deepEqual(ruleIds(report), [COMPENSATION_MISSING.id]);
  assert.equal(report.findings[0]?.at, "/payRange");
  assert.equal(report.findings[0]?.severity, severityOf(COMPENSATION_MISSING));
  assert.equal(report.spread, undefined);
});

test("expected pay stated as one figure is a range whose ends coincide", () => {
  const report = reportFor({ ...CAD_YEAR, min: 120000, max: 120000, stated: "$120,000 per year" });
  assert.deepEqual(report.findings, []);
  assert.equal(report.spread, 0);
});

test("the posting must say whether it is for an existing vacancy", () => {
  const silent = checkOntario({ ...POSTING, existingVacancy: undefined }, EMPLOYER, "2026-02-01");
  assert.deepEqual(ruleIds(silent), [VACANCY_NOT_STATED.id]);
  assert.equal(silent.findings[0]?.at, "/existingVacancy");
  for (const existingVacancy of [true, false]) {
    const report = checkOntario({ ...POSTING, existingVacancy }, EMPLOYER, "2026-02-01");
    assert.deepEqual(report.findings, []);
  }
});

test("a range in another currency is not measured against the 50,000 limit", () => {
  const report = reportFor({ ...CAD_YEAR, currency: "USD", min: 100000, max: 300000 });
  assert.deepEqual(report.findings, []);
  assert.equal(report.thresholdComputed, false);
  assert.ok(report.notes.some((note) => /not measured against it/.test(note)));
});

test("a headcount that is not a stated whole number counts as met", () => {
  for (const manifest of [{}, { employerHeadcount: 12.5 }]) {
    const report = checkOntario(POSTING, manifest, "2026-02-01");
    assert.equal(report.applies, true);
    assert.ok(report.notes.some((note) => /fail-closed/.test(note)));
  }
});

test("a read section fails; an unconfirmed section warns and the report says so", () => {
  assert.equal(COMPENSATION_MISSING.status, "in-force");
  assert.equal(severityOf(COMPENSATION_MISSING), "error");
  for (const rule of [RANGE_TOO_WIDE, VACANCY_NOT_STATED]) {
    assert.equal(rule.status, "unverified");
    assert.equal(severityOf(rule), "warning");
  }
  assert.ok(reportFor(undefined).notes.some((note) => /unverified/.test(note)));
});

test("every Ontario rule carries a www.ontario.ca/laws citation and a window", () => {
  for (const rule of ONTARIO_RULES) {
    assert.deepEqual(ruleProblems(rule), []);
    assert.ok(isAllowedSourceUrl(rule.citation.url), rule.id);
    assert.match(rule.citation.url, /^https:\/\/www\.ontario\.ca\/laws\//);
    assert.equal(rule.jurisdiction, "CA-ON");
    assert.equal(rule.effectiveFrom, "2026-01-01");
    assert.equal(rule.minHeadcount, 25);
  }
});

test("the Ontario rules compose with the registry", () => {
  const rules: readonly Rule[] = [...RULES, ...ONTARIO_RULES];
  assert.deepEqual(registryProblems(rules), []);
  const reached = checkJurisdiction({ onsiteLocation: "CA-ON", employerHeadcount: 40 }, rules).reached;
  for (const rule of ONTARIO_RULES) {
    assert.ok(reached.includes(rule.id), `${rule.id} should be reached in Ontario`);
  }
  const outOfScope = checkJurisdiction(
    { onsiteLocation: "CA-ON", employerHeadcount: 24 },
    rules,
  ).outOfScope.map((entry) => entry.ruleId);
  for (const rule of ONTARIO_RULES) {
    assert.ok(outOfScope.includes(rule.id), `${rule.id} should be out of scope below 25`);
  }
});

test("two runs over the same posting report identically", () => {
  assert.deepEqual(reportFor(CAD_YEAR), reportFor(CAD_YEAR));
  assert.deepEqual(
    checkOntario(SILENT, EMPLOYER, "2026-02-01"),
    checkOntario(SILENT, EMPLOYER, "2026-02-01"),
  );
});
