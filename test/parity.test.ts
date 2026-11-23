import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkJurisdiction } from "../src/jurisdiction.ts";
import type { Posting } from "../src/model.ts";
import type { JsonLdObject } from "../src/read.ts";
import type { ParityReport } from "../src/rules/parity.ts";
import {
  AMBIGUOUS_NUMBER,
  BAD_GROUPING,
  CURRENCY_MISMATCH,
  LOCATION_MISMATCH,
  PARITY_RULES,
  SALARY_MISMATCH,
  TITLE_MISMATCH,
  checkParity,
} from "../src/rules/parity.ts";
import type { Rule } from "../src/rules/registry.ts";
import { RULES, registryProblems, severityOf } from "../src/rules/registry.ts";

function salaryOf(currency: string, minValue: number, maxValue: number): JsonLdObject {
  return {
    "@type": "MonetaryAmount",
    currency,
    value: { "@type": "QuantitativeValue", minValue, maxValue, unitText: "YEAR" },
  };
}

function placeOf(addressLocality: string, addressCountry: string): JsonLdObject {
  return {
    "@type": "Place",
    address: { "@type": "PostalAddress", addressLocality, addressCountry },
  };
}

const EN_MARKUP: JsonLdObject = {
  "@type": "JobPosting",
  title: "Staff Engineer",
  baseSalary: salaryOf("USD", 120000, 150000),
  jobLocation: placeOf("Austin", "US"),
};

const DE_MARKUP: JsonLdObject = {
  "@type": "JobPosting",
  title: "Staff Engineer",
  baseSalary: salaryOf("EUR", 120000, 150000),
  jobLocation: placeOf("Berlin", "Deutschland"),
};

const PL_MARKUP: JsonLdObject = {
  "@type": "JobPosting",
  title: "Staff Engineer",
  baseSalary: salaryOf("PLN", 120000, 150000),
  jobLocation: placeOf("Warszawa", "Polska"),
};

const EN_TEXT = "Staff Engineer at Acme Robotics in Austin. $120,000 - $150,000 USD per year.";
const DE_TEXT =
  "Staff Engineer bei Acme Robotics in Berlin, Deutschland. 120.000 - 150.000 EUR pro Jahr.";
const PL_TEXT = "Staff Engineer w Acme Robotics. Warszawa, Polska. 120 000 - 150 000 PLN rocznie.";

interface Case {
  readonly locale: string;
  readonly markup: JsonLdObject;
  readonly text: string;
}

const CASES: readonly Case[] = [
  { locale: "en-US", markup: EN_MARKUP, text: EN_TEXT },
  { locale: "de-DE", markup: DE_MARKUP, text: DE_TEXT },
  { locale: "pl-PL", markup: PL_MARKUP, text: PL_TEXT },
];

function parityOf(text: string, markup: JsonLdObject | undefined, locale?: string): ParityReport {
  const posting: Posting = { visibleText: text };
  return checkParity(posting, markup, locale === undefined ? {} : { locale });
}

function ruleIds(report: ParityReport): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

function fieldsNotCompared(report: ParityReport): string[] {
  return report.notCompared.map((entry) => entry.field);
}

test("a page that says what the markup says passes in en-US, de-DE and pl-PL", () => {
  for (const posting of CASES) {
    const report = parityOf(posting.text, posting.markup, posting.locale);
    assert.deepEqual(report.findings, [], posting.locale);
    assert.equal(report.locale, posting.locale);
    assert.deepEqual([...report.figures], [120000, 150000], posting.locale);
    for (const field of [
      "/title",
      "/baseSalary/value/minValue",
      "/baseSalary/value/maxValue",
      "/jobLocation/address/addressLocality",
    ]) {
      assert.ok(report.compared.includes(field), `${posting.locale} ${field}`);
    }
  }
});

test("a title the page does not carry names the field and both values", () => {
  const report = parityOf(EN_TEXT, { ...EN_MARKUP, title: "Senior Engineer" }, "en-US");
  assert.deepEqual(ruleIds(report), [TITLE_MISMATCH.id]);
  assert.equal(report.findings[0]?.at, "/title");
  assert.equal(report.findings[0]?.severity, "error");
  assert.match(report.findings[0]?.message ?? "", /"Senior Engineer"/);
  assert.match(report.findings[0]?.message ?? "", /Staff Engineer at Acme Robotics/);

  const { title, ...untitled } = EN_MARKUP;
  assert.equal(title, "Staff Engineer");
  assert.ok(fieldsNotCompared(parityOf(EN_TEXT, untitled, "en-US")).includes("/title"));
});

