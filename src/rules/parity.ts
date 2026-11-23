import type { Finding, Posting } from "../model.ts";
import { normalizeText, sortFindings } from "../model.ts";
import type { JsonLdObject } from "../read.ts";
import type { ShapeRule } from "./registry.ts";
import { severityOf } from "./registry.ts";

export const AMBIGUOUS_NUMBER: ShapeRule = {
  id: "parity/ambiguous-number",
  kind: "shape",
  severity: "error",
  summary:
    "A figure in the visible text cannot be read without guessing its grouping, so it is not read at all.",
};

export const BAD_GROUPING: ShapeRule = {
  id: "parity/bad-grouping",
  kind: "shape",
  severity: "error",
  summary:
    "A figure in the visible text carries a group of other than three digits after a grouping separator.",
};

export const CURRENCY_MISMATCH: ShapeRule = {
  id: "parity/currency-mismatch",
  kind: "shape",
  severity: "error",
  summary: "The currency the markup states does not reach the visible text.",
};

export const LOCATION_MISMATCH: ShapeRule = {
  id: "parity/location-mismatch",
  kind: "shape",
  severity: "error",
  summary: "A locality or country name the markup states does not reach the visible text.",
};

export const SALARY_MISMATCH: ShapeRule = {
  id: "parity/salary-mismatch",
  kind: "shape",
  severity: "error",
  summary: "A baseSalary figure the markup states is not among the figures the visible text states.",
};

export const TITLE_MISMATCH: ShapeRule = {
  id: "parity/title-mismatch",
  kind: "shape",
  severity: "error",
  summary: "The title the markup states does not reach the visible text.",
};

export const PARITY_RULES: readonly ShapeRule[] = [
  AMBIGUOUS_NUMBER,
  BAD_GROUPING,
  CURRENCY_MISMATCH,
  LOCATION_MISMATCH,
  SALARY_MISMATCH,
  TITLE_MISMATCH,
];

export interface ParityManifest {
  readonly locale?: string;
}

export interface FieldNotCompared {
  readonly field: string;
  readonly reason: string;
}

export interface ParityNotApplied {
  readonly ruleId: string;
  readonly reason: string;
}

export interface ParityReport {
  readonly locale?: string;
  readonly groupSeparator?: string;
  readonly decimalSeparator?: string;
  readonly figures: readonly number[];
  readonly compared: readonly string[];
  readonly notCompared: readonly FieldNotCompared[];
  readonly findings: readonly Finding[];
  readonly notApplied: readonly ParityNotApplied[];
  readonly notes: readonly string[];
}

const PARITY_NOTE =
  "Every field is read in the markup and looked for in the visible text: the markup must say what the page says.";

const NO_MARKUP =
  "the page carries no JobPosting block, so there is nothing to compare the visible text with";

const NO_LOCALE_NOTE =
  "The manifest states no locale, so a figure carrying a grouping or decimal separator in the visible text is refused as parity/ambiguous-number rather than read as a guess.";

const SPACE_SEPARATORS = ["\u0020", "\u00a0", "\u202f", "\u2009"];

const EXCERPT = 120;

interface Separators {
  readonly group: string;
  readonly decimal: string;
}

interface ReadableLocale {
  readonly tag: string;
  readonly separators: Separators;
}

interface StatedText {
  readonly field: string;
  readonly value: string;
}

interface StatedNumber {
  readonly field: string;
  readonly value: number;
}

function isObject(value: unknown): value is JsonLdObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function excerpt(visibleText: string): string {
  return visibleText.length <= EXCERPT ? visibleText : `${visibleText.slice(0, EXCERPT)}...`;
}

function normalizeSeparator(value: string): string {
  return SPACE_SEPARATORS.includes(value) ? " " : value;
}

function separatorsFor(tag: string): Separators | undefined {
  const parts = new Intl.NumberFormat(tag).formatToParts(1234567.5);
  const group = parts.find((part) => part.type === "group")?.value;
  const decimal = parts.find((part) => part.type === "decimal")?.value;
  if (group === undefined || decimal === undefined) {
    return undefined;
  }
  return { group: normalizeSeparator(group), decimal: normalizeSeparator(decimal) };
}

