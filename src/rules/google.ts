import type { Finding, Posting } from "../model.ts";
import { PERIODS, isIsoDate, isPeriod, normalizeText, sortFindings } from "../model.ts";
import type { JsonLdObject } from "../read.ts";
import type { CitedRule, RuleStatus } from "./registry.ts";
import { applicabilityOn, severityOf } from "./registry.ts";

export const GOOGLE_DOC_URL =
  "https://developers.google.com/search/docs/appearance/structured-data/job-posting";
export const GOOGLE_EFFECTIVE_FROM = "2024-01-01";
export const TELECOMMUTE = "TELECOMMUTE";
export const GOOGLE_REQUIRED_PROPERTIES = [
  "datePosted",
  "description",
  "hiringOrganization",
  "title",
] as const;

const READ_AT = "2026-11-01";

function platformRule(
  id: string,
  section: string,
  summary: string,
  status: RuleStatus = "in-force",
): CitedRule {
  return {
    id,
    kind: "platform",
    jurisdiction: "GOOGLE",
    status,
    summary,
    citation: { url: GOOGLE_DOC_URL, section, verifiedAt: READ_AT },
    effectiveFrom: GOOGLE_EFFECTIVE_FROM,
  };
}

export const REQUIRED_PROPERTY_MISSING = platformRule(
  "google/required-property-missing",
  "JobPosting, required properties",
  "A JobPosting block states datePosted, description, hiringOrganization and title.",
);

export const LOCATION_MISSING = platformRule(
  "google/location-missing",
  "JobPosting, jobLocation",
  "A JobPosting block states jobLocation unless it states applicantLocationRequirements.",
);

export const UNIT_TEXT_NOT_ENUM = platformRule(
  "google/unit-text-not-enum",
  "JobPosting, baseSalary.value.unitText",
  "baseSalary.value.unitText is exactly one of HOUR, DAY, WEEK, MONTH or YEAR.",
);

export const TELECOMMUTE_WITHOUT_COUNTRY = platformRule(
  "google/telecommute-without-country",
  "Remote jobs, jobLocationType",
  "A posting whose jobLocationType is TELECOMMUTE names a country in applicantLocationRequirements or in jobLocation.address.addressCountry.",
);

export const TELECOMMUTE_NOT_REMOTE = platformRule(
  "google/telecommute-not-remote",
  "Remote jobs, jobLocationType",
  "jobLocationType TELECOMMUTE states a fully remote role, so a manifest declaring a hybrid workplace contradicts the markup.",
);

export const TELECOMMUTE_TEXT_UNSTATED = platformRule(
  "google/telecommute-text-unstated",
  "Remote jobs, jobLocationType",
  "The visible text of a TELECOMMUTE posting states that the role is fully remote. Whether it does is read as a text heuristic over a phrase list, so the rule warns rather than fails.",
  "advisory",
);

export const VALID_THROUGH_EXPIRED = platformRule(
  "google/valid-through-expired",
  "JobPosting, validThrough",
  "A validThrough earlier than the date the page is served, while the markup is still on the page, is an expired posting.",
);

export const GOOGLE_RULES: readonly CitedRule[] = [
  REQUIRED_PROPERTY_MISSING,
  LOCATION_MISSING,
  UNIT_TEXT_NOT_ENUM,
  TELECOMMUTE_WITHOUT_COUNTRY,
  TELECOMMUTE_NOT_REMOTE,
  TELECOMMUTE_TEXT_UNSTATED,
  VALID_THROUGH_EXPIRED,
];

export const FULLY_REMOTE_PHRASES: readonly string[] = [
  "fully remote",
  "fully-remote",
  "100% remote",
  "entirely remote",
  "remote-first",
  "remote first",
  "work from anywhere",
  "working from anywhere",
  "this role is remote",
  "this position is remote",
  "remote role",
  "remote position",
  "telecommute",
];

export function matchFullyRemote(text: string): string[] {
  const haystack = normalizeText(text);
  return FULLY_REMOTE_PHRASES.filter((phrase) => haystack.includes(normalizeText(phrase)));
}

export interface GoogleManifest {
  readonly workplaceType?: string;
}

export interface GoogleOptions {
  readonly servedOn?: string;
}

export interface GoogleNotApplied {
  readonly ruleId: string;
  readonly reason: string;
}

export interface GoogleReport {
  readonly servedOn: string;
  readonly datePosted?: string;
  readonly findings: readonly Finding[];
  readonly notApplied: readonly GoogleNotApplied[];
  readonly notes: readonly string[];
  readonly telecommute: boolean;
  readonly country?: string;
  readonly fullyRemoteStated: boolean;
  readonly expired: boolean;
}

