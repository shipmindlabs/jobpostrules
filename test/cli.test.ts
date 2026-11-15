import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.ts";

const DIR = await mkdtemp(join(tmpdir(), "jobpostrules-"));
const BIN = fileURLToPath(new URL("../bin/jobpostrules.ts", import.meta.url));

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

async function file(name: string, content: string): Promise<string> {
  const path = join(DIR, name);
  await writeFile(path, content, "utf8");
  return path;
}

function ldJson(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body><h1>Staff Engineer</h1><p>Acme Robotics is hiring.</p></body></html>`;
}

const JOB_POSTING = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Staff Engineer",
  datePosted: "2026-01-15",
  hiringOrganization: { "@type": "Organization", name: "Acme Robotics" },
  baseSalary: {
    "@type": "MonetaryAmount",
    currency: "USD",
    value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 150000, unitText: "YEAR" },
  },
};

const MANIFEST = await file("manifest.json", JSON.stringify({ jobPosting: JOB_POSTING }));
const CLEAN = await file("clean.html", page(ldJson(JOB_POSTING)));

interface Spawned {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnCli(args: readonly string[]): Promise<Spawned> {
  return new Promise<Spawned>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

test("a clean page exits 0 and prints the report", async () => {
  const result = await run(["lint", CLEAN, "--manifest", MANIFEST]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /as of 2026-01-15/);
  assert.match(result.stdout, /1 JobPosting block in 1 application\/ld\+json script/);
  assert.match(result.stdout, /no findings/);
  assert.match(result.stdout, /0 errors, 0 warnings, 0 info/);
  assert.match(result.stdout, /0 not applied/);
  assert.match(result.stdout, /not legal advice/);
});

test("an error finding exits 1 and names the rule", async () => {
  const { baseSalary, ...withoutPay } = JOB_POSTING;
  assert.notEqual(baseSalary, undefined);
  const path = await file("no-pay.html", page(ldJson(withoutPay)));
  const result = await run(["lint", path, "--manifest", MANIFEST]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /error pay-range\/missing \/payRange/);
  assert.match(result.stdout, /1 error, 0 warnings, 0 info/);
});

test("a script that is not JSON is a finding, not a crash", async () => {
  const path = await file(
    "bad-jsonld.html",
    page('<script type="application/ld+json">{ not json }</script>' + ldJson(JOB_POSTING)),
  );
  const result = await run(["lint", path, "--manifest", MANIFEST]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /error input\/bad-jsonld \/ld\+json\/0/);
});

test("two JobPosting blocks that disagree on title are unreadable input", async () => {
  const path = await file(
    "conflicting.html",
    page(ldJson(JOB_POSTING) + ldJson({ ...JOB_POSTING, title: "Senior Engineer" })),
  );
  const result = await run(["lint", path, "--manifest", MANIFEST]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /input\/conflicting-jobposting at \/jobPosting\/1\/title/);
});

test("a page with no posting date is refused unless --as-of is given", async () => {
  const { datePosted, ...undated } = JOB_POSTING;
  assert.equal(datePosted, "2026-01-15");
  const path = await file("undated.html", page(ldJson(undated)));

  const refused = await run(["lint", path, "--manifest", MANIFEST]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /input\/no-as-of at \/datePosted/);

  const dated = await run(["lint", path, "--manifest", MANIFEST, "--as-of", "2026-02-01"]);
  assert.equal(dated.code, 0);
  assert.match(dated.stdout, /as of 2026-02-01/);
});

test("--as-of that is not a YYYY-MM-DD date is refused", async () => {
  for (const asOf of ["15/01/2026", "2026-13-40", "2026"]) {
    const result = await run(["lint", CLEAN, "--manifest", MANIFEST, "--as-of", asOf]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /input\/bad-as-of at \/--as-of/);
  }
});

test("a page or manifest that cannot be read is exit 2", async () => {
  const absent = join(DIR, "absent.html");
  const missingPage = await run(["lint", absent, "--manifest", MANIFEST]);
  assert.equal(missingPage.code, 2);
  assert.match(missingPage.stderr, /input\/unreadable-file at \/page/);

  const missingManifest = await run(["lint", CLEAN, "--manifest", join(DIR, "absent.json")]);
  assert.equal(missingManifest.code, 2);
  assert.match(missingManifest.stderr, /input\/unreadable-file at \/manifest/);
});

test("a manifest that is not a JSON object is exit 2", async () => {
  for (const [name, content] of [
    ["broken.json", "{ not json }"],
    ["array.json", "[]"],
    ["string.json", '"manifest"'],
  ] as const) {
    const path = await file(name, content);
    const result = await run(["lint", CLEAN, "--manifest", path]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /input\/bad-manifest at \/manifest/);
  }
});

test("a command line that cannot be read is exit 2", async () => {
  const invocations: readonly (readonly string[])[] = [
    [],
    ["check", CLEAN, "--manifest", MANIFEST],
    ["lint", "--manifest", MANIFEST],
    ["lint", CLEAN],
    ["lint", CLEAN, "--manifest"],
    ["lint", CLEAN, "--manifest", MANIFEST, "--markup"],
    ["lint", CLEAN, CLEAN, "--manifest", MANIFEST],
  ];
  for (const argv of invocations) {
    const result = await run(argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.stderr, /input\/usage/);
    assert.match(result.stderr, /Usage: jobpostrules lint/);
  }
});

test("--json prints the report as one JSON object", async () => {
  const result = await run(["lint", CLEAN, "--manifest", MANIFEST, "--json"]);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(report["ok"], true);
  assert.equal(report["asOf"], "2026-01-15");
  assert.equal(report["scripts"], 1);
  assert.equal(report["jobPostings"], 1);
  assert.deepEqual(report["findings"], []);
  assert.ok(Array.isArray(report["applied"]));

  const refused = await run(["lint", join(DIR, "absent.html"), "--manifest", MANIFEST, "--json"]);
  assert.equal(refused.code, 2);
  const body = JSON.parse(refused.stderr) as { ok: boolean; refusal: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.refusal.code, "input/unreadable-file");
});

test("two runs over the same page print identically", async () => {
  const argv = ["lint", CLEAN, "--manifest", MANIFEST];
  assert.deepEqual(await run(argv), await run(argv));
});

test("the executable carries the exit codes", async () => {
  const clean = await spawnCli(["lint", CLEAN, "--manifest", MANIFEST]);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /no findings/);

  const { baseSalary, ...withoutPay } = JOB_POSTING;
  assert.notEqual(baseSalary, undefined);
  const failing = await file("bin-no-pay.html", page(ldJson(withoutPay)));
  const errors = await spawnCli(["lint", failing, "--manifest", MANIFEST]);
  assert.equal(errors.code, 1);
  assert.match(errors.stdout, /pay-range\/missing/);

  const unreadable = await spawnCli(["lint", join(DIR, "absent.html"), "--manifest", MANIFEST]);
  assert.equal(unreadable.code, 2);
  assert.equal(unreadable.stdout, "");
});
