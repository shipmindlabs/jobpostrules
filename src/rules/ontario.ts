import type { Finding, FormField, Posting } from "../model.ts";
import { normalizeText, sortFindings } from "../model.ts";
import { matchCanadianExperience } from "../lexicon/canadian-experience.ts";
import type { CitedRule } from "./registry.ts";
import { applicabilityOn, severityOf } from "./registry.ts";

export const ONTARIO_EFFECTIVE_FROM = "2026-01-01";
export const ONTARIO_MIN_HEADCOUNT = 25;
export const ONTARIO_CURRENCY = "CAD";
export const MAX_RANGE_SPREAD = 50000;
export const EXEMPT_ABOVE_PER_YEAR = 200000;
export const EXEMPTION_PERIOD = "YEAR";
export const AI_SELECTION_STEP_TYPES = ["screening", "assessment", "selection"] as const;

const ESA_URL = "https://www.ontario.ca/laws/statute/00e41";
const REG_476_24_URL = "https://www.ontario.ca/laws/regulation/r24476";
const READ_AT = "2026-11-01";

export const COMPENSATION_MISSING: CitedRule = {
  id: "ca-on/compensation-missing",
  kind: "law",
  jurisdiction: "CA-ON",
  status: "in-force",
  summary:
    "A publicly advertised job posting states the expected compensation for the position or a range of expected compensation.",
  citation: { url: ESA_URL, section: "ESA 2000, s. 8.4 (1)", verifiedAt: READ_AT },
  effectiveFrom: ONTARIO_EFFECTIVE_FROM,
  minHeadcount: ONTARIO_MIN_HEADCOUNT,
};

export const RANGE_TOO_WIDE: CitedRule = {
  id: "ca-on/range-too-wide",
  kind: "law",
  jurisdiction: "CA-ON",
  status: "unverified",
  summary:
    "A stated CAD range is no wider than 50,000 unless the expected pay or the top of the range is above 200,000 a year. The section of O. Reg. 476/24 carrying the width is not confirmed on www.ontario.ca/laws yet, so the rule warns rather than fails.",
  citation: { url: REG_476_24_URL, section: "O. Reg. 476/24, s. 2", verifiedAt: READ_AT },
  effectiveFrom: ONTARIO_EFFECTIVE_FROM,
  minHeadcount: ONTARIO_MIN_HEADCOUNT,
};

export const VACANCY_NOT_STATED: CitedRule = {
  id: "ca-on/vacancy-not-stated",
  kind: "law",
  jurisdiction: "CA-ON",
  status: "unverified",
  summary:
    "A publicly advertised job posting states whether or not it is for an existing vacancy. The section numbering inside Part III.1 is not confirmed on www.ontario.ca/laws yet, so the rule warns rather than fails.",
  citation: { url: ESA_URL, section: "ESA 2000, s. 8.4.1 (1)", verifiedAt: READ_AT },
  effectiveFrom: ONTARIO_EFFECTIVE_FROM,
  minHeadcount: ONTARIO_MIN_HEADCOUNT,
};

export const AI_DISCLOSURE: CitedRule = {
  id: "ca-on/ai-disclosure",
  kind: "law",
  jurisdiction: "CA-ON",
  status: "in-force",
  summary:
    "A publicly advertised job posting whose employer uses artificial intelligence to screen, assess or select applicants for the position states that use in the posting.",
  citation: { url: ESA_URL, section: "ESA 2000, s. 8.5", verifiedAt: READ_AT },
  effectiveFrom: ONTARIO_EFFECTIVE_FROM,
  minHeadcount: ONTARIO_MIN_HEADCOUNT,
};

export const AI_DISCLOSURE_WITHOUT_AI: CitedRule = {
  id: "ca-on/ai-disclosure-without-ai",
  kind: "law",
  jurisdiction: "CA-ON",
  status: "advisory",
  summary:
    "The duty attaches to the use of artificial intelligence, not to the sentence: a posting disclosing a use that no screening, assessment or selection step in the pipeline declares is a mismatch between the ad and the pipeline, so it warns rather than fails.",
  citation: { url: ESA_URL, section: "ESA 2000, s. 8.5", verifiedAt: READ_AT },
  effectiveFrom: ONTARIO_EFFECTIVE_FROM,
  minHeadcount: ONTARIO_MIN_HEADCOUNT,
};

export const CANADIAN_EXPERIENCE: CitedRule = {
  id: "ca-on/canadian-experience",
  kind: "law",
  jurisdiction: "CA-ON",
  status: "in-force",
  summary:
    "A publicly advertised job posting and any associated application form carry no requirement related to Canadian experience.",
  citation: { url: ESA_URL, section: "ESA 2000, s. 8.6", verifiedAt: READ_AT },
  effectiveFrom: ONTARIO_EFFECTIVE_FROM,
  minHeadcount: ONTARIO_MIN_HEADCOUNT,
};

