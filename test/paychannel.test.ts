import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PAY_HISTORY_PHRASES, matchPayHistory } from "../src/lexicon/pay-history.ts";
import type { PayRange, Posting } from "../src/model.ts";
import { normalizeText } from "../src/model.ts";
import type { PayChannelManifest, PayChannelReport } from "../src/rules/paychannel.ts";
import {
  PAY_CHANNELS,
  PAY_HISTORY,
  PAY_HISTORY_DIRECTIVE,
  PAY_HISTORY_RULES,
  checkPayChannel,
} from "../src/rules/paychannel.ts";
import type { Rule } from "../src/rules/registry.ts";
import {
  RULES,
  findRule,
  registryProblems,
  ruleProblems,
  severityOf,
} from "../src/rules/registry.ts";
import { isAllowedSourceUrl } from "../src/rules/sources.ts";

const PLN_MONTH: PayRange = {
  min: 18000,
  max: 24000,
  currency: "PLN",
  period: "MONTH",
  stated: "18 000 - 24 000 zł per month",
};

const POSTING: Posting = {
  visibleText: "Acme Robotics is hiring a Staff Engineer in Warsaw. Apply at jobs.example.com.",
  datePosted: "2026-07-01",
  payRange: PLN_MONTH,
};

const SILENT: Posting = { ...POSTING, payRange: undefined };

const BEFORE: PayChannelManifest = {
  payObligations: [{ ruleId: "fixture/pl-before-interview", channel: "before-first-interview" }],
};

const ASKS_CURRENT_SALARY: Posting = {
  ...POSTING,
  applicationForm: {
    fields: [
      { name: "legalName", label: "Legal name", type: "text" },
      { name: "currentSalary", label: "What is your current salary?", type: "number" },
    ],
  },
};

function reportFor(
  posting: Posting,
  manifest: PayChannelManifest,
  asOf = "2026-07-01",
): PayChannelReport {
  return checkPayChannel(posting, manifest, asOf);
}

function ruleIds(report: PayChannelReport): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

function withSteps(steps: PayChannelManifest["pipeline"]): PayChannelManifest {
  return { ...BEFORE, pipeline: steps };
}

test("an ad stating the range meets a before-first-interview obligation", () => {
  const report = reportFor(POSTING, withSteps({ steps: [{ type: "interview" }] }));
  assert.deepEqual(report.findings, []);
  assert.equal(report.adStatesRange, true);
  assert.deepEqual(report.channels, ["before-first-interview"]);
});

test("a pay-range-sent step strictly before the first interview meets it", () => {
  const report = reportFor(
    SILENT,
    withSteps({ steps: [{ type: "screening" }, { type: "pay-range-sent" }, { type: "interview" }] }),
  );
  assert.deepEqual(report.findings, []);
  assert.equal(report.payRangeSentStep, 1);
  assert.equal(report.firstInterviewStep, 2);
});

test("the same step or later is too late", () => {
  const later = reportFor(
    SILENT,
    withSteps({ steps: [{ type: "interview" }, { type: "pay-range-sent" }] }),
  );
  assert.deepEqual(ruleIds(later), ["pay-channel/too-late"]);
  assert.equal(later.findings[0]?.severity, "error");
  assert.equal(later.findings[0]?.at, "/pipeline/steps/1");
  assert.match(later.findings[0]?.message ?? "", /after the first interview at step 0/);

  const same = reportFor(
    SILENT,
    withSteps({ steps: [{ type: "interview", payRangeSent: true }] }),
  );
  assert.deepEqual(ruleIds(same), ["pay-channel/too-late"]);
  assert.equal(same.findings[0]?.at, "/pipeline/steps/0");
  assert.match(same.findings[0]?.message ?? "", /the first interview itself/);
});

test("no step sending the range is too late, and so is no pipeline at all", () => {
  const silentPipeline = reportFor(
    SILENT,
    withSteps({ steps: [{ type: "screening" }, { type: "interview" }] }),
  );
  assert.deepEqual(ruleIds(silentPipeline), ["pay-channel/too-late"]);
  assert.equal(silentPipeline.findings[0]?.at, "/pipeline/steps");
  assert.match(silentPipeline.findings[0]?.message ?? "", /no pipeline step sends the range/);
  assert.equal(silentPipeline.payRangeSentStep, undefined);

  const noPipeline = reportFor(SILENT, BEFORE);
  assert.deepEqual(ruleIds(noPipeline), ["pay-channel/too-late"]);
  assert.match(noPipeline.findings[0]?.message ?? "", /declares no pipeline/);
  assert.ok(noPipeline.notes.some((note) => /declares no pipeline/.test(note)));
});

test("an in-ad or on-request obligation is not read by the channel check", () => {
  for (const channel of ["in-ad", "on-request"]) {
    const report = reportFor(SILENT, { payObligations: [{ channel }] });
    assert.deepEqual(report.findings, []);
    assert.deepEqual(
      report.notChecked.map((entry) => entry.channel),
      [channel],
    );
  }
});

test("a channel outside the three is a finding", () => {
  assert.deepEqual([...PAY_CHANNELS], ["in-ad", "before-first-interview", "on-request"]);
  const report = reportFor(SILENT, { payObligations: [{ channel: "by email" }] });
  assert.deepEqual(ruleIds(report), ["pay-channel/unknown-channel"]);
  assert.equal(report.findings[0]?.at, "/payObligations/0/channel");
  assert.equal(report.findings[0]?.severity, "error");
});