function readLocale(stated: string | undefined): ReadableLocale | undefined {
  const tag = stated?.trim();
  if (tag === undefined || tag === "") {
    return undefined;
  }
  let supported: readonly string[];
  try {
    supported = Intl.NumberFormat.supportedLocalesOf([tag]);
  } catch {
    return undefined;
  }
  if (supported.length === 0) {
    return undefined;
  }
  const separators = separatorsFor(tag);
  return separators === undefined ? undefined : { tag, separators };
}

function currencySymbol(locale: ReadableLocale | undefined, currency: string): string | undefined {
  if (locale === undefined || !/^[A-Za-z]{3}$/.test(currency)) {
    return undefined;
  }
  let parts: readonly Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale.tag, { style: "currency", currency }).formatToParts(1);
  } catch {
    return undefined;
  }
  const symbol = parts.find((part) => part.type === "currency")?.value;
  if (symbol === undefined || symbol.toUpperCase() === currency.toUpperCase()) {
    return undefined;
  }
  return symbol;
}

function figurePattern(locale: ReadableLocale | undefined): RegExp {
  const separators = new Set<string>([",", "."]);
  if (locale === undefined) {
    separators.add(" ");
  } else {
    separators.add(locale.separators.group);
    separators.add(locale.separators.decimal);
  }
  const literal = [...separators].filter((char) => char !== " ").join("");
  const spaces = separators.has(" ") ? SPACE_SEPARATORS.join("") : "";
  return new RegExp(`\\d+(?:[${literal}${spaces}]\\d+)*(?:[kK](?![\\p{L}\\p{N}]))?`, "gu");
}

type FigureRead =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly rule: ShapeRule; readonly reason: string };

interface FigureRefusal {
  readonly rule: ShapeRule;
  readonly token: string;
  readonly reason: string;
}

interface FiguresRead {
  readonly values: readonly number[];
  readonly refusals: readonly FigureRefusal[];
}

function parseFigure(token: string, locale: ReadableLocale | undefined): FigureRead {
  const thousands = /[kK]$/.test(token);
  const body = thousands ? token.slice(0, -1) : token;
  const scale = thousands ? 1000 : 1;

  const segments: string[] = [];
  const separators: string[] = [];
  let current = "";
  for (const char of body) {
    if (char >= "0" && char <= "9") {
      current += char;
      continue;
    }
    segments.push(current);
    current = "";
    separators.push(normalizeSeparator(char));
  }
  segments.push(current);

  if (separators.length === 0) {
    return { ok: true, value: Number(segments[0]) * scale };
  }
  if (locale === undefined) {
    return {
      ok: false,
      rule: AMBIGUOUS_NUMBER,
      reason: "the manifest states no locale, so the separator could group thousands or mark a decimal fraction",
    };
  }

  const { group, decimal } = locale.separators;
  const foreign = separators.find((separator) => separator !== group && separator !== decimal);
  if (foreign !== undefined) {
    return {
      ok: false,
      rule: AMBIGUOUS_NUMBER,
      reason: `${JSON.stringify(foreign)} is neither the grouping separator ${JSON.stringify(group)} nor the decimal separator ${JSON.stringify(decimal)} of ${locale.tag}`,
    };
  }

  const decimals = separators.filter((separator) => separator === decimal).length;
  if (decimals > 1 || (decimals === 1 && separators[separators.length - 1] !== decimal)) {
    return {
      ok: false,
      rule: AMBIGUOUS_NUMBER,
      reason: `the decimal separator ${JSON.stringify(decimal)} of ${locale.tag} stands where a grouping separator is expected`,
    };
  }

  const groups = separators.length - decimals;
  const whole = segments.slice(0, groups + 1);
  const fraction = decimals === 1 ? (segments[groups + 1] ?? "") : "";
  if (groups > 0) {
    const [first, ...rest] = whole;
    const trailing = rest.find((segment) => segment.length !== 3);
    if (trailing !== undefined) {
      return {
        ok: false,
        rule: BAD_GROUPING,
        reason: `a group of ${trailing.length} digits follows the grouping separator ${JSON.stringify(group)} of ${locale.tag}, where a group of three is expected`,
      };
    }
    if ((first ?? "").length > 3) {
      return {
        ok: false,
        rule: BAD_GROUPING,
        reason: `the leading group of ${(first ?? "").length} digits is wider than three, so ${locale.tag} cannot read the grouping`,
      };
    }
  }

  const digits = whole.join("");
  const value = Number(fraction === "" ? digits : `${digits}.${fraction}`);
  return { ok: true, value: value * scale };
}

