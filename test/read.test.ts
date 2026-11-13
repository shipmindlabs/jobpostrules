import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PostingRead } from "../src/read.ts";
import { postingFrom, readPosting } from "../src/read.ts";
import { findRule, severityOf } from "../src/rules/registry.ts";

function ldJson(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

function page(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function readOf(html: string): PostingRead {
  const result = readPosting(html);
  if (!result.ok) {
    assert.fail(`readPosting refused the page as ${result.refusal.code}`);
  }
  return result.read;
}

const JOB_POSTING = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Staff Engineer",
  datePosted: "2026-01-15",
  hiringOrganization: { "@type": "Organization", name: "Acme Robotics" },
  baseSalary: {
    "@type": "MonetaryAmount",
    currency: "CAD",
    value: { "@type": "QuantitativeValue", minValue: 100000, maxValue: 150000, unitText: "YEAR" },
  },
};

test("a JobPosting block is read, including one inside a @graph", () => {
  const read = readOf(
    page(
      "<h1>Staff Engineer</h1>",
      ldJson({ "@type": "Organization", name: "Acme Robotics" }) +
        ldJson({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, JOB_POSTING] }),
    ),
  );
  assert.equal(read.scripts, 2);
  assert.deepEqual(read.jobPostings.map((posting) => posting["title"]), ["Staff Engineer"]);
  assert.deepEqual(read.findings, []);
});

test("script, style, template, [hidden] and aria-hidden are not visible text", () => {
  const read = readOf(
    page(
      [
        "<h1>Staff Engineer</h1>",
        "<p>Acme   Robotics\n is hiring.</p>",
        "<style>.pay { color: red }</style>",
        "<script>const draft = 1;</script>",
        "<template><p>Template copy</p></template>",
        "<div hidden><p>Draft copy</p></div>",
        '<div aria-hidden="true">Decorative copy</div>',
        '<div aria-hidden="false">Apply at jobs.example.com.</div>',
      ].join(""),
    ),
  );
  assert.equal(read.visibleText, "Staff Engineer Acme Robotics is hiring. Apply at jobs.example.com.");
});

test("a script that is not JSON is a finding naming its index, never a throw", () => {
  const read = readOf(
    page(
      "<h1>Staff Engineer</h1>",
      '<script type="application/ld+json">{ not json }</script>' + ldJson(JOB_POSTING),
    ),
  );
  assert.deepEqual(read.findings.map((finding) => finding.ruleId), ["input/bad-jsonld"]);
  assert.equal(read.findings[0]?.at, "/ld+json/0");
  assert.match(read.findings[0]?.message ?? "", /index 0/);
  assert.equal(read.jobPostings.length, 1);
  for (const finding of read.findings) {
    const rule = findRule(finding.ruleId);
    assert.equal(rule?.kind, "shape");
    assert.equal(rule === undefined ? undefined : severityOf(rule), finding.severity);
  }
});

test("two JobPosting blocks that disagree on title are refused", () => {
  const result = readPosting(
    page(
      "<h1>Staff Engineer</h1>",
      ldJson(JOB_POSTING) + ldJson({ ...JOB_POSTING, title: "Senior Engineer" }),
    ),
  );
  if (result.ok) {
    assert.fail("a page stating two different titles should be refused");
  }
  assert.equal(result.refusal.code, "input/conflicting-jobposting");
  assert.equal(result.refusal.at, "/jobPosting/1/title");
  assert.match(result.refusal.message, /"Senior Engineer"/);
});

test("the same title stated twice is read, on normalized whitespace and case", () => {
  const read = readOf(
    page(
      "<h1>Staff Engineer</h1>",
      ldJson(JOB_POSTING) + ldJson({ ...JOB_POSTING, title: "  staff   ENGINEER " }),
    ),
  );
  assert.equal(read.jobPostings.length, 2);
});

test("the posting is built from the visible text and the markup", () => {
  const read = readOf(
    page("<h1>Staff Engineer</h1><p>Acme Robotics is hiring.</p>", ldJson(JOB_POSTING)),
  );
  const posting = postingFrom(read);
  assert.equal(posting.visibleText, "Staff Engineer Acme Robotics is hiring.");
  assert.equal(posting.datePosted, "2026-01-15");
  assert.deepEqual(posting.payRange, { min: 100000, max: 150000, currency: "CAD", period: "YEAR" });

  const stamped = readOf(page("<p>Acme.</p>", ldJson({ ...JOB_POSTING, datePosted: "2026-01-15T09:00:00Z" })));
  assert.equal(postingFrom(stamped).datePosted, "2026-01-15");

  const bare = postingFrom(readOf(page("<p>Acme Robotics is hiring.</p>")));
  assert.equal(bare.datePosted, undefined);
  assert.equal(bare.payRange, undefined);
});

test("expected pay stated as one figure is a range whose ends coincide", () => {
  const read = readOf(
    page(
      "<p>Acme.</p>",
      ldJson({
        ...JOB_POSTING,
        baseSalary: {
          "@type": "MonetaryAmount",
          currency: "CAD",
          value: { "@type": "QuantitativeValue", value: 120000, unitText: "year" },
        },
      }),
    ),
  );
  assert.deepEqual(postingFrom(read).payRange, {
    min: 120000,
    max: 120000,
    currency: "CAD",
    period: "YEAR",
  });
});

test("two runs over the same page read identically", () => {
  const html = page("<h1>Staff Engineer</h1>", ldJson(JOB_POSTING));
  assert.deepEqual(readPosting(html), readPosting(html));
});
