import type { Finding } from "./model.ts";
import { sortFindings } from "./model.ts";
import type { Rule } from "./rules/registry.ts";
import { RULES } from "./rules/registry.ts";

export interface JurisdictionManifest {
  readonly onsiteLocation?: string;
  readonly remote?: boolean;
  readonly remoteEligible?: readonly string[];
  readonly employerHeadcount?: number;
}

export interface JurisdictionScope {
  readonly regions: readonly string[];
  readonly remote: boolean;
  readonly regionsComplete: boolean;
  readonly headcount?: number;
  readonly headcountKnown: boolean;
  readonly findings: readonly Finding[];
}

export interface RuleOutOfScope {
  readonly ruleId: string;
  readonly reason: string;
}

export interface JurisdictionReport {
  readonly regions: readonly string[];
  readonly remote: boolean;
  readonly headcount?: number;
  readonly headcountKnown: boolean;
  readonly regionsComplete: boolean;
  readonly reached: readonly string[];
  readonly outOfScope: readonly RuleOutOfScope[];
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

export type Reach =
  | { readonly reached: true }
  | { readonly reached: false; readonly reason: string };

const COUNTRY = /^[A-Z]{2}$/;
const SUBDIVISION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

const APPROXIMATION_NOTE =
  "The applicable set is the union over every region the role is open to: the strictest place reached. That union is a conservative approximation for a lint, not a statement of legal scope.";

const SCOPE_NOTE =
  "Which regions the role is open to is a hiring decision; the report reads it and never asks for it to be changed to get out of a rule.";

const REGIONS_INCOMPLETE_NOTE =
  "The regions the role reaches could not be read in full, so every region-scoped rule counts as reached (fail-closed).";

const HEADCOUNT_UNKNOWN_NOTE =
  "The employer headcount is not a stated whole number, so every headcount threshold counts as met (fail-closed).";

export function regionCode(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  return COUNTRY.test(code) || SUBDIVISION.test(code) ? code : undefined;
}

function countryOf(region: string): string {
  return region.slice(0, 2);
}

export function regionReaches(open: string, ruleRegion: string): boolean {
  if (open === ruleRegion) {
    return true;
  }
  if (COUNTRY.test(open)) {
    return countryOf(ruleRegion) === open;
  }
  if (COUNTRY.test(ruleRegion)) {
    return countryOf(open) === ruleRegion;
  }
  return false;
}

interface NamedRegion {
  readonly at: string;
  readonly value: string;
}

function namedRegions(manifest: JurisdictionManifest): NamedRegion[] {
  const named: NamedRegion[] = [];
  if (manifest.onsiteLocation !== undefined) {
    named.push({ at: "/onsiteLocation", value: manifest.onsiteLocation });
  }
  for (const [index, value] of (manifest.remoteEligible ?? []).entries()) {
    named.push({ at: `/remoteEligible/${index}`, value });
  }
  return named;
}

export function scopeOf(manifest: JurisdictionManifest): JurisdictionScope {
  const findings: Finding[] = [];
  const regions = new Set<string>();
  let readable = true;

  for (const named of namedRegions(manifest)) {
    const code = regionCode(named.value);
    if (code === undefined) {
      readable = false;
      findings.push({
        ruleId: "jurisdiction/unknown-region",
        severity: "error",
        message: `Region ${JSON.stringify(named.value)} is neither an ISO 3166-1 country such as PL nor an ISO 3166-2 subdivision such as CA-ON.`,
        at: named.at,
      });
      continue;
    }
    regions.add(code);
  }

  const eligible = manifest.remoteEligible ?? [];
  const eligibleRegions = eligible.filter((value) => regionCode(value) !== undefined);
  if (manifest.remote === true && eligibleRegions.length === 0) {
    readable = false;
    findings.push({
      ruleId: "jurisdiction/remote-without-region",
      severity: "error",
      message:
        "The posting is marked remote and names no eligible region; name every ISO 3166-1 country or ISO 3166-2 subdivision the role is open to.",
      at: "/remoteEligible",
    });
  }

  const stated = manifest.employerHeadcount;
  const headcountKnown = stated !== undefined && Number.isInteger(stated) && stated >= 0;
  if (!headcountKnown) {
    findings.push({
      ruleId: "jurisdiction/unknown-headcount",
      severity: "warning",
      message:
        stated === undefined
          ? "The manifest states no employerHeadcount, so every headcount threshold counts as met."
          : `employerHeadcount ${JSON.stringify(stated)} is not a whole number of employees, so every headcount threshold counts as met.`,
      at: "/employerHeadcount",
    });
  }

  return {
    regions: [...regions].sort(),
    remote: manifest.remote === true || eligible.length > 0,
    regionsComplete: readable && regions.size > 0,
    headcount: headcountKnown ? stated : undefined,
    headcountKnown,
    findings: sortFindings(findings),
  };
}

export function reachOf(rule: Rule, scope: JurisdictionScope): Reach {
  if (rule.kind === "shape") {
    return { reached: true };
  }
  const region = regionCode(rule.jurisdiction);
  if (region !== undefined && scope.regionsComplete) {
    if (!scope.regions.some((open) => regionReaches(open, region))) {
      return {
        reached: false,
        reason: `the rule covers ${region}; the role is open to ${scope.regions.join(", ")}`,
      };
    }
  }
  if (
    rule.minHeadcount !== undefined &&
    scope.headcount !== undefined &&
    scope.headcount < rule.minHeadcount
  ) {
    return {
      reached: false,
      reason: `the rule covers an employer with ${rule.minHeadcount} employees or more; the manifest states ${scope.headcount}`,
    };
  }
  return { reached: true };
}

export function checkJurisdiction(
  manifest: JurisdictionManifest,
  rules: readonly Rule[] = RULES,
): JurisdictionReport {
  const scope = scopeOf(manifest);

  const reached: string[] = [];
  const outOfScope: RuleOutOfScope[] = [];
  for (const rule of rules) {
    const reach = reachOf(rule, scope);
    if (reach.reached) {
      reached.push(rule.id);
    } else {
      outOfScope.push({ ruleId: rule.id, reason: reach.reason });
    }
  }

  const notes = [APPROXIMATION_NOTE, SCOPE_NOTE];
  if (!scope.regionsComplete) {
    notes.push(REGIONS_INCOMPLETE_NOTE);
  }
  if (!scope.headcountKnown) {
    notes.push(HEADCOUNT_UNKNOWN_NOTE);
  }

  return {
    regions: scope.regions,
    remote: scope.remote,
    headcount: scope.headcount,
    headcountKnown: scope.headcountKnown,
    regionsComplete: scope.regionsComplete,
    reached,
    outOfScope,
    findings: scope.findings,
    notes,
  };
}
