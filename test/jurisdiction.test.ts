import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { JurisdictionManifest, JurisdictionReport } from "../src/jurisdiction.ts";
import { checkJurisdiction, regionReaches, scopeOf } from "../src/jurisdiction.ts";
import type { CitedRule, Rule } from "../src/rules/registry.ts";
import { RULES, findRule, ruleProblems, severityOf } from "../src/rules/registry.ts";

const ONTARIO: CitedRule = {
  id: "fixture/ca-on-range",
  kind: "law",
  jurisdiction: "CA-ON",
  status: "in-force",
  summary: "A synthetic Ontario rule used only to exercise the jurisdiction union.",
  citation: {
    url: "https://www.ontario.ca/laws/statute/fixture",
    section: "s. 8.1",
    verifiedAt: "2026-01-15",
  },
  effectiveFrom: "2026-01-01",
  minHeadcount: 25,
};

const POLAND: CitedRule = {
  id: "fixture/pl-range",
  kind: "law",
  jurisdiction: "PL",
  status: "in-force",
  summary: "A synthetic Polish rule used only to exercise the jurisdiction union.",
  citation: {
    url: "https://isap.sejm.gov.pl/isap.nsf/fixture",
    section: "Art. 1",
    verifiedAt: "2026-01-15",
  },
  effectiveFrom: "2026-01-01",
};

const NEW_YORK: CitedRule = {
  id: "fixture/us-ny-range",
  kind: "law",
  jurisdiction: "US-NY",
  status: "in-force",
  summary: "A synthetic New York rule used only to exercise the jurisdiction union.",
  citation: {
    url: "https://www.nysenate.gov/legislation/laws/fixture",
    section: "194-b",
    verifiedAt: "2026-01-15",
  },
  effectiveFrom: "2026-01-01",
  minHeadcount: 4,
};

const REGION_RULES: readonly Rule[] = [ONTARIO, POLAND, NEW_YORK];
const ALL_REGION_IDS = REGION_RULES.map((rule) => rule.id).sort();

function reachedIn(
  manifest: JurisdictionManifest,
  rules: readonly Rule[] = REGION_RULES,
): string[] {
  return [...checkJurisdiction(manifest, rules).reached].sort();
}

function reasonFor(report: JurisdictionReport, ruleId: string): string | undefined {
  return report.outOfScope.find((entry) => entry.ruleId === ruleId)?.reason;
}

test("the set is the union of the onsite location and every remote region", () => {
  const report = checkJurisdiction(
    { onsiteLocation: "CA-ON", remote: true, remoteEligible: ["PL"], employerHeadcount: 50 },
    REGION_RULES,
  );
  assert.deepEqual(report.regions, ["CA-ON", "PL"]);
  assert.deepEqual([...report.reached].sort(), [ONTARIO.id, POLAND.id].sort());
  assert.match(reasonFor(report, NEW_YORK.id) ?? "", /covers US-NY/);
  assert.deepEqual(report.findings, []);
});

test("a role open to a whole country reaches a subdivision rule", () => {
  assert.deepEqual(reachedIn({ remote: true, remoteEligible: ["US"], employerHeadcount: 10 }), [
    NEW_YORK.id,
  ]);
  assert.deepEqual(reachedIn({ onsiteLocation: "PL-MZ", employerHeadcount: 10 }), [POLAND.id]);
  assert.deepEqual(reachedIn({ onsiteLocation: "US-CA", employerHeadcount: 10 }), []);
  assert.ok(regionReaches("US", "US-NY"));
  assert.ok(regionReaches("US-NY", "US"));
  assert.equal(regionReaches("US-CA", "US-NY"), false);
  assert.equal(regionReaches("PL", "CA-ON"), false);
});

test("a rule is filtered by its headcount threshold inside a reached region", () => {
  const report = checkJurisdiction(
    { onsiteLocation: "CA-ON", employerHeadcount: 10 },
    REGION_RULES,
  );
  assert.deepEqual(report.reached, []);
  assert.match(reasonFor(report, ONTARIO.id) ?? "", /25 employees or more/);
  assert.deepEqual(reachedIn({ onsiteLocation: "CA-ON", employerHeadcount: 25 }), [ONTARIO.id]);
});

test("an unknown headcount counts as covered and the report says so", () => {
  const report = checkJurisdiction({ onsiteLocation: "CA-ON" }, REGION_RULES);
  assert.equal(report.headcountKnown, false);
  assert.equal(report.headcount, undefined);
  assert.deepEqual(report.reached, [ONTARIO.id]);
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ["jurisdiction/unknown-headcount"],
  );
  assert.equal(report.findings[0]?.severity, "warning");
  assert.equal(report.findings[0]?.at, "/employerHeadcount");
  assert.ok(report.notes.some((note) => /headcount/.test(note) && /fail-closed/.test(note)));
  assert.deepEqual(reachedIn({ onsiteLocation: "CA-ON", employerHeadcount: 12.5 }), [ONTARIO.id]);
});

