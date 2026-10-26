import type { Severity } from "../model.ts";
import { isIsoDate } from "../model.ts";
import { findAllowedSource } from "./sources.ts";

export const RULE_STATUSES = ["in-force", "advisory", "unverified", "pending"] as const;

export type RuleStatus = (typeof RULE_STATUSES)[number];

export interface Citation {
  readonly url: string;
  readonly section: string;
  readonly verifiedAt: string;
}

export interface ShapeRule {
  readonly id: string;
  readonly kind: "shape";
  readonly severity: Severity;
  readonly summary: string;
}

export interface CitedRule {
  readonly id: string;
  readonly kind: "law" | "platform";
  readonly jurisdiction: string;
  readonly status: RuleStatus;
  readonly summary: string;
  readonly citation: Citation;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly minHeadcount?: number;
}

export type Rule = ShapeRule | CitedRule;

const STATUS_SEVERITY: Readonly<Record<RuleStatus, Severity>> = {
  "in-force": "error",
  advisory: "warning",
  unverified: "warning",
  pending: "info",
};

export function severityForStatus(status: RuleStatus): Severity {
  return STATUS_SEVERITY[status];
}

export function severityOf(rule: Rule): Severity {
  return rule.kind === "shape" ? rule.severity : severityForStatus(rule.status);
}

export type Applicability =
  | { readonly applies: true }
  | { readonly applies: false; readonly reason: string };

export function applicabilityOn(rule: Rule, asOf: string): Applicability {
  if (rule.kind === "shape") {
    return { applies: true };
  }
  if (asOf < rule.effectiveFrom) {
    return {
      applies: false,
      reason: `the rule takes effect on ${rule.effectiveFrom}, after the as-of date ${asOf}`,
    };
  }
  if (rule.effectiveTo !== undefined && asOf > rule.effectiveTo) {
    return {
      applies: false,
      reason: `the rule applied through ${rule.effectiveTo}, before the as-of date ${asOf}`,
    };
  }
  return { applies: true };
}

export const RULES: readonly Rule[] = [
  {
    id: "pay-range/missing",
    kind: "shape",
    severity: "error",
    summary: "The posting carries no pay range at all.",
  },
  {
    id: "pay-range/min-above-max",
    kind: "shape",
    severity: "error",
    summary: "The low end of the range is above the high end.",
  },
  {
    id: "pay-range/unknown-currency",
    kind: "shape",
    severity: "error",
    summary: "The currency is not an ISO 4217 alpha-3 code.",
  },
  {
    id: "pay-range/unknown-period",
    kind: "shape",
    severity: "error",
    summary: "The period is outside HOUR, DAY, WEEK, MONTH, YEAR.",
  },
  {
    id: "pay-range/open-ended",
    kind: "shape",
    severity: "warning",
    summary: "The stated range reads as open ended, so a candidate sees one end at most.",
  },
  {
    id: "jurisdiction/remote-without-region",
    kind: "shape",
    severity: "error",
    summary: "The posting is marked remote and names no region the role is open to.",
  },
  {
    id: "jurisdiction/unknown-region",
    kind: "shape",
    severity: "error",
    summary: "A named region is neither an ISO 3166-1 country nor an ISO 3166-2 subdivision.",
  },
  {
    id: "jurisdiction/unknown-headcount",
    kind: "shape",
    severity: "warning",
    summary: "The employer headcount is not stated, so every headcount threshold counts as met.",
  },
];

export function findRule(id: string): Rule | undefined {
  return RULES.find((rule) => rule.id === id);
}

export interface RuleProblem {
  readonly ruleId: string;
  readonly problem: string;
}

export function ruleProblems(rule: Rule): string[] {
  const problems: string[] = [];
  if (rule.id.trim() === "") {
    problems.push("the id is empty");
  }
  if (rule.kind === "shape") {
    return problems;
  }
  if (rule.jurisdiction.trim() === "") {
    problems.push("the jurisdiction is empty");
  }
  const { url, section, verifiedAt } = rule.citation;
  if (url.trim() === "") {
    problems.push("the citation carries no url");
  }
  if (section.trim() === "") {
    problems.push("the citation carries no section");
  }
  if (verifiedAt.trim() === "") {
    problems.push("the citation carries no verifiedAt date");
  } else if (!isIsoDate(verifiedAt)) {
    problems.push(`verifiedAt ${JSON.stringify(verifiedAt)} is not a YYYY-MM-DD date`);
  }
  const { effectiveFrom, effectiveTo } = rule;
  if (effectiveFrom.trim() === "") {
    problems.push("the rule carries no effectiveFrom date");
  } else if (!isIsoDate(effectiveFrom)) {
    problems.push(`effectiveFrom ${JSON.stringify(effectiveFrom)} is not a YYYY-MM-DD date`);
  }
  if (effectiveTo !== undefined) {
    if (!isIsoDate(effectiveTo)) {
      problems.push(`effectiveTo ${JSON.stringify(effectiveTo)} is not a YYYY-MM-DD date`);
    } else if (isIsoDate(effectiveFrom) && effectiveTo < effectiveFrom) {
      problems.push(`effectiveTo ${effectiveTo} is before effectiveFrom ${effectiveFrom}`);
    }
  }
  if (
    rule.minHeadcount !== undefined &&
    (!Number.isInteger(rule.minHeadcount) || rule.minHeadcount < 1)
  ) {
    problems.push(
      `minHeadcount ${JSON.stringify(rule.minHeadcount)} is not a whole number of employees above zero`,
    );
  }
  if (rule.status === "in-force" && url.trim() !== "" && findAllowedSource(url) === undefined) {
    problems.push(
      `an in-force rule cites ${JSON.stringify(url)}, which is outside the primary-source allowlist`,
    );
  }
  return problems;
}

export function registryProblems(rules: readonly Rule[] = RULES): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      problems.push({ ruleId: rule.id, problem: "the id is used twice" });
    }
    seen.add(rule.id);
    for (const problem of ruleProblems(rule)) {
      problems.push({ ruleId: rule.id, problem });
    }
  }
  return problems;
}