test("a salary figure the page does not carry names the field and the figures read", () => {
  const report = parityOf(EN_TEXT, { ...EN_MARKUP, baseSalary: salaryOf("USD", 130000, 150000) }, "en-US");
  assert.deepEqual(ruleIds(report), [SALARY_MISMATCH.id]);
  assert.equal(report.findings[0]?.at, "/baseSalary/value/minValue");
  assert.match(report.findings[0]?.message ?? "", /130000/);
  assert.match(report.findings[0]?.message ?? "", /120000, 150000/);
});

test("the figures in the visible text are read with the manifest's locale", () => {
  const german = parityOf(DE_TEXT, DE_MARKUP, "en-US");
  assert.deepEqual(ruleIds(german), [SALARY_MISMATCH.id, SALARY_MISMATCH.id]);
  assert.deepEqual([...german.figures], [120, 150]);
  assert.equal(german.groupSeparator, ",");

  const american = parityOf(EN_TEXT, EN_MARKUP, "de-DE");
  assert.deepEqual(ruleIds(american), [SALARY_MISMATCH.id, SALARY_MISMATCH.id]);
  assert.deepEqual([...american.figures], [120, 150]);
  assert.equal(american.groupSeparator, ".");

  const polish = parityOf(PL_TEXT, PL_MARKUP, "pl-PL");
  assert.equal(polish.groupSeparator, " ");
  assert.equal(polish.decimalSeparator, ",");
});

test("a figure whose grouping is ambiguous without a locale is refused, never guessed", () => {
  for (const posting of CASES) {
    const report = parityOf(posting.text, posting.markup);
    assert.deepEqual(ruleIds(report), [AMBIGUOUS_NUMBER.id, AMBIGUOUS_NUMBER.id], posting.locale);
    assert.equal(report.findings[0]?.at, "/visibleText");
    assert.equal(report.locale, undefined);
    assert.ok(fieldsNotCompared(report).includes("/baseSalary"));
    assert.ok(report.notes.some((note) => /states no locale/.test(note)));
  }
  const ambiguous = parityOf(EN_TEXT, EN_MARKUP);
  assert.match(ambiguous.findings[0]?.message ?? "", /"120,000"/);
});

test("a separator the stated locale does not use is refused rather than guessed", () => {
  const report = parityOf(DE_TEXT, DE_MARKUP, "pl-PL");
  assert.deepEqual(ruleIds(report), [AMBIGUOUS_NUMBER.id, AMBIGUOUS_NUMBER.id]);
  assert.match(report.findings[0]?.message ?? "", /neither the grouping separator/);
});

test("a group of other than three digits is refused as bad grouping", () => {
  const cases: readonly (readonly [string, JsonLdObject, string, string])[] = [
    ["en-US", EN_MARKUP, EN_TEXT.replace("$120,000", "$120,00"), '"120,00"'],
    ["de-DE", DE_MARKUP, DE_TEXT.replace("120.000", "120.0000"), '"120.0000"'],
    ["pl-PL", PL_MARKUP, PL_TEXT.replace("120 000", "120 00"), '"120 00"'],
  ];
  for (const [locale, markup, text, quoted] of cases) {
    const report = parityOf(text, markup, locale);
    assert.deepEqual(ruleIds(report), [BAD_GROUPING.id], locale);
    assert.equal(report.findings[0]?.at, "/visibleText");
    assert.ok(report.findings[0]?.message.includes(quoted), locale);
    assert.ok(fieldsNotCompared(report).includes("/baseSalary"));
  }
});

test("120k reads as 120000 only with the explicit k suffix", () => {
  const suffixed = parityOf(
    "Staff Engineer at Acme Robotics in Austin. $120k - $150k USD per year.",
    EN_MARKUP,
    "en-US",
  );
  assert.deepEqual(suffixed.findings, []);
  assert.deepEqual([...suffixed.figures], [120000, 150000]);

  const bare = parityOf(
    "Staff Engineer at Acme Robotics in Austin. $120 - $150 USD per year.",
    EN_MARKUP,
    "en-US",
  );
  assert.deepEqual(ruleIds(bare), [SALARY_MISMATCH.id, SALARY_MISMATCH.id]);
  assert.deepEqual([...bare.figures], [120, 150]);

  const kilograms = parityOf(
    "Staff Engineer at Acme Robotics in Austin. $120kg - $150kg USD per year.",
    EN_MARKUP,
    "en-US",
  );
  assert.deepEqual(ruleIds(kilograms), [SALARY_MISMATCH.id, SALARY_MISMATCH.id]);
});

