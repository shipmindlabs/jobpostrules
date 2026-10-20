export const PERIODS = ["HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;

export type Period = (typeof PERIODS)[number];

export const SEVERITIES = ["error", "warning", "info"] as const;

export type Severity = (typeof SEVERITIES)[number];

export interface PayRange {
  min: number;
  max: number;
  currency: string;
  period: string;
  stated?: string;
}

export interface Posting {
  visibleText: string;
  datePosted: string;
  payRange?: PayRange;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  at: string;
}

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
  if (bySeverity !== 0) {
    return bySeverity;
  }
  if (a.ruleId !== b.ruleId) {
    return a.ruleId < b.ruleId ? -1 : 1;
  }
  if (a.at !== b.at) {
    return a.at < b.at ? -1 : 1;
  }
  return 0;
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}