function readFigures(visibleText: string, locale: ReadableLocale | undefined): FiguresRead {
  const values: number[] = [];
  const refusals: FigureRefusal[] = [];
  const seen = new Set<string>();
  for (const match of visibleText.matchAll(figurePattern(locale))) {
    const token = match[0];
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    const read = parseFigure(token, locale);
    if (read.ok) {
      values.push(read.value);
    } else {
      refusals.push({ rule: read.rule, token, reason: read.reason });
    }
  }
  return { values, refusals };
}

function salaryFiguresOf(markup: JsonLdObject): StatedNumber[] {
  const salary = markup["baseSalary"];
  if (!isObject(salary)) {
    return [];
  }
  const amount = salary["value"];
  if (!isObject(amount)) {
    return [];
  }
  const stated: StatedNumber[] = [];
  for (const name of ["minValue", "maxValue", "value"] as const) {
    const value = numberOf(amount[name]);
    if (value !== undefined) {
      stated.push({ field: `/baseSalary/value/${name}`, value });
    }
  }
  return stated;
}

function currencyOf(markup: JsonLdObject): StatedText | undefined {
  const salary = markup["baseSalary"];
  if (!isObject(salary)) {
    return undefined;
  }
  const direct = stringOf(salary["currency"]);
  if (direct !== undefined) {
    return { field: "/baseSalary/currency", value: direct };
  }
  const amount = salary["value"];
  if (!isObject(amount)) {
    return undefined;
  }
  const nested = stringOf(amount["currency"]);
  return nested === undefined ? undefined : { field: "/baseSalary/value/currency", value: nested };
}

function statesCurrency(
  visibleText: string,
  currency: string,
  symbol: string | undefined,
): boolean {
  if (/^[A-Za-z]{3}$/.test(currency)) {
    if (new RegExp(`\\b${currency}\\b`, "i").test(visibleText)) {
      return true;
    }
  } else if (normalizeText(visibleText).includes(normalizeText(currency))) {
    return true;
  }
  return symbol !== undefined && normalizeText(visibleText).includes(normalizeText(symbol));
}

function placesOf(markup: JsonLdObject): StatedText[] {
  const places: StatedText[] = [];

  const located = markup["jobLocation"];
  const entries = Array.isArray(located) ? located : [located];
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry)) {
      continue;
    }
    const address = entry["address"];
    if (!isObject(address)) {
      continue;
    }
    const path = Array.isArray(located) ? `/jobLocation/${index}` : "/jobLocation";
    const locality = stringOf(address["addressLocality"]);
    if (locality !== undefined) {
      places.push({ field: `${path}/address/addressLocality`, value: locality });
    }
    const country = stringOf(address["addressCountry"]);
    if (country !== undefined) {
      places.push({ field: `${path}/address/addressCountry`, value: country });
    }
  }

  const required = markup["applicantLocationRequirements"];
  const requirements = Array.isArray(required) ? required : [required];
  for (const [index, requirement] of requirements.entries()) {
    if (!isObject(requirement)) {
      continue;
    }
    const name = stringOf(requirement["name"]);
    if (name === undefined) {
      continue;
    }
    const path = Array.isArray(required)
      ? `/applicantLocationRequirements/${index}`
      : "/applicantLocationRequirements";
    places.push({ field: `${path}/name`, value: name });
  }

  return places;
}

