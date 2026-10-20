import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PayRange, Posting } from "../src/model.ts";
import { checkPayRange } from "../src/payrange.ts";

const VALID: PayRange = {
  min: 120000,
  max: 150000,
  currency: "USD",
  period: "YEAR",
  stated: "$120,000 - $150,000 per year",
};

function postingWith(payRange: PayRange | undefined): Posting {
  return {
    visibleText: "Acme Robotics is hiring a Staff Engineer. Apply at jobs.example.com.",
    datePosted: "2026-01-15",
    payRange,
  };
}

function ruleIds(payRange: PayRange | undefined): string[] {
  return checkPayRange(postingWith(payRange)).map((finding) => finding.ruleId);
}

test("two numbers, one currency and one period pass", () => {
  assert.deepEqual(checkPayRange(postingWith(VALID)), []);
});

test("a missing range is a finding", () => {
  const findings = checkPayRange(postingWith(undefined));
  assert.deepEqual(findings.map((finding) => finding.ruleId), ["pay-range/missing"]);
  assert.equal(findings[0]?.at, "/payRange");
});

test("the low end above the high end is a finding", () => {
  const findings = checkPayRange(postingWith({ ...VALID, min: 200000 }));
  assert.deepEqual(findings.map((finding) => finding.ruleId), ["pay-range/min-above-max"]);
  assert.equal(findings[0]?.at, "/payRange/min");
  assert.equal(findings[0]?.severity, "error");
});

test("a currency outside ISO 4217 alpha-3 is a finding", () => {
  for (const currency of ["US$", "usd", "DOLLARS", ""]) {
    assert.deepEqual(ruleIds({ ...VALID, currency }), ["pay-range/unknown-currency"]);
  }
  assert.deepEqual(ruleIds({ ...VALID, currency: "EUR" }), []);
});

test("a period outside HOUR/DAY/WEEK/MONTH/YEAR is a finding", () => {
  for (const period of ["FORTNIGHT", "ANNUAL", "year", ""]) {
    assert.deepEqual(ruleIds({ ...VALID, period }), ["pay-range/unknown-period"]);
  }
  for (const period of ["HOUR", "DAY", "WEEK", "MONTH", "YEAR"]) {
    assert.deepEqual(ruleIds({ ...VALID, period }), []);
  }
});

test("open-ended wording in the stated range is a finding", () => {
  for (const stated of [
    "120k+",
    "$120,000+",
    "Up to $150,000 per year",
    "Competitive",
    "DOE",
  ]) {
    const findings = checkPayRange(postingWith({ ...VALID, stated }));
    assert.deepEqual(findings.map((finding) => finding.ruleId), ["pay-range/open-ended"]);
    assert.equal(findings[0]?.severity, "warning");
    assert.equal(findings[0]?.at, "/payRange/stated");
  }
});

test("findings sort by severity, then rule id, then path", () => {
  const broken: PayRange = {
    min: 200000,
    max: 150000,
    currency: "US$",
    period: "FORTNIGHT",
    stated: "120k+",
  };
  const first = checkPayRange(postingWith(broken));
  const second = checkPayRange(postingWith(broken));

  assert.deepEqual(first.map((finding) => finding.ruleId), [
    "pay-range/min-above-max",
    "pay-range/unknown-currency",
    "pay-range/unknown-period",
    "pay-range/open-ended",
  ]);
  assert.deepEqual(second, first);
});