export const ONTARIO_RULES: readonly CitedRule[] = [
  COMPENSATION_MISSING,
  RANGE_TOO_WIDE,
  VACANCY_NOT_STATED,
  AI_DISCLOSURE,
  AI_DISCLOSURE_WITHOUT_AI,
  CANADIAN_EXPERIENCE,
];

export interface OntarioPipelineStep {
  readonly type: string;
  readonly aiAssisted?: boolean;
}

export interface OntarioPipeline {
  readonly steps?: readonly OntarioPipelineStep[];
  readonly aiDisclosure?: string;
}

export interface OntarioManifest {
  readonly employerHeadcount?: number;
  readonly internalPosting?: boolean;
  readonly generalRecruitmentCampaign?: boolean;
  readonly pipeline?: OntarioPipeline;
}

export interface OntarioNotApplied {
  readonly ruleId: string;
  readonly reason: string;
}

export interface OntarioReport {
  readonly applies: boolean;
  readonly findings: readonly Finding[];
  readonly notApplied: readonly OntarioNotApplied[];
  readonly notes: readonly string[];
  readonly spread?: number;
  readonly thresholdComputed: boolean;
  readonly exempt: boolean;
  readonly aiAssistedSteps: readonly string[];
  readonly aiDisclosureStated: boolean;
}

const CITATION_NOTE =
  "Sections are cited as read on www.ontario.ca/laws; a rule whose section is not confirmed there is registered as unverified and warns rather than fails.";

const HEADCOUNT_UNKNOWN_NOTE = `The manifest states no whole number of employees, so the ${ONTARIO_MIN_HEADCOUNT}-employee threshold counts as met (fail-closed).`;

const PIPELINE_UNKNOWN_NOTE =
  "The manifest declares no pipeline, so no step is read as letting artificial intelligence screen, assess or select applicants and the AI-use disclosure is not read.";

function headcountKnown(stated: number | undefined): boolean {
  return stated !== undefined && Number.isInteger(stated) && stated >= 0;
}

function notApplicableReason(
  rule: CitedRule,
  manifest: OntarioManifest,
  asOf: string | undefined,
): string | undefined {
  if (manifest.internalPosting === true) {
    return "the manifest declares an internal posting, which is not a publicly advertised job posting";
  }
  if (manifest.generalRecruitmentCampaign === true) {
    return "the manifest declares a general recruitment campaign, which is not a publicly advertised job posting";
  }
  const stated = manifest.employerHeadcount;
  if (stated !== undefined && headcountKnown(stated) && stated < ONTARIO_MIN_HEADCOUNT) {
    return `the rules cover an employer with ${ONTARIO_MIN_HEADCOUNT} employees or more on the posting date; the manifest states ${stated}`;
  }
  if (asOf !== undefined) {
    const applicability = applicabilityOn(rule, asOf);
    if (!applicability.applies) {
      return applicability.reason;
    }
  }
  return undefined;
}

function aiAssistedSelectionSteps(pipeline: OntarioPipeline | undefined): string[] {
  const types = AI_SELECTION_STEP_TYPES as readonly string[];
  return (pipeline?.steps ?? [])
    .filter((step) => step.aiAssisted === true && types.includes(normalizeText(step.type)))
    .map((step) => normalizeText(step.type));
}

function disclosureStated(posting: Posting, pipeline: OntarioPipeline | undefined): boolean {
  const sentence = pipeline?.aiDisclosure;
  if (sentence === undefined || sentence.trim() === "") {
    return false;
  }
  return normalizeText(posting.visibleText).includes(normalizeText(sentence));
}

function fieldText(field: FormField): string {
  return [field.name, field.label, ...(field.options ?? [])]
    .filter((part): part is string => part !== undefined)
    .join(" | ");
}

function quotePhrases(phrases: readonly string[]): string {
  return phrases.map((phrase) => JSON.stringify(phrase)).join("; ");
}

