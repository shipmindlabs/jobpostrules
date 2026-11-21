import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkJurisdiction } from "../src/jurisdiction.ts";
import type { Posting } from "../src/model.ts";
import { PERIODS } from "../src/model.ts";
import type { JsonLdObject } from "../src/read.ts";
import type { GoogleManifest, GoogleReport } from "../src/rules/google.ts";
import {
  GOOGLE_EFFECTIVE_FROM,
  GOOGLE_REQUIRED_PROPERTIES,
  GOOGLE_RULES,
  LOCATION_MISSING,
  REQUIRED_PROPERTY_MISSING,
  TELECOMMUTE_NOT_REMOTE,
  TELECOMMUTE_TEXT_UNSTATED,
  TELECOMMUTE_WITHOUT_COUNTRY,
  UNIT_TEXT_NOT_ENUM,
  VALID_THROUGH_EXPIRED,
  checkGoogle,
  matchFullyRemote,
} from "../src/rules/google.ts";
import type { Rule } from "../src/rules/registry.ts";
import { RULES, registryProblems, ruleProblems, severityOf } from "../src/rules/registry.ts";
import { isAllowedSourceUrl } from "../src/rules/sources.ts";

const SERVED_ON = "2026-03-01";

const POSTING: Posting = {
  visibleText: "Staff Engineer Acme Robotics is hiring in Toronto. Apply at jobs.example.com.",
  datePosted: "2026-01-15",
};

const REMOTE_POSTING: Posting = {
  ...POSTING,
  visibleText: "Staff Engineer Acme Robotics is hiring. This is a fully remote role across Canada.",
};

const MARKUP: JsonLdObject = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Staff Engineer",
  description: "Acme Robotics is hiring a Staff Engineer.",
  datePosted: "2026-01-15",
  validThrough: "2026-06-30",
  hiringOrganization: { "@type": "Organization", name: "Acme Robotics" },
  jobLocation: {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Toronto",
      addressRegion: "ON",
      addressCountry: "CA",
    },
  },
  baseSalary: {
    "@type": "MonetaryAmount",
    currency: "CAD",
    value: { "@type": "QuantitativeValue", minValue: 100000, maxValue: 150000, unitText: "YEAR" },
  },
};

const PLACE_WITHOUT_COUNTRY = {
  "@type": "Place",
  address: { "@type": "PostalAddress", addressLocality: "Toronto" },
};

function markupWithout(property: string): JsonLdObject {
  const copy: Record<string, unknown> = { ...MARKUP };
  delete copy[property];
  return copy;
}

function salaryWith(unitText: string): JsonLdObject {
  return {
    ...MARKUP,
    baseSalary: {
      "@type": "MonetaryAmount",
      currency: "CAD",
      value: { "@type": "QuantitativeValue", minValue: 100000, maxValue: 150000, unitText },
    },
  };
}

function reportFor(
  markup: JsonLdObject | undefined,
  posting: Posting = POSTING,
  manifest: GoogleManifest = {},
): GoogleReport {
  return checkGoogle(posting, markup, manifest, { servedOn: SERVED_ON });
}

function ruleIds(report: GoogleReport): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

test("markup carrying every required property passes and names both dates", () => {
  const report = reportFor(MARKUP);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.notApplied, []);
  assert.equal(report.servedOn, SERVED_ON);
  assert.equal(report.datePosted, "2026-01-15");
  assert.equal(report.telecommute, false);
  assert.equal(report.expired, false);
});

test("datePosted, description, hiringOrganization and title are required", () => {
  assert.deepEqual(
    [...GOOGLE_REQUIRED_PROPERTIES],
    ["datePosted", "description", "hiringOrganization", "title"],
  );
  for (const property of GOOGLE_REQUIRED_PROPERTIES) {
    const report = reportFor(markupWithout(property));
    assert.deepEqual(ruleIds(report), [REQUIRED_PROPERTY_MISSING.id]);
    assert.equal(report.findings[0]?.at, `/jobPosting/${property}`);
    assert.equal(report.findings[0]?.severity, "error");
  }
  const empty = reportFor({ ...MARKUP, title: "   ", hiringOrganization: {} });
  assert.deepEqual(
    empty.findings.map((finding) => finding.at),
    ["/jobPosting/hiringOrganization", "/jobPosting/title"],
  );
});

