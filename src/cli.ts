import { readFile } from "node:fs/promises";

import type { LintReport, Manifest } from "./lint.ts";
import { lint } from "./lint.ts";
import type { Finding } from "./model.ts";
import { SEVERITIES, isIsoDate, sortFindings } from "./model.ts";
import type { PostingRead } from "./read.ts";
import { postingFrom, readPosting } from "./read.ts";

export const USAGE =
  "jobpostrules lint <page.html> --manifest <manifest.json> [--as-of YYYY-MM-DD] [--json]";

const NOT_LEGAL_ADVICE = "This is a lint, not legal advice.";

export interface CliRefusal {
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface CliRun {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

interface Args {
  readonly page: string;
  readonly manifest: string;
  readonly asOf?: string;
  readonly json: boolean;
}

type ParsedArgs =
  | { readonly ok: true; readonly args: Args }
  | { readonly ok: false; readonly refusal: CliRefusal };

type TextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly refusal: CliRefusal };

type ManifestResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly refusal: CliRefusal };

function usage(message: string, at: string): ParsedArgs {
  return {
    ok: false,
    refusal: { code: "input/usage", message: `${message} Usage: ${USAGE}`, at },
  };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "lint") {
    return usage(
      command === undefined
        ? "No command was given."
        : `${JSON.stringify(command)} is not a command; the only command is lint.`,
      "/command",
    );
  }

  const queue = [...rest];
  let page: string | undefined;
  let manifest: string | undefined;
  let asOf: string | undefined;
  let json = false;

  for (let argument = queue.shift(); argument !== undefined; argument = queue.shift()) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--manifest" || argument === "--as-of") {
      const value = queue.shift();
      if (value === undefined || value.startsWith("-")) {
        return usage(`${argument} takes a value.`, `/${argument}`);
      }
      if (argument === "--manifest") {
        manifest = value;
      } else {
        asOf = value;
      }
      continue;
    }
    if (argument.startsWith("-")) {
      return usage(`${JSON.stringify(argument)} is not an option.`, `/${argument}`);
    }
    if (page !== undefined) {
      return usage("One page is linted at a time.", "/page");
    }
    page = argument;
  }

  if (page === undefined) {
    return usage(
      "No page was given; the input is HTML that is already rendered, read from a file.",
      "/page",
    );
  }
  if (manifest === undefined) {
    return usage("No --manifest was given.", "/--manifest");
  }
  if (!isIsoDate(asOf ?? "2026-01-01")) {
    return {
      ok: false,
      refusal: {
        code: "input/bad-as-of",
        message: `--as-of ${JSON.stringify(asOf)} is not a YYYY-MM-DD date; the rules are read as of the day the ad was posted, never the day the lint runs.`,
        at: "/--as-of",
      },
    };
  }

  return { ok: true, args: { page, manifest, asOf, json } };
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readText(path: string, what: string): Promise<TextResult> {
  try {
    return { ok: true, text: await readFile(path, "utf8") };
  } catch (error) {
    return {
      ok: false,
      refusal: {
        code: "input/unreadable-file",
        message: `The ${what} ${JSON.stringify(path)} could not be read (${detailOf(error)}).`,
        at: `/${what}`,
      },
    };
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestFrom(text: string, path: string): ManifestResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      refusal: {
        code: "input/bad-manifest",
        message: `The manifest ${JSON.stringify(path)} is not JSON (${detailOf(error)}).`,
        at: "/manifest",
      },
    };
  }
  if (!isObject(value)) {
    return {
      ok: false,
      refusal: {
        code: "input/bad-manifest",
        message: `The manifest ${JSON.stringify(path)} is not a JSON object.`,
        at: "/manifest",
      },
    };
  }
  const jobPosting = value["jobPosting"];
  return { ok: true, manifest: isObject(jobPosting) ? { jobPosting } : {} };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function severityLine(findings: readonly Finding[]): string {
  return SEVERITIES.map((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    return severity === "info" ? `${count} info` : plural(count, severity);
  }).join(", ");
}

function textReport(
  args: Args,
  read: PostingRead,
  report: LintReport,
  findings: readonly Finding[],
): string {
  const lines: string[] = [
    `${args.page}, as of ${report.asOf}`,
    `${plural(read.jobPostings.length, "JobPosting block")} in ${plural(read.scripts, "application/ld+json script")}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("no findings");
  } else {
    for (const finding of findings) {
      lines.push(`${finding.severity} ${finding.ruleId} ${finding.at}`);
      lines.push(`    ${finding.message}`);
    }
  }

  lines.push("", severityLine(findings));
  lines.push(
    `${plural(report.applied.length, "rule")} applied, ${report.notApplied.length} not applied`,
  );
  for (const entry of report.notApplied) {
    lines.push(`    ${entry.ruleId}: ${entry.reason}`);
  }
  lines.push("", NOT_LEGAL_ADVICE);

  return `${lines.join("\n")}\n`;
}

function jsonReport(
  args: Args,
  read: PostingRead,
  report: LintReport,
  findings: readonly Finding[],
): string {
  const body = {
    ok: true,
    page: args.page,
    asOf: report.asOf,
    scripts: read.scripts,
    jobPostings: read.jobPostings.length,
    findings,
    applied: report.applied,
    notApplied: report.notApplied,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function refused(refusal: CliRefusal, json: boolean): CliRun {
  const stderr = json
    ? `${JSON.stringify({ ok: false, refusal }, null, 2)}\n`
    : `jobpostrules: ${refusal.code} at ${refusal.at}\n    ${refusal.message}\n`;
  return { code: 2, stdout: "", stderr };
}

export async function run(argv: readonly string[]): Promise<CliRun> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return refused(parsed.refusal, argv.includes("--json"));
  }
  const { args } = parsed;

  const pageText = await readText(args.page, "page");
  if (!pageText.ok) {
    return refused(pageText.refusal, args.json);
  }
  const manifestText = await readText(args.manifest, "manifest");
  if (!manifestText.ok) {
    return refused(manifestText.refusal, args.json);
  }
  const manifest = manifestFrom(manifestText.text, args.manifest);
  if (!manifest.ok) {
    return refused(manifest.refusal, args.json);
  }

  const read = readPosting(pageText.text);
  if (!read.ok) {
    return refused(read.refusal, args.json);
  }

  const result = lint(postingFrom(read.read), manifest.manifest, { asOf: args.asOf });
  if (!result.ok) {
    return refused(result.refusal, args.json);
  }

  const findings = sortFindings([...read.read.findings, ...result.report.findings]);
  const stdout = args.json
    ? jsonReport(args, read.read, result.report, findings)
    : textReport(args, read.read, result.report, findings);

  return {
    code: findings.some((finding) => finding.severity === "error") ? 1 : 0,
    stdout,
    stderr: "",
  };
}
