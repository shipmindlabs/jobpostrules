import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Posting, Severity } from "../src/model.ts";
import { SEVERITIES } from "../src/model.ts";
import { checkPayRange } from "../src/payrange.ts";
import type { CitedRule, Rule, RuleStatus } from "../src/rules/registry.ts";
import {
  RULES,
  RULE_STATUSES,
  findRule,
  registryProblems,
  ruleProblems,
  severityForStatus,
  severityOf,
} from "../src/rules/registry.ts";
import { findAllowedSource, isAllowedSourceUrl } from "../src/rules/sources.ts";

const CITED: CitedRule = {
  id: "fixture/cited",
  kind: "law",
  jurisdiction: "EU",
  status: "in-force",
  summary: "A synthetic rule used only to exercise the citation checks.",
  citation: {
    url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=fixture",
    section: "Article 1",
    verifiedAt: "2026-01-15",
  },
};

function withCitation(patch: Partial<CitedRule["citation"]>): CitedRule {
  return { ...CITED, citation: { ...CITED.citation, ...patch } };
}

test("the registry itself carries no broken rule", () => {
  assert.deepEqual(registryProblems(), []);
});

test("severity is derived from status", () => {
  const expected: Record<RuleStatus, Severity> = {
    "in-force": "error",
    advisory: "warning",
    unverified: "warning",
    pending: "info",
  };
  for (const status of RULE_STATUSES) {
    assert.equal(severityForStatus(status), expected[status]);
    assert.ok((SEVERITIES as readonly string[]).includes(severityForStatus(status)));
  }
  assert.equal(severityOf({ ...CITED, status: "advisory" }), "warning");
  assert.equal(severityOf({ ...CITED, status: "pending" }), "info");
});

test("a law or platform rule without url, section or verifiedAt fails the build", () => {
  assert.deepEqual(ruleProblems(CITED), []);
  assert.deepEqual(ruleProblems(withCitation({ url: "" })), ["the citation carries no url"]);
  assert.deepEqual(ruleProblems(withCitation({ section: "  " })), [
    "the citation carries no section",
  ]);
  assert.deepEqual(ruleProblems(withCitation({ verifiedAt: "" })), [
    "the citation carries no verifiedAt date",
  ]);
  for (const verifiedAt of ["2026-13-40", "15/01/2026", "2026"]) {
    assert.equal(ruleProblems(withCitation({ verifiedAt })).length, 1);
  }
  assert.deepEqual(ruleProblems({ ...CITED, kind: "platform", jurisdiction: "" }), [
    "the jurisdiction is empty",
  ]);
});

test("an in-force rule off the allowlist fails the build", () => {
  for (const url of [
    "https://example.com/pay-transparency",
    "https://blog.example.com/eur-lex.europa.eu/fixture",
    "http://eur-lex.europa.eu/legal-content/EN/TXT/?uri=fixture",
    "not a url",
  ]) {
    const problems = ruleProblems(withCitation({ url }));
    assert.equal(problems.length, 1, `${url} should be refused once`);
    assert.match(problems[0] ?? "", /outside the primary-source allowlist/);
  }
});

test("a rule that cannot emit an error is not held to the allowlist", () => {
  const unverified: CitedRule = {
    ...withCitation({ url: "https://example.com/secondary-summary" }),
    status: "unverified",
  };
  assert.deepEqual(ruleProblems(unverified), []);
  assert.equal(severityOf(unverified), "warning");
});

test("a host allowlisted with a path prefix only matches under that prefix", () => {
  assert.ok(isAllowedSourceUrl("https://www.ontario.ca/laws/statute/fixture"));
  assert.ok(isAllowedSourceUrl("https://www.ontario.ca/laws"));
  assert.equal(findAllowedSource("https://www.ontario.ca/page/fixture"), undefined);
  assert.equal(findAllowedSource("https://www.ontario.ca/lawsuits/fixture"), undefined);
  assert.ok(isAllowedSourceUrl("https://developers.google.com/search/docs/fixture"));
  assert.ok(isAllowedSourceUrl("https://leginfo.legislature.ca.gov/faces/fixture"));
});

test("only a shape rule or a read primary source can fail a posting", () => {
  for (const rule of RULES) {
    if (severityOf(rule) !== "error") {
      continue;
    }
    if (rule.kind === "shape") {
      continue;
    }
    assert.equal(rule.status, "in-force", `${rule.id} emits errors without being in force`);
    assert.notEqual(
      findAllowedSource(rule.citation.url),
      undefined,
      `${rule.id} emits errors without a primary source`,
    );
  }
});

test("duplicate ids fail the build", () => {
  const twice: Rule[] = [CITED, CITED];
  assert.deepEqual(registryProblems(twice), [
    { ruleId: CITED.id, problem: "the id is used twice" },
  ]);
});

test("every pay-range finding comes from a shape rule in the registry", () => {
  const posting: Posting = {
    visibleText: "Acme Robotics is hiring a Staff Engineer. Apply at jobs.example.com.",
    datePosted: "2026-01-15",
    payRange: {
      min: 200000,
      max: 150000,
      currency: "US$",
      period: "FORTNIGHT",
      stated: "120k+",
    },
  };
  const findings = [
    ...checkPayRange(posting),
    ...checkPayRange({ ...posting, payRange: undefined }),
  ];
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    const rule = findRule(finding.ruleId);
    assert.notEqual(rule, undefined, `${finding.ruleId} is not in the registry`);
    assert.equal(rule?.kind, "shape");
    assert.equal(rule === undefined ? undefined : severityOf(rule), finding.severity);
  }
});