test("jobLocation is required unless applicantLocationRequirements is present", () => {
  const missing = reportFor(markupWithout("jobLocation"));
  assert.deepEqual(ruleIds(missing), [LOCATION_MISSING.id]);
  assert.equal(missing.findings[0]?.at, "/jobPosting/jobLocation");
  assert.equal(missing.findings[0]?.severity, "error");

  const anywhere = reportFor({
    ...markupWithout("jobLocation"),
    applicantLocationRequirements: { "@type": "Country", name: "CA" },
  });
  assert.deepEqual(anywhere.findings, []);
});

test("baseSalary unitText is an exact enum, so 'year' fails", () => {
  const lower = reportFor(salaryWith("year"));
  assert.deepEqual(ruleIds(lower), [UNIT_TEXT_NOT_ENUM.id]);
  assert.equal(lower.findings[0]?.at, "/jobPosting/baseSalary/value/unitText");
  assert.equal(lower.findings[0]?.severity, "error");
  assert.match(lower.findings[0]?.message ?? "", /"year"/);

  for (const unitText of PERIODS) {
    assert.deepEqual(reportFor(salaryWith(unitText)).findings, [], unitText);
  }
  for (const unitText of ["Year", "YEARLY", "ANNUAL", "hour", ""]) {
    assert.deepEqual(ruleIds(reportFor(salaryWith(unitText))), [UNIT_TEXT_NOT_ENUM.id], unitText);
  }
});

test("baseSalary with no unitText at all is a finding; no baseSalary is not", () => {
  const report = reportFor({
    ...MARKUP,
    baseSalary: {
      "@type": "MonetaryAmount",
      currency: "CAD",
      value: { "@type": "QuantitativeValue", value: 120000 },
    },
  });
  assert.deepEqual(ruleIds(report), [UNIT_TEXT_NOT_ENUM.id]);
  assert.match(report.findings[0]?.message ?? "", /no value\.unitText/);
  assert.deepEqual(reportFor(markupWithout("baseSalary")).findings, []);
});

test("a TELECOMMUTE role names a country in either place", () => {
  const viaRequirements = reportFor(
    {
      ...markupWithout("jobLocation"),
      jobLocationType: ["TELECOMMUTE"],
      applicantLocationRequirements: { "@type": "Country", name: "CA" },
    },
    REMOTE_POSTING,
  );
  assert.deepEqual(viaRequirements.findings, []);
  assert.equal(viaRequirements.telecommute, true);
  assert.equal(viaRequirements.country, "CA");

  const viaAddress = reportFor({ ...MARKUP, jobLocationType: "TELECOMMUTE" }, REMOTE_POSTING);
  assert.deepEqual(viaAddress.findings, []);
  assert.equal(viaAddress.country, "CA");

  const neither = reportFor(
    { ...MARKUP, jobLocationType: "TELECOMMUTE", jobLocation: PLACE_WITHOUT_COUNTRY },
    REMOTE_POSTING,
  );
  assert.deepEqual(ruleIds(neither), [TELECOMMUTE_WITHOUT_COUNTRY.id]);
  assert.equal(neither.findings[0]?.at, "/jobPosting/jobLocationType");
  assert.equal(neither.findings[0]?.severity, "error");
  assert.equal(neither.country, undefined);
});

