import { parse } from "parse5";

import type { Finding, PayRange, Posting } from "./model.ts";
import { isIsoDate, normalizeText, sortFindings } from "./model.ts";

interface Attribute {
  readonly name: string;
  readonly value: string;
}

interface Node {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly attrs?: readonly Attribute[];
  readonly value?: string;
  readonly childNodes?: readonly Node[];
}

export type JsonLdObject = Readonly<Record<string, unknown>>;

export interface PostingRead {
  readonly visibleText: string;
  readonly jobPostings: readonly JsonLdObject[];
  readonly scripts: number;
  readonly findings: readonly Finding[];
}

export interface ReadRefusal {
  readonly code: "input/conflicting-jobposting";
  readonly message: string;
  readonly at: string;
}

export type ReadResult =
  | { readonly ok: true; readonly read: PostingRead }
  | { readonly ok: false; readonly refusal: ReadRefusal };

const NOT_VISIBLE = new Set(["script", "style", "template"]);
const LD_JSON = "application/ld+json";

function attribute(node: Node, name: string): string | undefined {
  return node.attrs?.find((candidate) => candidate.name === name)?.value;
}

function isHidden(node: Node): boolean {
  if (attribute(node, "hidden") !== undefined) {
    return true;
  }
  return normalizeText(attribute(node, "aria-hidden") ?? "") === "true";
}

function textOf(node: Node): string {
  return (node.childNodes ?? [])
    .filter((child) => child.nodeName === "#text")
    .map((child) => child.value ?? "")
    .join("");
}

function collectVisible(node: Node, out: string[]): void {
  if (node.nodeName === "#text") {
    out.push(node.value ?? "");
    return;
  }
  if (node.tagName !== undefined && (NOT_VISIBLE.has(node.tagName) || isHidden(node))) {
    return;
  }
  for (const child of node.childNodes ?? []) {
    collectVisible(child, out);
  }
}

function collectLdJson(node: Node, out: string[]): void {
  if (node.tagName === "script") {
    const type = (attribute(node, "type") ?? "").split(";")[0] ?? "";
    if (normalizeText(type) === LD_JSON) {
      out.push(textOf(node));
    }
    return;
  }
  for (const child of node.childNodes ?? []) {
    collectLdJson(child, out);
  }
}

function isObject(value: unknown): value is JsonLdObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobPosting(value: JsonLdObject): boolean {
  const stated = value["@type"];
  const types = Array.isArray(stated) ? stated : [stated];
  return types.some(
    (type) =>
      typeof type === "string" && normalizeText(type.replace(/^.*[/#:]/, "")) === "jobposting",
  );
}

function collectJobPostings(value: unknown, out: JsonLdObject[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectJobPostings(entry, out);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  if (isJobPosting(value)) {
    out.push(value);
  }
  const graph = value["@graph"];
  if (graph !== undefined) {
    collectJobPostings(graph, out);
  }
}

interface StatedTitle {
  readonly index: number;
  readonly title: string;
  readonly normalized: string;
}

function titleConflict(postings: readonly JsonLdObject[]): ReadRefusal | undefined {
  let first: StatedTitle | undefined;
  for (const [index, posting] of postings.entries()) {
    const title = posting["title"];
    if (typeof title !== "string" || title.trim() === "") {
      continue;
    }
    const normalized = normalizeText(title);
    if (first === undefined) {
      first = { index, title, normalized };
      continue;
    }
    if (normalized !== first.normalized) {
      return {
        code: "input/conflicting-jobposting",
        message: `Two JobPosting blocks on the page disagree on the title: block ${first.index} states ${JSON.stringify(first.title)} and block ${index} states ${JSON.stringify(title)}. Which posting the page states is undecidable, so it is not linted.`,
        at: `/jobPosting/${index}/title`,
      };
    }
  }
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function payRangeOf(markup: JsonLdObject): PayRange | undefined {
  const salary = markup["baseSalary"];
  if (!isObject(salary)) {
    return undefined;
  }
  const amount = salary["value"];
  if (!isObject(amount)) {
    return undefined;
  }
  const currency = salary["currency"] ?? amount["currency"];
  const unit = amount["unitText"];
  if (typeof currency !== "string" || typeof unit !== "string") {
    return undefined;
  }
  const single = numberOf(amount["value"]);
  const min = numberOf(amount["minValue"]) ?? single;
  const max = numberOf(amount["maxValue"]) ?? single;
  if (min === undefined || max === undefined) {
    return undefined;
  }
  return { min, max, currency: currency.trim(), period: unit.trim().toUpperCase() };
}

function datePostedOf(markup: JsonLdObject): string | undefined {
  const stated = markup["datePosted"];
  if (typeof stated !== "string") {
    return undefined;
  }
  const date = stated.trim().split("T")[0] ?? "";
  return isIsoDate(date) ? date : undefined;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readPosting(html: string): ReadResult {
  const document = parse(html) as unknown as Node;

  const scripts: string[] = [];
  collectLdJson(document, scripts);

  const findings: Finding[] = [];
  const jobPostings: JsonLdObject[] = [];
  for (const [index, source] of scripts.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      findings.push({
        ruleId: "input/bad-jsonld",
        severity: "error",
        message: `The application/ld+json script at index ${index} is not JSON (${detailOf(error)}); the block is reported rather than thrown and the other blocks are still read.`,
        at: `/ld+json/${index}`,
      });
      continue;
    }
    collectJobPostings(value, jobPostings);
  }

  const conflict = titleConflict(jobPostings);
  if (conflict !== undefined) {
    return { ok: false, refusal: conflict };
  }

  const text: string[] = [];
  collectVisible(document, text);

  return {
    ok: true,
    read: {
      visibleText: text.join(" ").replace(/\s+/g, " ").trim(),
      jobPostings,
      scripts: scripts.length,
      findings: sortFindings(findings),
    },
  };
}

export function postingFrom(read: PostingRead): Posting {
  const markup = read.jobPostings[0];
  if (markup === undefined) {
    return { visibleText: read.visibleText };
  }
  return {
    visibleText: read.visibleText,
    datePosted: datePostedOf(markup),
    payRange: payRangeOf(markup),
  };
}