test("the currency reaches the page as its code or as the locale's symbol", () => {
  const absent = parityOf(EN_TEXT, { ...EN_MARKUP, baseSalary: salaryOf("EUR", 120000, 150000) }, "en-US");
  assert.deepEqual(ruleIds(absent), [CURRENCY_MISMATCH.id]);
  assert.equal(absent.findings[0]?.at, "/baseSalary/currency");
  assert.match(absent.findings[0]?.message ?? "", /"EUR"/);

  const symbols: readonly (readonly [string, JsonLdObject, string])[] = [
    ["en-US", EN_MARKUP, "Staff Engineer at Acme Robotics in Austin. $120,000 - $150,000 per year."],
    [
      "pl-PL",
      PL_MARKUP,
      "Staff Engineer w Acme Robotics. Warszawa, Polska. 120 000 - 150 000 zl rocznie.".replace(
        "zl",
        "z\u0142",
      ),
    ],
  ];
  for (const [locale, markup, text] of symbols) {
    const report = parityOf(text, markup, locale);
    assert.deepEqual(report.findings, [], locale);
    assert.ok(report.compared.includes("/baseSalary/currency"), locale);
  }
});

test("each locality and country name must be in the visible text", () => {
  const country = parityOf(DE_TEXT, { ...DE_MARKUP, jobLocation: placeOf("Berlin", "Austria") }, "de-DE");
  assert.deepEqual(ruleIds(country), [LOCATION_MISMATCH.id]);
  assert.equal(country.findings[0]?.at, "/jobLocation/address/addressCountry");
  assert.match(country.findings[0]?.message ?? "", /"Austria"/);

  const listed = parityOf(
    EN_TEXT,
    { ...EN_MARKUP, jobLocation: [placeOf("Austin", "US"), placeOf("Boston", "US")] },
    "en-US",
  );
  assert.deepEqual(ruleIds(listed), [LOCATION_MISMATCH.id]);
  assert.equal(listed.findings[0]?.at, "/jobLocation/1/address/addressLocality");

  const remote = parityOf(
    EN_TEXT,
    { ...EN_MARKUP, applicantLocationRequirements: { "@type": "Country", name: "Poland" } },
    "en-US",
  );
  assert.deepEqual(ruleIds(remote), [LOCATION_MISMATCH.id]);
  assert.equal(remote.findings[0]?.at, "/applicantLocationRequirements/name");
});

test("a two-letter country code is not a name the page can carry, so it is not compared", () => {
  const report = parityOf(EN_TEXT, EN_MARKUP, "en-US");
  const entry = report.notCompared.find(
    (candidate) => candidate.field === "/jobLocation/address/addressCountry",
  );
  assert.notEqual(entry, undefined);
  assert.match(entry?.reason ?? "", /two-letter code/);
});

test("a page carrying no JobPosting block leaves every parity rule not applied", () => {
  const report = parityOf(EN_TEXT, undefined, "en-US");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.notApplied.map((entry) => entry.ruleId).sort(),
    PARITY_RULES.map((rule) => rule.id).sort(),
  );
  for (const entry of report.notApplied) {
    assert.match(entry.reason, /no JobPosting block/);
  }
});

test("every parity finding comes from a parity rule, and the rules compose", () => {
  const rules: readonly Rule[] = [...RULES, ...PARITY_RULES];
  assert.deepEqual(registryProblems(rules), []);
  const reached = checkJurisdiction({ onsiteLocation: "US-TX", employerHeadcount: 40 }, rules).reached;

  const findings = [
    ...parityOf(EN_TEXT, { ...EN_MARKUP, title: "Senior Engineer" }, "en-US").findings,
    ...parityOf(EN_TEXT, EN_MARKUP).findings,
    ...parityOf(EN_TEXT.replace("$120,000", "$120,00"), EN_MARKUP, "en-US").findings,
    ...parityOf(EN_TEXT, { ...EN_MARKUP, baseSalary: salaryOf("EUR", 130000, 150000) }, "en-US")
      .findings,
    ...parityOf(EN_TEXT, { ...EN_MARKUP, jobLocation: placeOf("Boston", "US") }, "en-US").findings,
  ];
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    const rule = PARITY_RULES.find((candidate) => candidate.id === finding.ruleId);
    assert.notEqual(rule, undefined, `${finding.ruleId} is not a parity rule`);
    assert.equal(rule?.kind, "shape");
    assert.equal(rule === undefined ? undefined : severityOf(rule), finding.severity);
    assert.ok(reached.includes(finding.ruleId), `${finding.ruleId} should be reached everywhere`);
  }
});

test("two runs over the same page and markup report identically", () => {
  for (const posting of CASES) {
    assert.deepEqual(
      parityOf(posting.text, posting.markup, posting.locale),
      parityOf(posting.text, posting.markup, posting.locale),
    );
  }
});