test("TELECOMMUTE fails when the manifest declares a hybrid workplace", () => {
  const markup = { ...MARKUP, jobLocationType: "TELECOMMUTE" };
  const hybrid = reportFor(markup, REMOTE_POSTING, { workplaceType: "Hybrid" });
  assert.deepEqual(ruleIds(hybrid), [TELECOMMUTE_NOT_REMOTE.id]);
  assert.equal(hybrid.findings[0]?.at, "/jobPosting/jobLocationType");
  assert.equal(hybrid.findings[0]?.severity, "error");

  for (const workplaceType of ["remote", "onsite"]) {
    assert.deepEqual(reportFor(markup, REMOTE_POSTING, { workplaceType }).findings, []);
  }
  assert.deepEqual(reportFor(markup, REMOTE_POSTING).findings, []);
});

test("a visible text with no fully-remote statement only warns", () => {
  const silent = reportFor({ ...MARKUP, jobLocationType: "TELECOMMUTE" });
  assert.deepEqual(ruleIds(silent), [TELECOMMUTE_TEXT_UNSTATED.id]);
  assert.equal(silent.findings[0]?.severity, "warning");
  assert.equal(silent.findings[0]?.at, "/visibleText");
  assert.equal(silent.fullyRemoteStated, false);
  assert.ok(silent.notes.some((note) => /text heuristic/.test(note)));

  for (const visibleText of [
    "Acme Robotics is hiring. This role is FULLY   REMOTE.",
    "Acme is remote-first: work from anywhere in Canada.",
  ]) {
    const report = reportFor({ ...MARKUP, jobLocationType: "TELECOMMUTE" }, {
      ...POSTING,
      visibleText,
    });
    assert.deepEqual(report.findings, [], visibleText);
    assert.equal(report.fullyRemoteStated, true);
  }
  assert.deepEqual(matchFullyRemote("Acme Robotics is hiring in Toronto."), []);
});

test("a validThrough earlier than the serving date is an error", () => {
  const expired = reportFor({ ...MARKUP, validThrough: "2026-02-28" });
  assert.deepEqual(ruleIds(expired), [VALID_THROUGH_EXPIRED.id]);
  assert.equal(expired.findings[0]?.at, "/jobPosting/validThrough");
  assert.equal(expired.findings[0]?.severity, "error");
  assert.equal(expired.expired, true);
  assert.match(expired.findings[0]?.message ?? "", /2026-03-01/);
  assert.match(expired.findings[0]?.message ?? "", /2026-01-15/);

  for (const validThrough of ["2026-03-01", "2026-03-02", "2026-12-31T23:59:59Z"]) {
    const report = reportFor({ ...MARKUP, validThrough });
    assert.deepEqual(report.findings, [], validThrough);
    assert.equal(report.expired, false);
  }

  const unreadable = reportFor({ ...MARKUP, validThrough: "30/06/2026" });
  assert.deepEqual(unreadable.findings, []);
  assert.ok(unreadable.notes.some((note) => /could not be read as a date/.test(note)));
});

test("the rules run on the serving date, not the posting date", () => {
  const before = checkGoogle(POSTING, markupWithout("title"), {}, { servedOn: "2023-12-31" });
  assert.equal(before.servedOn, "2023-12-31");
  assert.equal(before.datePosted, "2026-01-15");
  assert.deepEqual(before.findings, []);
  assert.deepEqual(
    before.notApplied.map((entry) => entry.ruleId).sort(),
    GOOGLE_RULES.map((rule) => rule.id).sort(),
  );
  for (const entry of before.notApplied) {
    assert.match(entry.reason, new RegExp(`takes effect on ${GOOGLE_EFFECTIVE_FROM}`));
  }

  const on = checkGoogle(POSTING, markupWithout("title"), {}, { servedOn: GOOGLE_EFFECTIVE_FROM });
  assert.deepEqual(ruleIds(on), [REQUIRED_PROPERTY_MISSING.id]);
  assert.ok(on.notes.some((note) => /serving date/.test(note)));
});