const SERVING_DATE_NOTE =
  "Google reads the markup on the page as it is served, so these rules run on the serving date rather than the posting date; the report names both dates.";

const NO_MARKUP_NOTE =
  "The page carries no JobPosting block, so no Google rule was read against markup.";

const TEXT_HEURISTIC_NOTE =
  "Whether the visible text states a fully remote role is read as a text heuristic over a phrase list, so a missing statement warns rather than fails.";

const NO_MARKUP_REASON = "the page carries no JobPosting block, so there is no markup to read";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isObject(value: unknown): value is JsonLdObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entriesOf(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value as readonly unknown[];
  }
  return value === undefined || value === null ? [] : [value];
}

function stated(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.some((entry) => stated(entry));
  }
  if (typeof value === "object") {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

function dateOf(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const date = value.trim().split("T")[0] ?? "";
  return isIsoDate(date) ? date : undefined;
}

function nameOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value.trim();
  }
  const nested = isObject(value) ? value["name"] : undefined;
  return typeof nested === "string" && nested.trim() !== "" ? nested.trim() : undefined;
}

function statesTelecommute(markup: JsonLdObject): boolean {
  return entriesOf(markup["jobLocationType"]).some((entry) => {
    const value = nameOf(entry);
    return value !== undefined && normalizeText(value) === normalizeText(TELECOMMUTE);
  });
}

function applicantCountry(markup: JsonLdObject): string | undefined {
  for (const entry of entriesOf(markup["applicantLocationRequirements"])) {
    if (typeof entry === "string") {
      const bare = nameOf(entry);
      if (bare !== undefined) {
        return bare;
      }
      continue;
    }
    if (!isObject(entry)) {
      continue;
    }
    const named = nameOf(entry["name"]) ?? nameOf(entry["addressCountry"]);
    if (named !== undefined) {
      return named;
    }
    const address = entry["address"];
    const inAddress = isObject(address) ? nameOf(address["addressCountry"]) : undefined;
    if (inAddress !== undefined) {
      return inAddress;
    }
  }
  return undefined;
}

function jobLocationCountry(markup: JsonLdObject): string | undefined {
  for (const entry of entriesOf(markup["jobLocation"])) {
    if (!isObject(entry)) {
      continue;
    }
    const address = entry["address"];
    const named = isObject(address) ? nameOf(address["addressCountry"]) : undefined;
    if (named !== undefined) {
      return named;
    }
  }
  return undefined;
}

function unitTextProblem(markup: JsonLdObject): string | undefined {
  const salary = markup["baseSalary"];
  if (!stated(salary)) {
    return undefined;
  }
  const amount = isObject(salary) ? salary["value"] : undefined;
  const unit = isObject(amount) ? amount["unitText"] : undefined;
  if (typeof unit !== "string" || unit.trim() === "") {
    return `baseSalary is stated with no value.unitText; unitText is exactly one of ${PERIODS.join(", ")}.`;
  }
  if (!isPeriod(unit)) {
    return `baseSalary.value.unitText ${JSON.stringify(unit)} is outside the exact enum ${PERIODS.join(", ")}; the enum is case-sensitive, so "year" fails where "YEAR" passes.`;
  }
  return undefined;
}

