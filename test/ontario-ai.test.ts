import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CANADIAN_EXPERIENCE_PHRASES,
  matchCanadianExperience,
} from "../src/lexicon/canadian-experience.ts";
import type { PayRange, Posting } from "../src/model.ts";
import { normalizeText } from "../src/model.ts";
import type { OntarioManifest, OntarioPipeline, OntarioReport } from "../src/rules/ontario.ts";
import {
  AI_DISCLOSURE,
  AI_DISCLOSURE_WITHOUT_AI,
  CANADIAN_EXPERIENCE,
  checkOntario,
} from "../src/rules/ontario.ts";

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

const EMPLOYER: OntarioManifest = { employerHeadcount: 40 };

const AI_SENTENCE = "Acme uses artificial intelligence to screen applicants for this role.";

function ruleIds(report: OntarioReport): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

function withPipeline(
  pipeline: OntarioPipeline,
  visibleText: string = POSTING.visibleText,
): OntarioReport {
  return checkOntario({ ...POSTING, visibleText }, { ...EMPLOYER, pipeline }, "2026-02-01");
}

function reportFor(posting: Posting): OntarioReport {
  return checkOntario(posting, EMPLOYER, "2026-02-01");
}

test("an AI-assisted screening step with no disclosure in the visible text fails", () => {
  const report = withPipeline({
    steps: [{ type: "screening", aiAssisted: true }, { type: "interview" }],
    aiDisclosure: AI_SENTENCE,
  });
  assert.deepEqual(ruleIds(report), [AI_DISCLOSURE.id]);
  assert.equal(report.findings[0]?.at, "/visibleText");
  assert.equal(report.findings[0]?.severity, "error");
  assert.deepEqual(report.aiAssistedSteps, ["screening"]);
  assert.equal(report.aiDisclosureStated, false);
  assert.match(report.findings[0]?.message ?? "", /does not appear in the visible text/);
});

test("the declared sentence reaching the visible text passes", () => {
  for (const visibleText of [
    `${POSTING.visibleText} ${AI_SENTENCE}`,
    `${POSTING.visibleText} ACME USES ARTIFICIAL   INTELLIGENCE\n  to screen applicants for this role.`,
  ]) {
    const report = withPipeline(
      { steps: [{ type: "Screening", aiAssisted: true }], aiDisclosure: AI_SENTENCE },
      visibleText,
    );
    assert.deepEqual(report.findings, []);
    assert.equal(report.aiDisclosureStated, true);
  }
});

test("only a screening, assessment or selection step carries the duty", () => {
  for (const type of ["screening", "assessment", "selection"]) {
    const report = withPipeline({ steps: [{ type, aiAssisted: true }] });
    assert.deepEqual(ruleIds(report), [AI_DISCLOSURE.id]);
    assert.match(report.findings[0]?.message ?? "", /declares no AI-use disclosure sentence/);
  }
  for (const type of ["interview", "offer", "scheduling"]) {
    const report = withPipeline({ steps: [{ type, aiAssisted: true }] });
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.aiAssistedSteps, []);
  }
});

test("a disclosure with no AI step in the pipeline is only a warning", () => {
  const report = withPipeline(
    {
      steps: [{ type: "screening" }, { type: "interview", aiAssisted: true }],
      aiDisclosure: AI_SENTENCE,
    },
    `${POSTING.visibleText} ${AI_SENTENCE}`,
  );
  assert.deepEqual(ruleIds(report), [AI_DISCLOSURE_WITHOUT_AI.id]);
  assert.equal(report.findings[0]?.severity, "warning");
  assert.equal(report.findings[0]?.at, "/visibleText");
});

test("a manifest with no pipeline reads no AI step and says so", () => {
  const report = reportFor(POSTING);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.aiAssistedSteps, []);
  assert.equal(report.aiDisclosureStated, false);
  assert.ok(report.notes.some((note) => /no pipeline/.test(note)));
});

test("the AI rules are not applied below 25 employees", () => {
  const report = checkOntario(
    { ...POSTING, visibleText: `${POSTING.visibleText} Canadian experience required.` },
    { employerHeadcount: 24, pipeline: { steps: [{ type: "screening", aiAssisted: true }] } },
    "2026-02-01",
  );
  assert.deepEqual(report.findings, []);
  for (const ruleId of [AI_DISCLOSURE.id, CANADIAN_EXPERIENCE.id]) {
    assert.ok(report.notApplied.some((entry) => entry.ruleId === ruleId), ruleId);
  }
});

test("a Canadian-experience requirement in the posting text fails with the phrase quoted", () => {
  const report = reportFor({
    ...POSTING,
    visibleText: "Acme Robotics is hiring a Staff Engineer. 5 years of Canadian experience required.",
  });
  assert.deepEqual(ruleIds(report), [CANADIAN_EXPERIENCE.id]);
  assert.equal(report.findings[0]?.at, "/visibleText");
  assert.equal(report.findings[0]?.severity, "error");
  assert.match(report.findings[0]?.message ?? "", /"Canadian experience"/);
});

test("a form field asking for Canadian experience fails at that field", () => {
  const labelled = reportFor({
    ...POSTING,
    applicationForm: {
      fields: [
        { name: "legalName", label: "Legal name", type: "text" },
        { name: "yearsHere", label: "Years of experience in Canada", type: "number" },
      ],
    },
  });
  assert.deepEqual(ruleIds(labelled), [CANADIAN_EXPERIENCE.id]);
  assert.equal(labelled.findings[0]?.at, "/applicationForm/fields/1");
  assert.match(labelled.findings[0]?.message ?? "", /"experience in Canada"/);

  const options = reportFor({
    ...POSTING,
    applicationForm: {
      fields: [{ name: "q1", label: "Select one", options: ["I have Canadian experience", "None"] }],
    },
  });
  assert.deepEqual(ruleIds(options), [CANADIAN_EXPERIENCE.id]);
  assert.equal(options.findings[0]?.at, "/applicationForm/fields/0");
});

test("matching is case-insensitive on normalized whitespace", () => {
  const report = reportFor({
    ...POSTING,
    visibleText: "Acme asks for CANADIAN\n   EXPERIENCE only.",
  });
  assert.deepEqual(ruleIds(report), [CANADIAN_EXPERIENCE.id]);
});

test("a posting and a form that ask for neither pass", () => {
  const report = reportFor({
    ...POSTING,
    applicationForm: { fields: [{ name: "canadian", label: "Experience with robotics" }] },
  });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(matchCanadianExperience("Acme Robotics hires nationwide."), []);
});

test("the lexicon carries no empty, duplicated or overlapping phrase", () => {
  const seen = new Set<string>();
  for (const phrase of CANADIAN_EXPERIENCE_PHRASES) {
    const normalized = normalizeText(phrase);
    assert.notEqual(normalized, "");
    assert.equal(seen.has(normalized), false, phrase);
    seen.add(normalized);
  }
  for (const phrase of CANADIAN_EXPERIENCE_PHRASES) {
    assert.deepEqual(matchCanadianExperience(phrase), [phrase], phrase);
  }
});

test("two runs over the same posting and pipeline report identically", () => {
  const pipeline: OntarioPipeline = {
    steps: [{ type: "screening", aiAssisted: true }],
    aiDisclosure: AI_SENTENCE,
  };
  assert.deepEqual(withPipeline(pipeline), withPipeline(pipeline));
});