test("the serving date defaults to the current date", () => {
  const current = new Date().toISOString().slice(0, 10);
  const report = checkGoogle(POSTING, { ...MARKUP, validThrough: "2024-06-30" });
  assert.equal(report.servedOn, current);
  assert.deepEqual(ruleIds(report), [VALID_THROUGH_EXPIRED.id]);

  const unreadable = checkGoogle(POSTING, MARKUP, {}, { servedOn: "01/03/2026" });
  assert.equal(unreadable.servedOn, current);
  assert.ok(unreadable.notes.some((note) => /not a YYYY-MM-DD date/.test(note)));
});

test("a page with no JobPosting block is read against no rule", () => {
  const report = reportFor(undefined);
  assert.deepEqual(report.findings, []);
  assert.equal(report.notApplied.length, GOOGLE_RULES.length);
  for (const entry of report.notApplied) {
    assert.match(entry.reason, /no JobPosting block/);
  }
  assert.ok(report.notes.some((note) => /no JobPosting block/.test(note)));
});

test("an enum check fails and the text heuristic warns", () => {
  for (const rule of [
    REQUIRED_PROPERTY_MISSING,
    LOCATION_MISSING,
    UNIT_TEXT_NOT_ENUM,
    TELECOMMUTE_WITHOUT_COUNTRY,
    TELECOMMUTE_NOT_REMOTE,
    VALID_THROUGH_EXPIRED,
  ]) {
    assert.equal(rule.status, "in-force", rule.id);
    assert.equal(severityOf(rule), "error", rule.id);
  }
  assert.equal(TELECOMMUTE_TEXT_UNSTATED.status, "advisory");
  assert.equal(severityOf(TELECOMMUTE_TEXT_UNSTATED), "warning");
});

test("every Google rule cites developers.google.com and composes with the registry", () => {
  for (const rule of GOOGLE_RULES) {
    assert.deepEqual(ruleProblems(rule), []);
    assert.equal(rule.kind, "platform");
    assert.ok(isAllowedSourceUrl(rule.citation.url), rule.id);
    assert.match(rule.citation.url, /^https:\/\/developers\.google\.com\/search\/docs\//);
    assert.equal(rule.effectiveFrom, GOOGLE_EFFECTIVE_FROM);
  }
  const rules: readonly Rule[] = [...RULES, ...GOOGLE_RULES];
  assert.deepEqual(registryProblems(rules), []);
  const reached = checkJurisdiction(
    { onsiteLocation: "CA-ON", employerHeadcount: 40 },
    rules,
  ).reached;
  for (const rule of GOOGLE_RULES) {
    assert.ok(reached.includes(rule.id), `${rule.id} should be reached on any page`);
  }
});

test("every Google finding comes from a Google rule and carries its severity", () => {
  const findings = [
    reportFor(markupWithout("title")),
    reportFor(markupWithout("jobLocation")),
    reportFor(salaryWith("year")),
    reportFor({ ...MARKUP, jobLocationType: "TELECOMMUTE", jobLocation: PLACE_WITHOUT_COUNTRY }),
    reportFor({ ...MARKUP, jobLocationType: "TELECOMMUTE" }, REMOTE_POSTING, {
      workplaceType: "hybrid",
    }),
    reportFor({ ...MARKUP, validThrough: "2026-02-28" }),
  ].flatMap((report) => report.findings);
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    const rule = GOOGLE_RULES.find((candidate) => candidate.id === finding.ruleId);
    assert.notEqual(rule, undefined, `${finding.ruleId} is not a Google rule`);
    assert.equal(rule === undefined ? undefined : severityOf(rule), finding.severity);
  }
});

test("two runs over the same markup report identically", () => {
  assert.deepEqual(reportFor(MARKUP), reportFor(MARKUP));
  const broken = { ...MARKUP, jobLocationType: "TELECOMMUTE", validThrough: "2026-02-28" };
  assert.deepEqual(reportFor(broken), reportFor(broken));
});