export function checkGoogle(
  posting: Posting,
  markup: JsonLdObject | undefined,
  manifest: GoogleManifest = {},
  options: GoogleOptions = {},
): GoogleReport {
  const notes: string[] = [SERVING_DATE_NOTE];
  let servedOn = today();
  if (options.servedOn !== undefined) {
    if (isIsoDate(options.servedOn)) {
      servedOn = options.servedOn;
    } else {
      notes.push(
        `servedOn ${JSON.stringify(options.servedOn)} is not a YYYY-MM-DD date, so the current date ${servedOn} was read as the serving date.`,
      );
    }
  }

  const datePosted = posting.datePosted ?? dateOf(markup?.["datePosted"]);

  const notApplied: GoogleNotApplied[] = [];
  const active = new Set<string>();
  for (const rule of GOOGLE_RULES) {
    if (markup === undefined) {
      notApplied.push({ ruleId: rule.id, reason: NO_MARKUP_REASON });
      continue;
    }
    const applicability = applicabilityOn(rule, servedOn);
    if (applicability.applies) {
      active.add(rule.id);
    } else {
      notApplied.push({ ruleId: rule.id, reason: applicability.reason });
    }
  }

  const telecommute = markup !== undefined && statesTelecommute(markup);
  const country =
    markup === undefined ? undefined : applicantCountry(markup) ?? jobLocationCountry(markup);
  const fullyRemoteStated = matchFullyRemote(posting.visibleText).length > 0;

  if (markup === undefined) {
    notes.push(NO_MARKUP_NOTE);
  }
  if (telecommute) {
    notes.push(TEXT_HEURISTIC_NOTE);
  }

  const findings: Finding[] = [];
  let expired = false;

  if (markup !== undefined) {
    if (active.has(REQUIRED_PROPERTY_MISSING.id)) {
      for (const property of GOOGLE_REQUIRED_PROPERTIES) {
        if (!stated(markup[property])) {
          findings.push({
            ruleId: REQUIRED_PROPERTY_MISSING.id,
            severity: severityOf(REQUIRED_PROPERTY_MISSING),
            message: `The JobPosting block states no ${property}; ${GOOGLE_REQUIRED_PROPERTIES.join(", ")} are required on every job posting.`,
            at: `/jobPosting/${property}`,
          });
        }
      }
    }

    if (
      active.has(LOCATION_MISSING.id) &&
      !stated(markup["jobLocation"]) &&
      !stated(markup["applicantLocationRequirements"])
    ) {
      findings.push({
        ruleId: LOCATION_MISSING.id,
        severity: severityOf(LOCATION_MISSING),
        message:
          "The JobPosting block states neither jobLocation nor applicantLocationRequirements; jobLocation is required unless the posting states where an applicant may be located.",
        at: "/jobPosting/jobLocation",
      });
    }

    const unitText = active.has(UNIT_TEXT_NOT_ENUM.id) ? unitTextProblem(markup) : undefined;
    if (unitText !== undefined) {
      findings.push({
        ruleId: UNIT_TEXT_NOT_ENUM.id,
        severity: severityOf(UNIT_TEXT_NOT_ENUM),
        message: unitText,
        at: "/jobPosting/baseSalary/value/unitText",
      });
    }

    if (telecommute && active.has(TELECOMMUTE_WITHOUT_COUNTRY.id) && country === undefined) {
      findings.push({
        ruleId: TELECOMMUTE_WITHOUT_COUNTRY.id,
        severity: severityOf(TELECOMMUTE_WITHOUT_COUNTRY),
        message: `jobLocationType ${TELECOMMUTE} states a fully remote role, so the markup names a country in applicantLocationRequirements or in jobLocation.address.addressCountry; it names neither.`,
        at: "/jobPosting/jobLocationType",
      });
    }

    if (
      telecommute &&
      active.has(TELECOMMUTE_NOT_REMOTE.id) &&
      normalizeText(manifest.workplaceType ?? "") === "hybrid"
    ) {
      findings.push({
        ruleId: TELECOMMUTE_NOT_REMOTE.id,
        severity: severityOf(TELECOMMUTE_NOT_REMOTE),
        message: `jobLocationType ${TELECOMMUTE} states a fully remote role while the manifest declares a ${JSON.stringify(manifest.workplaceType)} workplace; a hybrid role is not ${TELECOMMUTE}.`,
        at: "/jobPosting/jobLocationType",
      });
    }

    if (telecommute && active.has(TELECOMMUTE_TEXT_UNSTATED.id) && !fullyRemoteStated) {
      findings.push({
        ruleId: TELECOMMUTE_TEXT_UNSTATED.id,
        severity: severityOf(TELECOMMUTE_TEXT_UNSTATED),
        message: `The markup states jobLocationType ${TELECOMMUTE} while the visible text carries no fully-remote statement; whether the page states a fully remote role is read as a text heuristic, so this warns rather than fails.`,
        at: "/visibleText",
      });
    }

    const validThrough = dateOf(markup["validThrough"]);
    if (validThrough !== undefined) {
      expired = validThrough < servedOn;
      if (expired && active.has(VALID_THROUGH_EXPIRED.id)) {
        findings.push({
          ruleId: VALID_THROUGH_EXPIRED.id,
          severity: severityOf(VALID_THROUGH_EXPIRED),
          message: `validThrough ${validThrough} is earlier than the serving date ${servedOn} while the markup is still on the page; the ad was posted on ${datePosted ?? "an unstated date"} and has expired.`,
          at: "/jobPosting/validThrough",
        });
      }
    } else if (markup["validThrough"] !== undefined) {
      notes.push(
        `validThrough ${JSON.stringify(markup["validThrough"])} could not be read as a date, so it was not measured against the serving date ${servedOn}.`,
      );
    }
  }

  return {
    servedOn,
    datePosted,
    findings: sortFindings(findings),
    notApplied,
    notes,
    telecommute,
    country,
    fullyRemoteStated,
    expired,
  };
}