export function checkOntario(
  posting: Posting,
  manifest: OntarioManifest = {},
  asOf?: string,
): OntarioReport {
  const notes: string[] = [CITATION_NOTE];
  if (!headcountKnown(manifest.employerHeadcount)) {
    notes.push(HEADCOUNT_UNKNOWN_NOTE);
  }

  const notApplied: OntarioNotApplied[] = [];
  const active = new Set<string>();
  for (const rule of ONTARIO_RULES) {
    const reason = notApplicableReason(rule, manifest, asOf);
    if (reason === undefined) {
      active.add(rule.id);
    } else {
      notApplied.push({ ruleId: rule.id, reason });
    }
  }

  const findings: Finding[] = [];
  const range = posting.payRange;
  let spread: number | undefined;
  let thresholdComputed = false;
  let exempt = false;

  if (range === undefined) {
    if (active.has(COMPENSATION_MISSING.id)) {
      findings.push({
        ruleId: COMPENSATION_MISSING.id,
        severity: severityOf(COMPENSATION_MISSING),
        message:
          "The posting states neither the expected pay nor a range of expected pay; expected pay stated as one figure is a range whose ends coincide.",
        at: "/payRange",
      });
    }
  } else {
    spread = range.max - range.min;
    if (range.currency !== ONTARIO_CURRENCY) {
      notes.push(
        `The ${MAX_RANGE_SPREAD} limit on the width of a range is read for a ${ONTARIO_CURRENCY} range; the posting states ${range.currency}, so the width was not measured against it and the threshold was not computed.`,
      );
    } else if (range.period !== EXEMPTION_PERIOD) {
      notes.push(
        `The exemption above ${EXEMPT_ABOVE_PER_YEAR} a year is computed for a ${EXEMPTION_PERIOD} range only; the posting states a ${range.period} range, so the threshold was not computed and no exemption is read.`,
      );
    } else {
      thresholdComputed = true;
      exempt = range.max > EXEMPT_ABOVE_PER_YEAR;
    }

    if (
      active.has(RANGE_TOO_WIDE.id) &&
      range.currency === ONTARIO_CURRENCY &&
      spread > MAX_RANGE_SPREAD &&
      !exempt
    ) {
      findings.push({
        ruleId: RANGE_TOO_WIDE.id,
        severity: severityOf(RANGE_TOO_WIDE),
        message: `The ${ONTARIO_CURRENCY} range runs from ${range.min} to ${range.max}, a spread of ${spread}; a stated range is no wider than ${MAX_RANGE_SPREAD} unless the expected pay or the top of the range is above ${EXEMPT_ABOVE_PER_YEAR} a year.`,
        at: "/payRange/max",
      });
    }
  }

  if (active.has(VACANCY_NOT_STATED.id) && posting.existingVacancy === undefined) {
    findings.push({
      ruleId: VACANCY_NOT_STATED.id,
      severity: severityOf(VACANCY_NOT_STATED),
      message:
        "The posting does not say whether it is for an existing vacancy; state existingVacancy as true or false.",
      at: "/existingVacancy",
    });
  }

  const pipeline = manifest.pipeline;
  const aiAssistedSteps = aiAssistedSelectionSteps(pipeline);
  const aiDisclosureStated = disclosureStated(posting, pipeline);

  if (pipeline === undefined) {
    notes.push(PIPELINE_UNKNOWN_NOTE);
  } else if (aiAssistedSteps.length > 0) {
    if (!aiDisclosureStated && active.has(AI_DISCLOSURE.id)) {
      const sentence = pipeline.aiDisclosure;
      const detail =
        sentence === undefined || sentence.trim() === ""
          ? "the pipeline declares no AI-use disclosure sentence"
          : `the declared sentence ${JSON.stringify(sentence)} does not appear in the visible text`;
      findings.push({
        ruleId: AI_DISCLOSURE.id,
        severity: severityOf(AI_DISCLOSURE),
        message: `Artificial intelligence screens, assesses or selects applicants at ${aiAssistedSteps.join(", ")}, so the posting states that use: ${detail}.`,
        at: "/visibleText",
      });
    }
  } else if (aiDisclosureStated && active.has(AI_DISCLOSURE_WITHOUT_AI.id)) {
    findings.push({
      ruleId: AI_DISCLOSURE_WITHOUT_AI.id,
      severity: severityOf(AI_DISCLOSURE_WITHOUT_AI),
      message:
        "The visible text states the use of artificial intelligence while no screening, assessment or selection step in the pipeline is declared aiAssisted; the duty attaches to the use, so this is a mismatch between the ad and the pipeline rather than a breach.",
      at: "/visibleText",
    });
  }

  if (active.has(CANADIAN_EXPERIENCE.id)) {
    const inText = matchCanadianExperience(posting.visibleText);
    if (inText.length > 0) {
      findings.push({
        ruleId: CANADIAN_EXPERIENCE.id,
        severity: severityOf(CANADIAN_EXPERIENCE),
        message: `The visible text carries a requirement related to Canadian experience (${quotePhrases(inText)}); a publicly advertised job posting carries none.`,
        at: "/visibleText",
      });
    }
    for (const [index, field] of (posting.applicationForm?.fields ?? []).entries()) {
      const matched = matchCanadianExperience(fieldText(field));
      if (matched.length > 0) {
        findings.push({
          ruleId: CANADIAN_EXPERIENCE.id,
          severity: severityOf(CANADIAN_EXPERIENCE),
          message: `An application form field asks for Canadian experience (${quotePhrases(matched)}); neither the posting nor an associated application form carries such a requirement.`,
          at: `/applicationForm/fields/${index}`,
        });
      }
    }
  }

  return {
    applies: notApplied.length === 0,
    findings: sortFindings(findings),
    notApplied,
    notes,
    spread,
    thresholdComputed,
    exempt,
    aiAssistedSteps,
    aiDisclosureStated,
  };
}
