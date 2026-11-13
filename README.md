# jobpostrules

Lint a job posting before it is published: pay-transparency and disclosure rules by
jurisdiction as of the posting date, prohibited application questions, the pay range
reaching candidates before the first interview, and Google JobPosting markup that matches
the visible page. Rules are data with primary-source citations.

This is a lint, not legal advice.

## Status

Core phase. The pay range is in place: a range is two numbers, one currency and one
period, or it is a finding. The rule registry is in place, so a rule can only fail a
posting once its primary source has been read. `lint()` is in place and reads law rules as
of the day the ad was posted. The jurisdiction union is in place: the rules that apply are
the union of every region the role is open to. The first law rules ship: Ontario's
job-posting duties under the Employment Standards Act, 2000, Part III.1, covering expected
compensation, the existing-vacancy statement, the AI-use disclosure and the
Canadian-experience prohibition. The posting is now read from rendered HTML: its
JobPosting markup and its visible text. The command line, the application questions and
the markup checks follow.

## Requirements

Node 22.18 or newer. TypeScript sources run directly under Node, so there is no build
step. parse5 (MIT), pinned to an exact version, is the only runtime dependency.

```sh
npm install
npm test
```

## Usage

```ts
import { checkPayRange } from "./src/payrange.ts";

const findings = checkPayRange({
  visibleText: "Acme Robotics is hiring a Staff Engineer. Apply at jobs.example.com.",
  datePosted: "2026-01-15",
  payRange: {
    min: 120000,
    max: 150000,
    currency: "USD",
    period: "YEAR",
    stated: "$120,000 - $150,000 per year",
  },
});
// findings: []
```

A `Finding` carries `ruleId`, `severity`, `message` and `at`, the path inside the posting
that the finding points at. Findings sort by severity, then rule id, then path, so two
runs over the same posting print identically.

## Reading a rendered page

The input is HTML that is already rendered: there is no network and no browser.
`readPosting(html)` returns the JobPosting objects carried by the page's
`application/ld+json` scripts, including those inside a `@graph`, and the visible text
with `script`, `style`, `template`, `[hidden]` and `aria-hidden="true"` elements removed
and whitespace normalized.

```ts
import { postingFrom, readPosting } from "./src/read.ts";

const result = readPosting(html);
if (result.ok) {
  result.read.jobPostings; // the JobPosting objects, in document order
  result.read.visibleText; // "Staff Engineer Acme Robotics is hiring. ..."
  result.read.findings; // [{ ruleId: "input/bad-jsonld", ... }, ...]
  postingFrom(result.read); // the visible text, datePosted and baseSalary as a Posting
}
```

A script that is not JSON is `input/bad-jsonld`, a finding naming the index of that script
among the `application/ld+json` scripts on the page: a broken block is reported, never
thrown, and the other blocks are still read. Two JobPosting blocks that disagree on
`title` are refused as `input/conflicting-jobposting`: which of the two the page states is
undecidable, so the page is not linted at all rather than linted against a guess.

| Rule id | Severity | Refuses |
| --- | --- | --- |
| `input/bad-jsonld` | error | An `application/ld+json` script that is not JSON. |

`postingFrom()` reads `datePosted` and the `baseSalary` of the first JobPosting block into
a `Posting`, so a page can be linted as it stands; whether that markup matches the visible
page is the markup check that follows.

## As of the posting date

A law changes on a date; an ad is posted on a date. `lint()` reads the rules as of the day
the ad was posted, never the day the lint runs:

```ts
import { lint } from "./src/lint.ts";

const result = lint(posting, manifest);
if (result.ok) {
  result.report.asOf; // "2026-01-15", the posting date
  result.report.notApplied; // [{ ruleId, reason }, ...]
}
```

`options.asOf` is used first, then `posting.datePosted`; with neither the input is refused
as `input/no-as-of` rather than linted against today. A cited rule carries `effectiveFrom`
and an optional `effectiveTo`, both inclusive dates: a rule whose window does not contain
`asOf` goes into `report.notApplied` with the reason it was skipped instead of being
dropped silently, and `report.asOf` records the date the report was built from. Shape
rules check the posting against itself, so they carry no window and always apply.