test("a posting marked remote with no eligible region fails", () => {
  for (const manifest of [
    { remote: true, employerHeadcount: 50 },
    { remote: true, remoteEligible: [], employerHeadcount: 50 },
  ]) {
    const report = checkJurisdiction(manifest, REGION_RULES);
    const finding = report.findings.find(
      (candidate) => candidate.ruleId === "jurisdiction/remote-without-region",
    );
    assert.notEqual(finding, undefined);
    assert.equal(finding?.severity, "error");
    assert.equal(finding?.at, "/remoteEligible");
    assert.equal(report.regionsComplete, false);
    assert.deepEqual([...report.reached].sort(), ALL_REGION_IDS);
  }
});

test("a region outside ISO 3166 is a finding and no rule is let go", () => {
  const report = checkJurisdiction(
    { onsiteLocation: "Toronto, Ontario", employerHeadcount: 50 },
    REGION_RULES,
  );
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ["jurisdiction/unknown-region"],
  );
  assert.equal(report.findings[0]?.at, "/onsiteLocation");
  assert.equal(report.regionsComplete, false);
  assert.deepEqual([...report.reached].sort(), ALL_REGION_IDS);
});

test("region codes are read case- and space-insensitively", () => {
  const scope = scopeOf({ onsiteLocation: " ca-on ", remoteEligible: ["pl", "PL"] });
  assert.deepEqual(scope.regions, ["CA-ON", "PL"]);
  assert.equal(scope.remote, true);
});

test("a shape rule is reached everywhere and no rule is dropped silently", () => {
  const rules: readonly Rule[] = [...RULES, ...REGION_RULES];
  const report = checkJurisdiction({ onsiteLocation: "PL", employerHeadcount: 3 }, rules);
  for (const rule of RULES) {
    assert.ok(report.reached.includes(rule.id), `${rule.id} should be reached`);
  }
  const seen = [...report.reached, ...report.outOfScope.map((entry) => entry.ruleId)].sort();
  assert.deepEqual(seen, rules.map((rule) => rule.id).sort());
});

test("the union is documented as the strictest place reached, not legal scope", () => {
  const report = checkJurisdiction({ onsiteLocation: "PL", employerHeadcount: 3 }, REGION_RULES);
  assert.ok(report.notes.some((note) => /strictest place reached/.test(note)));
  assert.ok(report.notes.some((note) => /not a statement of legal scope/.test(note)));
});

test("the report never suggests giving up a region to escape a rule", () => {
  const manifests: readonly JurisdictionManifest[] = [
    {},
    { remote: true },
    { onsiteLocation: "CA-ON", remoteEligible: ["PL", "US-NY", "nowhere"], employerHeadcount: 2 },
  ];
  for (const manifest of manifests) {
    const report = checkJurisdiction(manifest, REGION_RULES);
    const texts = [
      ...report.notes,
      ...report.findings.map((finding) => finding.message),
      ...report.outOfScope.map((entry) => entry.reason),
    ];
    for (const text of texts) {
      assert.doesNotMatch(text, /\b(drop|remove|exclude|narrow|restrict)\b/i, text);
    }
  }
});

test("every jurisdiction finding comes from a shape rule in the registry", () => {
  const findings = [
    ...checkJurisdiction({ remote: true }, REGION_RULES).findings,
    ...checkJurisdiction({ onsiteLocation: "x" }, REGION_RULES).findings,
  ];
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    const rule = findRule(finding.ruleId);
    assert.notEqual(rule, undefined, `${finding.ruleId} is not in the registry`);
    assert.equal(rule?.kind, "shape");
    assert.equal(rule === undefined ? undefined : severityOf(rule), finding.severity);
  }
});

test("a headcount threshold that is not a whole number above zero fails the build", () => {
  for (const rule of REGION_RULES) {
    assert.deepEqual(ruleProblems(rule), []);
  }
  for (const minHeadcount of [0, -5, 2.5]) {
    assert.equal(ruleProblems({ ...ONTARIO, minHeadcount }).length, 1);
  }
});

test("two runs over the same manifest report identically", () => {
  const manifest: JurisdictionManifest = {
    onsiteLocation: "CA-ON",
    remote: true,
    remoteEligible: ["PL", "US-NY"],
  };
  assert.deepEqual(
    checkJurisdiction(manifest, REGION_RULES),
    checkJurisdiction(manifest, REGION_RULES),
  );
});
