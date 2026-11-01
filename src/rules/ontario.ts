import type { Finding, Posting } from "../model.ts";
import { sortFindings } from "../model.ts";
import type { CitedRule } from "./registry.ts";
import { applicabilityOn, severityOf } from "./registry.ts";

export const ONTARIO_EFFECTIVE_FROM = "2026-01-01";
export const ONTARIO_MIN_HEADCOUNT = 25;
export const ONTARIO_CURRENCY = "CAD";
export const MAX_RANGE_SPREAD = 50000;
export const EXEMPT_ABOVE_PER_YEAR = 200000;
export const EXEMPTION_PERIOD = "YEAR";

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

export const ONTARIO_RULES: readonly CitedRule[] = [
  COMPENSATION_MISSING,
  RANGE_TOO_WIDE,
  VACANCY_NOT_STATED,
];

export interface OntarioManifest {
  readonly employerHeadcount?: number;
  readonly internalPosting?: boolean;
  readonly generalRecruitmentCampaign?: boolean;
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
}

const CITATION_NOTE =
  "Sections are cited as read on www.ontario.ca/laws; a rule whose section is not confirmed there is registered as unverified and warns rather than fails.";

const HEADCOUNT_UNKNOWN_NOTE = `The manifest states no whole number of employees, so the ${ONTARIO_MIN_HEADCOUNT}-employee threshold counts as met (fail-closed).`;

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

  return {
    applies: notApplied.length === 0,
    findings: sortFindings(findings),
    notApplied,
    notes,
    spread,
    thresholdComputed,
    exempt,
  };
}