The `manifest` argument carries the JobPosting markup for the markup checks that follow;
it is accepted and not yet read.

## Which rules apply

A role open to more than one place is held to every one of them:

```ts
import { checkJurisdiction } from "./src/jurisdiction.ts";

const report = checkJurisdiction({
  onsiteLocation: "CA-ON",
  remote: true,
  remoteEligible: ["PL", "US-NY"],
  employerHeadcount: 40,
});
report.reached; // the rule ids reached by any of those regions
report.outOfScope; // [{ ruleId, reason }, ...]
```

The applicable set is the union over the onsite location and every remote-eligible region,
each rule then filtered by its `minHeadcount` threshold. Regions are ISO 3166-1 countries
(`PL`) or ISO 3166-2 subdivisions (`CA-ON`, `US-NY`); a role open to a whole country is
taken to reach every subdivision in it, and a role open to one subdivision is reached by a
rule covering its country.

That union is the strictest place the role reaches. It is a conservative approximation for
a lint, not a statement of legal scope. Which regions the role is open to is a hiring
decision: the report reads it and never asks for it to be changed to get out of a rule.

Fail-closed, with `report.notes` saying which case applied: when the headcount is not a
stated whole number every threshold counts as met, and when the regions cannot be read in
full every region-scoped rule counts as reached. A rule outside the set is listed in
`report.outOfScope` with its reason rather than dropped silently. `lint()` does not read
the jurisdiction manifest yet.

| Rule id | Severity | Refuses |
| --- | --- | --- |
| `jurisdiction/remote-without-region` | error | A posting marked remote that names no eligible region. |
| `jurisdiction/unknown-region` | error | A region that is neither an ISO 3166-1 country nor an ISO 3166-2 subdivision. |
| `jurisdiction/unknown-headcount` | warning | A headcount that is not a stated whole number; every threshold then counts as met. |

## Rule registry

`src/rules/registry.ts` holds the shape rules as records and the checks every rule record
is held to. A law or platform rule carries an id, a jurisdiction, a status, an effective
window, an optional `minHeadcount` threshold and a citation `{url, section, verifiedAt}`.
Its severity is derived from the status, never written by hand:

| Status | Severity | Means |
| --- | --- | --- |
| `in-force` | error | Read in the primary source and in force. |
| `advisory` | warning | Guidance or a regulator's reading rather than a statute. |
| `unverified` | warning | Written from a secondary source; the primary source is not read yet. |
| `pending` | info | Enacted but not yet applicable. |

So a rule without a read primary-source citation cannot fail a posting. Shape rules
(`input/*`, `pay-range/*`, `jurisdiction/*`) carry `kind: "shape"`: they check the posting
against itself and need no citation. A jurisdiction module exports its own records, and a
caller composes them with `RULES`: `[...RULES, ...ONTARIO_RULES]` is what `lint()` and
`checkJurisdiction()` accept.

`test/registry.test.ts` fails the build when a law or platform rule is missing `url`,
`section` or `verifiedAt`, when its effective window is malformed or ends before it
starts, or when an in-force rule cites a host outside the allowlist in
`src/rules/sources.ts`: EUR-Lex, `www.ontario.ca/laws`, ISAP, `developers.google.com` and
the US state legislature hosts listed there by name. A `minHeadcount` that is not a whole
number of employees above zero fails the build too.

## Pay range rules

| Rule id | Severity | Refuses |
| --- | --- | --- |
| `pay-range/missing` | error | A posting with no pay range at all. |
| `pay-range/min-above-max` | error | A low end above the high end. |
| `pay-range/unknown-currency` | error | A currency that is not an ISO 4217 alpha-3 code. |
| `pay-range/unknown-period` | error | A period outside `HOUR`, `DAY`, `WEEK`, `MONTH`, `YEAR`. |
| `pay-range/open-ended` | warning | Open-ended wording in the stated range: `120k+`, `up to`, `competitive`, `DOE`. |

## Ontario

`src/rules/ontario.ts` reads a posting against the job-posting duties in the Employment
Standards Act, 2000, Part III.1 and O. Reg. 476/24, in force from 2026-01-01 for an
employer with 25 or more employees on the posting date:

```ts
import { checkOntario } from "./src/rules/ontario.ts";

const report = checkOntario(posting, { employerHeadcount: 40 }, "2026-02-01");
report.findings; // sorted findings
report.notApplied; // [{ ruleId, reason }, ...]
report.spread; // the width of the stated range
report.thresholdComputed; // false unless the range is CAD a year
```

| Rule id | Severity | Refuses |
| --- | --- | --- |
| `ca-on/compensation-missing` | error | A posting stating neither the expected pay nor a range. |
| `ca-on/range-too-wide` | warning | A CAD range wider than 50,000 with no exemption. |
| `ca-on/vacancy-not-stated` | warning | A posting that does not say whether it is for an existing vacancy. |
| `ca-on/ai-disclosure` | error | AI-assisted screening with no disclosure sentence in the visible text. |
| `ca-on/ai-disclosure-without-ai` | warning | A disclosure sentence with no AI-assisted step in the pipeline. |
| `ca-on/canadian-experience` | error | A Canadian-experience requirement in the posting text or the application form. |

Expected pay stated as one figure is a range whose ends coincide, so `min` equals `max`
and the width is zero. A CAD range wider than 50,000 fails unless the expected pay or the
top of the range is above 200,000 a year; that threshold is computed for a `YEAR` range
only. A `HOUR`, `DAY`, `WEEK` or `MONTH` range gets no exemption, `report.thresholdComputed`
is false and a note says the threshold was not computed. A range in another currency is
not measured against the 50,000 limit, and a note says so.

The posting states whether it is for an existing vacancy through `posting.existingVacancy`:
`true` or `false` both state it, and leaving it out is the finding.

### Artificial intelligence in the pipeline

The manifest's `pipeline` lists the steps an applicant goes through, each with a `type` and
an `aiAssisted` flag, and declares the sentence the ad uses to disclose that use:

```ts
const report = checkOntario(
  posting,
  {
    employerHeadcount: 40,
    pipeline: {
      steps: [{ type: "screening", aiAssisted: true }, { type: "interview" }],
      aiDisclosure: "Acme uses artificial intelligence to screen applicants for this role.",
    },
  },
  "2026-02-01",
);
report.aiAssistedSteps; // ["screening"]
report.aiDisclosureStated; // whether the declared sentence is in the visible text
```

When a `screening`, `assessment` or `selection` step is `aiAssisted`, the declared sentence
appears in the visible text or `ca-on/ai-disclosure` fails; an `aiAssisted` step of another
type carries no disclosure duty. A sentence that reaches the visible text while no such step
is `aiAssisted` is `ca-on/ai-disclosure-without-ai`, a warning: the duty attaches to the use
of the tool, not to the sentence, so the mismatch between the ad and the pipeline is reported
rather than failed. A manifest with no `pipeline` reads no AI-assisted step, and a note says
so.

### Canadian experience

Neither the posting text nor the application form schema in `posting.applicationForm` carries
a requirement related to Canadian experience: a phrase from
`src/lexicon/canadian-experience.ts` in the visible text, or in a form field's name, label or
options, fails `ca-on/canadian-experience` with the matched phrase quoted and `at` pointing
at the field. Matching is case-insensitive over normalized whitespace. The lint reads the
phrase where it appears, not whether the sentence around it frames the experience as a
requirement.

### Citations

The sections are cited as read on `www.ontario.ca/laws`. `ca-on/range-too-wide` and
`ca-on/vacancy-not-stated` are registered as `unverified`, so they warn rather than fail:
the width in O. Reg. 476/24 and the vacancy statement in Part III.1 are in the lint, but
their section numbering is not confirmed in the primary source yet.
`ca-on/ai-disclosure-without-ai` is registered as `advisory`: it is a reading of how the
disclosure duty attaches rather than a prohibition in the statute. `lint()` does not read
the Ontario manifest yet.

## Fixtures

Every fixture in this repository is synthetic: Acme and `example.com`, never a real
employer, posting or candidate.

## License

MIT. Maintained by [Shipmind Labs](https://shipmindlabs.com).