export function checkParity(
  posting: Posting,
  markup: JsonLdObject | undefined,
  manifest: ParityManifest = {},
): ParityReport {
  const locale = readLocale(manifest.locale);
  const notes: string[] = [PARITY_NOTE];
  if (locale === undefined) {
    const stated = manifest.locale?.trim();
    notes.push(
      stated === undefined || stated === ""
        ? NO_LOCALE_NOTE
        : `The manifest states the locale ${JSON.stringify(stated)}, which cannot be read here, so it counts as none. ${NO_LOCALE_NOTE}`,
    );
  }

  const read = {
    locale: locale?.tag,
    groupSeparator: locale?.separators.group,
    decimalSeparator: locale?.separators.decimal,
  };

  if (markup === undefined) {
    return {
      ...read,
      figures: [],
      compared: [],
      notCompared: [],
      findings: [],
      notApplied: PARITY_RULES.map((rule) => ({ ruleId: rule.id, reason: NO_MARKUP })),
      notes,
    };
  }

  const findings: Finding[] = [];
  const compared: string[] = [];
  const notCompared: FieldNotCompared[] = [];
  const text = normalizeText(posting.visibleText);
  const page = JSON.stringify(excerpt(posting.visibleText));

  const title = stringOf(markup["title"]);
  if (title === undefined) {
    notCompared.push({ field: "/title", reason: "the markup states no title" });
  } else if (text.includes(normalizeText(title))) {
    compared.push("/title");
  } else {
    findings.push({
      ruleId: TITLE_MISMATCH.id,
      severity: severityOf(TITLE_MISMATCH),
      message: `The markup states title ${JSON.stringify(title)}; the visible text states ${page} and does not carry it.`,
      at: "/title",
    });
  }

  let figures: readonly number[] = [];
  const salary = salaryFiguresOf(markup);
  if (salary.length === 0) {
    notCompared.push({
      field: "/baseSalary",
      reason: "the markup states no baseSalary minValue, maxValue or value",
    });
  } else {
    const figuresRead = readFigures(posting.visibleText, locale);
    figures = figuresRead.values;
    for (const refusal of figuresRead.refusals) {
      findings.push({
        ruleId: refusal.rule.id,
        severity: severityOf(refusal.rule),
        message: `The figure ${JSON.stringify(refusal.token)} in the visible text is not read: ${refusal.reason}. It is refused rather than guessed.`,
        at: "/visibleText",
      });
    }
    if (figuresRead.refusals.length > 0) {
      notCompared.push({
        field: "/baseSalary",
        reason:
          "a figure in the visible text could not be read, so the stated salary is not compared against a guess",
      });
    } else {
      const stated = [...new Set(figures)];
      const withLocale = locale === undefined ? "" : `, read with ${locale.tag},`;
      for (const entry of salary) {
        if (figures.includes(entry.value)) {
          compared.push(entry.field);
          continue;
        }
        findings.push({
          ruleId: SALARY_MISMATCH.id,
          severity: severityOf(SALARY_MISMATCH),
          message: `The markup states ${entry.field} ${entry.value}; the figures the visible text states${withLocale} are ${stated.length === 0 ? "none" : stated.join(", ")}.`,
          at: entry.field,
        });
      }
    }
  }

  const currency = currencyOf(markup);
  if (currency === undefined) {
    notCompared.push({ field: "/baseSalary/currency", reason: "the markup states no currency" });
  } else {
    const symbol = currencySymbol(locale, currency.value);
    if (statesCurrency(posting.visibleText, currency.value, symbol)) {
      compared.push(currency.field);
    } else {
      findings.push({
        ruleId: CURRENCY_MISMATCH.id,
        severity: severityOf(CURRENCY_MISMATCH),
        message: `The markup states currency ${JSON.stringify(currency.value)}; neither it${symbol === undefined ? "" : ` nor ${JSON.stringify(symbol)}`} reaches the visible text ${page}.`,
        at: currency.field,
      });
    }
  }

  for (const place of placesOf(markup)) {
    if (place.value.length <= 2) {
      notCompared.push({
        field: place.field,
        reason: `${JSON.stringify(place.value)} is a two-letter code rather than a name the page can carry`,
      });
      continue;
    }
    if (text.includes(normalizeText(place.value))) {
      compared.push(place.field);
      continue;
    }
    findings.push({
      ruleId: LOCATION_MISMATCH.id,
      severity: severityOf(LOCATION_MISMATCH),
      message: `The markup states ${place.field} ${JSON.stringify(place.value)}; the visible text states ${page} and does not carry it.`,
      at: place.field,
    });
  }

  return {
    ...read,
    figures,
    compared,
    notCompared,
    findings: sortFindings(findings),
    notApplied: [],
    notes,
  };
}
