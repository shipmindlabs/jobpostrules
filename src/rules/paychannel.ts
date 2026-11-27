import { matchPayHistory } from "../lexicon/pay-history.ts";
import type { Finding, FormField, Posting } from "../model.ts";
import { normalizeText, sortFindings } from "../model.ts";
import type { CitedRule } from "./registry.ts";
import { applicabilityOn, severityOf } from "./registry.ts";

export const PAY_CHANNELS = ["in-ad", "before-first-interview", "on-request"] as const;

export type PayChannel = (typeof PAY_CHANNELS)[number];

export interface PayObligation {
  readonly ruleId?: string;
  readonly channel: string;
}

export interface PayChannelStep {
  readonly type: string;
  readonly payRangeSent?: boolean;
}

export interface PayChannelPipeline {
  readonly steps?: readonly PayChannelStep[];
}

export interface PayChannelManifest {
  readonly payObligations?: readonly PayObligation[];
  readonly pipeline?: PayChannelPipeline;
}

export const PAY_HISTORY: CitedRule = {
  id: "form/pay-history",
  kind: "law",
  jurisdiction: "PL",
  status: "unverified",
  summary: "The application form asks the applicant what they are paid now or were paid before.",
  citation: {
    url: "https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19740240141",
    section: "Art. 18(3f) § 2",
    verifiedAt: "2026-11-27",
  },
  effectiveFrom: "2025-12-24",
};

export const PAY_HISTORY_DIRECTIVE: CitedRule = {
  id: "form/pay-history-directive",
  kind: "law",
  jurisdiction: "EU",
  status: "advisory",
  summary:
    "A pay-history question read against Directive 2023/970, which binds the member state rather than the employer.",
  citation: {
    url: "https://eur-lex.europa.eu/eli/dir/2023/970/oj",
    section: "Article 5(2)",
    verifiedAt: "2026-11-27",
  },
  effectiveFrom: "2026-06-07",
};

interface PayHistoryObligation {
  readonly rule: CitedRule;
  readonly because: string;
}

const PAY_HISTORY_OBLIGATIONS: readonly PayHistoryObligation[] = [
  {
    rule: PAY_HISTORY,
    because:
      "Art. 18(3f) § 2 of the Labour Code, in force from 2025-12-24, is in the lint from a secondary source, so the question warns until the text on isap.sejm.gov.pl is read",
  },
  {
    rule: PAY_HISTORY_DIRECTIVE,
    because:
      "Directive 2023/970 art. 5(2) binds the member state rather than the employer, so the question warns rather than fails",
  },
];

export const PAY_HISTORY_RULES: readonly CitedRule[] = PAY_HISTORY_OBLIGATIONS.map(
  (obligation) => obligation.rule,
);

export interface PayChannelNotChecked {
  readonly channel: string;
  readonly reason: string;
}

export interface PayChannelNotApplied {
  readonly ruleId: string;
  readonly reason: string;
}

export interface PayHistoryQuestion {
  readonly at: string;
  readonly phrase: string;
}

export interface PayChannelReport {
  readonly findings: readonly Finding[];
  readonly adStatesRange: boolean;
  readonly payRangeSentStep?: number;
  readonly firstInterviewStep?: number;
  readonly channels: readonly string[];
  readonly payHistoryQuestions: readonly PayHistoryQuestion[];
  readonly notChecked: readonly PayChannelNotChecked[];
  readonly notApplied: readonly PayChannelNotApplied[];
  readonly notes: readonly string[];
}

const PAY_RANGE_SENT_TYPE = "pay-range-sent";
const INTERVIEW_TYPE = "interview";

const NO_OBLIGATION_NOTE = "The manifest declares no pay obligation, so no channel was read.";

const NO_PIPELINE_NOTE =
  "The manifest declares no pipeline, so no step was read as sending the range to the candidate.";

const NO_FORM_NOTE =
  "The posting carries no application form schema, so no field was scanned for a pay-history question.";

const UNVERIFIED_NOTE =
  "form/pay-history is registered as unverified: the article is in the lint from a secondary source, so it warns until the text on isap.sejm.gov.pl is read.";

function isPayChannel(value: string): value is PayChannel {
  return (PAY_CHANNELS as readonly string[]).includes(value);
}

function sendsPayRange(step: PayChannelStep): boolean {
  return step.payRangeSent === true || normalizeText(step.type) === PAY_RANGE_SENT_TYPE;
}

function isInterview(step: PayChannelStep): boolean {
  return normalizeText(step.type) === INTERVIEW_TYPE;
}

function stepIndex(
  steps: readonly PayChannelStep[],
  matches: (step: PayChannelStep) => boolean,
): number | undefined {
  const index = steps.findIndex(matches);
  return index === -1 ? undefined : index;
}