test("a manifest declaring no obligation reads no channel", () => {
  const report = reportFor(SILENT, {});
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.channels, []);
  assert.ok(report.notes.some((note) => /no pay obligation/.test(note)));
});

test("an Acme form asking for current salary fails in Poland and warns under the Directive", () => {
  const report = reportFor(ASKS_CURRENT_SALARY, {});
  assert.deepEqual(ruleIds(report), [PAY_HISTORY.id, PAY_HISTORY_DIRECTIVE.id]);
  assert.deepEqual(report.payHistoryQuestions, [
    { at: "/applicationForm/fields/1", phrase: "current salary" },
  ]);
  for (const finding of report.findings) {
    assert.equal(finding.at, "/applicationForm/fields/1");
    assert.equal(finding.severity, "warning");
    assert.match(finding.message, /"current salary"/);
  }
  assert.equal(PAY_HISTORY.status, "unverified");
  assert.equal(PAY_HISTORY_DIRECTIVE.status, "advisory");
  assert.match(report.findings[0]?.message ?? "", /isap\.sejm\.gov\.pl/);
  assert.match(report.findings[1]?.message ?? "", /binds the member state/);
  assert.ok(report.notes.some((note) => /unverified/.test(note)));
});

test("the Directive is not applied before it is transposed", () => {
  const report = reportFor(ASKS_CURRENT_SALARY, {}, "2026-01-15");
  assert.deepEqual(ruleIds(report), [PAY_HISTORY.id]);
  assert.deepEqual(report.notApplied, [
    {
      ruleId: PAY_HISTORY_DIRECTIVE.id,
      reason: "the rule takes effect on 2026-06-07, after the as-of date 2026-01-15",
    },
  ]);
});

test("before 2025-12-24 neither pay-history rule is applied", () => {
  const report = reportFor(ASKS_CURRENT_SALARY, {}, "2025-12-23");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.notApplied.map((entry) => entry.ruleId),
    PAY_HISTORY_RULES.map((rule) => rule.id),
  );
});

test("a field name, a label and an option are all scanned, in English and Polish", () => {
  for (const posting of [
    { ...POSTING, applicationForm: { fields: [{ name: "current_salary" }] } },
    { ...POSTING, applicationForm: { fields: [{ label: "Obecne wynagrodzenie" }] } },
    {
      ...POSTING,
      applicationForm: {
        fields: [{ name: "q1", label: "Select one", options: ["Historia wynagrodzeń", "None"] }],
      },
    },
  ]) {
    const report = reportFor(posting, {}, "2026-07-01");
    assert.deepEqual(ruleIds(report), [PAY_HISTORY.id, PAY_HISTORY_DIRECTIVE.id]);
    assert.equal(report.payHistoryQuestions[0]?.at, "/applicationForm/fields/0");
  }
});

test("a form that asks for neither passes, and a missing form says so", () => {
  const asks = reportFor(
    {
      ...POSTING,
      applicationForm: { fields: [{ name: "salaryExpectation", label: "Expected monthly pay" }] },
    },
    {},
  );
  assert.deepEqual(asks.findings, []);
  assert.deepEqual(matchPayHistory("Acme Robotics hires in Warsaw."), []);

  const bare = reportFor(POSTING, {});
  assert.deepEqual(bare.payHistoryQuestions, []);
  assert.ok(bare.notes.some((note) => /no application form schema/.test(note)));
});

test("the pay-history rules carry a primary-source citation and a window", () => {
  for (const rule of PAY_HISTORY_RULES) {
    assert.deepEqual(ruleProblems(rule), []);
    assert.ok(isAllowedSourceUrl(rule.citation.url), rule.id);
    assert.notEqual(severityOf(rule), "error");
  }
  assert.match(PAY_HISTORY.citation.url, /^https:\/\/isap\.sejm\.gov\.pl\//);
  assert.match(PAY_HISTORY.citation.section, /Art\./);
  assert.equal(PAY_HISTORY.effectiveFrom, "2025-12-24");
  assert.equal(PAY_HISTORY.jurisdiction, "PL");
  assert.match(PAY_HISTORY_DIRECTIVE.citation.url, /^https:\/\/eur-lex\.europa\.eu\//);
  assert.equal(PAY_HISTORY_DIRECTIVE.citation.section, "Article 5(2)");
});

test("the pay-channel rules compose with the registry", () => {
  const rules: readonly Rule[] = [...RULES, ...PAY_HISTORY_RULES];
  assert.deepEqual(registryProblems(rules), []);
  const findings = [
    ...reportFor(SILENT, BEFORE).findings,
    ...reportFor(SILENT, { payObligations: [{ channel: "by email" }] }).findings,
  ];
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    const rule = findRule(finding.ruleId);
    assert.equal(rule?.kind, "shape");
    assert.equal(rule === undefined ? undefined : severityOf(rule), finding.severity);
  }
});

test("the lexicon carries no empty, duplicated or overlapping phrase", () => {
  const seen = new Set<string>();
  for (const phrase of PAY_HISTORY_PHRASES) {
    const normalized = normalizeText(phrase);
    assert.notEqual(normalized, "");
    assert.equal(seen.has(normalized), false, phrase);
    seen.add(normalized);
    assert.deepEqual(matchPayHistory(phrase), [phrase], phrase);
  }
});

test("two runs over the same posting and manifest report identically", () => {
  const manifest = withSteps({ steps: [{ type: "interview" }, { type: "pay-range-sent" }] });
  assert.deepEqual(
    reportFor(ASKS_CURRENT_SALARY, manifest),
    reportFor(ASKS_CURRENT_SALARY, manifest),
  );
});
