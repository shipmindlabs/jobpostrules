import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { LintReport, LintRefusal, LintResult } from "../src/lint.ts";
import { lint } from "../src/lint.ts";
import type { Posting } from "../src/model.ts";
import type { CitedRule, Rule } from "../src/rules/registry.ts";
import { RULES } from "../src/rules/registry.ts";

const WINDOWED: CitedRule = {
  id: "fixture/windowed",
  kind: "law",
  jurisdiction: "EU",
  status: "in-force",
  summary: "A synthetic rule used only to exercise the effective window.",
  citation: {
    url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=fixture",
    section: "Article 1",
    verifiedAt: "2026-01-15",
  },
  effectiveFrom: "2026-02-01",
  effectiveTo: "2026-02-28",
};

const RULE_SET: readonly Rule[] = [...RULES, WINDOWED];

function postingOn(datePosted?: string): Posting {
  const posting: Posting = {
    visibleText: "Acme Robotics is hiring a Staff Engineer. Apply at jobs.example.com.",
    payRange: {
      min: 120000,
      max: 150000,
      currency: "USD",
      period: "YEAR",
      stated: "$120,000 - $150,000 per year",
    },
  };
  return datePosted === undefined ? posting : { ...posting, datePosted };
}

function reportOf(result: LintResult): LintReport {
  if (!result.ok) {
    assert.fail(`lint refused the input as ${result.refusal.code}`);
  }
  return result.report;
}

function refusalOf(result: LintResult): LintRefusal {
  if (result.ok) {
    assert.fail("lint accepted an input that carries no as-of date");
  }
  return result.refusal;
}

function reasonFor(report: LintReport, ruleId: string): string | undefined {
  return report.notApplied.find((entry) => entry.ruleId === ruleId)?.reason;
}

test("the day before the start is outside the window", () => {
  const report = reportOf(lint(postingOn("2026-01-31"), undefined, { rules: RULE_SET }));
  assert.equal(report.asOf, "2026-01-31");
  assert.equal(report.applied.includes(WINDOWED.id), false);
  assert.match(reasonFor(report, WINDOWED.id) ?? "", /takes effect on 2026-02-01/);
});

test("the first day and the last day are inside the window", () => {
  for (const datePosted of ["2026-02-01", "2026-02-28"]) {
    const report = reportOf(lint(postingOn(datePosted), undefined, { rules: RULE_SET }));
    assert.equal(report.asOf, datePosted);
    assert.ok(report.applied.includes(WINDOWED.id), `${datePosted} should apply the rule`);
    assert.deepEqual(report.notApplied, []);
  }
});

test("the day after the last day is outside the window", () => {
  const report = reportOf(lint(postingOn("2026-03-01"), undefined, { rules: RULE_SET }));
  assert.match(reasonFor(report, WINDOWED.id) ?? "", /applied through 2026-02-28/);
});

test("a rule out of its window is listed, not dropped", () => {
  const report = reportOf(lint(postingOn("2026-01-31"), undefined, { rules: RULE_SET }));
  const seen = [...report.applied, ...report.notApplied.map((entry) => entry.ruleId)];
  assert.deepEqual(seen.sort(), RULE_SET.map((rule) => rule.id).sort());
});

test("asOf comes from the posting date, never from the current date", () => {
  const historic: CitedRule = { ...WINDOWED, effectiveFrom: "1990-01-01", effectiveTo: "1999-12-31" };
  const report = reportOf(lint(postingOn("1995-06-01"), undefined, { rules: [historic] }));
  assert.equal(report.asOf, "1995-06-01");
  assert.deepEqual(report.applied, [historic.id]);
});

test("options.asOf wins over the posting date", () => {
  const report = reportOf(
    lint(postingOn("2026-01-31"), undefined, { asOf: "2026-02-15", rules: RULE_SET }),
  );
  assert.equal(report.asOf, "2026-02-15");
  assert.ok(report.applied.includes(WINDOWED.id));
});

test("a posting with no as-of date is refused", () => {
  const refusal = refusalOf(lint(postingOn(undefined), undefined, { rules: RULE_SET }));
  assert.equal(refusal.code, "input/no-as-of");
  assert.equal(refusal.at, "/datePosted");
  for (const asOf of ["15/01/2026", "2026-13-40", "2026", ""]) {
    assert.equal(
      refusalOf(lint(postingOn(undefined), undefined, { asOf })).code,
      "input/no-as-of",
    );
  }
});

test("shape findings still reach the report", () => {
  const posting: Posting = { ...postingOn("2026-02-15"), payRange: undefined };
  const report = reportOf(lint(posting, {}, { rules: RULE_SET }));
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ["pay-range/missing"]);
});