function tooLateFinding(
  adStatesRange: boolean,
  steps: readonly PayChannelStep[],
  payRangeSentStep: number | undefined,
  firstInterviewStep: number | undefined,
): Finding | undefined {
  if (adStatesRange) {
    return undefined;
  }
  if (payRangeSentStep === undefined) {
    return {
      ruleId: "pay-channel/too-late",
      severity: "error",
      message:
        steps.length === 0
          ? "A before-first-interview obligation is declared, the ad states no range and the manifest declares no pipeline: nothing states the range to the candidate before the first interview."
          : "A before-first-interview obligation is declared, the ad states no range and no pipeline step sends the range: nothing states it to the candidate before the first interview.",
      at: "/pipeline/steps",
    };
  }
  if (firstInterviewStep === undefined || payRangeSentStep < firstInterviewStep) {
    return undefined;
  }
  return {
    ruleId: "pay-channel/too-late",
    severity: "error",
    message:
      payRangeSentStep === firstInterviewStep
        ? `The range reaches the candidate at step ${payRangeSentStep}, the first interview itself; a before-first-interview obligation is met strictly before that step.`
        : `The range reaches the candidate at step ${payRangeSentStep}, after the first interview at step ${firstInterviewStep}; a before-first-interview obligation is met strictly before that step.`,
    at: `/pipeline/steps/${payRangeSentStep}`,
  };
}

function questionOf(field: FormField, index: number): PayHistoryQuestion | undefined {
  const asked = [field.name ?? "", field.label ?? "", ...(field.options ?? [])].join(" ");
  const [phrase] = matchPayHistory(asked);
  if (phrase === undefined) {
    return undefined;
  }
  return { at: `/applicationForm/fields/${index}`, phrase };
}

export function checkPayChannel(
  posting: Posting,
  manifest: PayChannelManifest,
  asOf: string,
): PayChannelReport {
  const findings: Finding[] = [];
  const notChecked: PayChannelNotChecked[] = [];
  const notApplied: PayChannelNotApplied[] = [];
  const notes: string[] = [];

  const steps = manifest.pipeline?.steps ?? [];
  const payRangeSentStep = stepIndex(steps, sendsPayRange);
  const firstInterviewStep = stepIndex(steps, isInterview);
  const adStatesRange = posting.payRange !== undefined;

  const obligations = manifest.payObligations ?? [];
  const channels: string[] = [];
  for (const [index, obligation] of obligations.entries()) {
    const channel = normalizeText(obligation.channel);
    channels.push(channel);
    if (!isPayChannel(channel)) {
      findings.push({
        ruleId: "pay-channel/unknown-channel",
        severity: "error",
        message: `Channel ${JSON.stringify(obligation.channel)} is outside ${PAY_CHANNELS.join(", ")}; a pay obligation reaches the candidate in the ad, before the first interview or on request.`,
        at: `/payObligations/${index}/channel`,
      });
      continue;
    }
    if (channel === "in-ad") {
      notChecked.push({
        channel,
        reason:
          "an in-ad obligation is read by the ad rule of the place that states it, not by the channel check",
      });
    }
    if (channel === "on-request") {
      notChecked.push({
        channel,
        reason:
          "an on-request obligation is met after the ad is published, so the channel check reads nothing from it",
      });
    }
  }

  if (obligations.length === 0) {
    notes.push(NO_OBLIGATION_NOTE);
  }
  if (steps.length === 0) {
    notes.push(NO_PIPELINE_NOTE);
  }

  if (channels.includes("before-first-interview")) {
    const finding = tooLateFinding(adStatesRange, steps, payRangeSentStep, firstInterviewStep);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }

  if (posting.applicationForm === undefined) {
    notes.push(NO_FORM_NOTE);
  }
  const payHistoryQuestions: PayHistoryQuestion[] = [];
  for (const [index, field] of (posting.applicationForm?.fields ?? []).entries()) {
    const question = questionOf(field, index);
    if (question !== undefined) {
      payHistoryQuestions.push(question);
    }
  }

  for (const obligation of PAY_HISTORY_OBLIGATIONS) {
    const applicability = applicabilityOn(obligation.rule, asOf);
    if (!applicability.applies) {
      notApplied.push({ ruleId: obligation.rule.id, reason: applicability.reason });
      continue;
    }
    if (obligation.rule.id === PAY_HISTORY.id) {
      notes.push(UNVERIFIED_NOTE);
    }
    for (const question of payHistoryQuestions) {
      findings.push({
        ruleId: obligation.rule.id,
        severity: severityOf(obligation.rule),
        message: `The application form asks for past or present pay (${JSON.stringify(question.phrase)}); ${obligation.because}.`,
        at: question.at,
      });
    }
  }

  return {
    findings: sortFindings(findings),
    adStatesRange,
    payRangeSentStep,
    firstInterviewStep,
    channels,
    payHistoryQuestions,
    notChecked,
    notApplied,
    notes,
  };
}
