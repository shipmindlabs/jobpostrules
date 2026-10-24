import type { Finding, Posting } from "./model.ts";
import { isIsoDate } from "./model.ts";
import { checkPayRange } from "./payrange.ts";
import type { Rule } from "./rules/registry.ts";
import { RULES, applicabilityOn } from "./rules/registry.ts";

export interface Manifest {
  readonly jobPosting?: Readonly<Record<string, unknown>>;
}

export interface LintOptions {
  readonly asOf?: string;
  readonly rules?: readonly Rule[];
}

export interface NotAppliedRule {
  readonly ruleId: string;
  readonly reason: string;
}

export interface LintReport {
  readonly asOf: string;
  readonly findings: readonly Finding[];
  readonly applied: readonly string[];
  readonly notApplied: readonly NotAppliedRule[];
}

export interface LintRefusal {
  readonly code: "input/no-as-of";
  readonly message: string;
  readonly at: string;
}

export type LintResult =
  | { readonly ok: true; readonly report: LintReport }
  | { readonly ok: false; readonly refusal: LintRefusal };

const NO_AS_OF: LintRefusal = {
  code: "input/no-as-of",
  message:
    "Law rules are read as of the day the ad was posted: pass options.asOf or posting.datePosted as a YYYY-MM-DD date. The day of the lint is never used.",
  at: "/datePosted",
};

function resolveAsOf(posting: Posting, options: LintOptions): string | undefined {
  const candidate = options.asOf ?? posting.datePosted;
  if (candidate === undefined || !isIsoDate(candidate)) {
    return undefined;
  }
  return candidate;
}

export function lint(
  posting: Posting,
  manifest: Manifest | undefined,
  options: LintOptions = {},
): LintResult {
  const asOf = resolveAsOf(posting, options);
  if (asOf === undefined) {
    return { ok: false, refusal: NO_AS_OF };
  }

  const applied: string[] = [];
  const notApplied: NotAppliedRule[] = [];
  for (const rule of options.rules ?? RULES) {
    const applicability = applicabilityOn(rule, asOf);
    if (applicability.applies) {
      applied.push(rule.id);
    } else {
      notApplied.push({ ruleId: rule.id, reason: applicability.reason });
    }
  }

  return {
    ok: true,
    report: { asOf, findings: checkPayRange(posting), applied, notApplied },
  };
}
