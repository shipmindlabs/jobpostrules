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
the union of every region the role is open to. No legal rule ships yet; application
questions and markup checks follow.

## Requirements

Node 22.18 or newer. TypeScript sources run directly under Node, so there is no build
step and no runtime dependencies.

```sh
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

`src/rules/registry.ts` holds every rule as a record. A law or platform rule carries an
id, a jurisdiction, a status, an effective window, an optional `minHeadcount` threshold
and a citation `{url, section, verifiedAt}`. Its severity is derived from the status, never
written by hand:

| Status | Severity | Means |
| --- | --- | --- |
| `in-force` | error | Read in the primary source and in force. |
| `advisory` | warning | Guidance or a regulator's reading rather than a statute. |
| `unverified` | warning | Written from a secondary source; the primary source is not read yet. |
| `pending` | info | Enacted but not yet applicable. |

So a rule without a read primary-source citation cannot fail a posting. Shape rules
(`pay-range/*`, `jurisdiction/*`) carry `kind: "shape"`: they check the posting against
itself and need no citation.

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

## Fixtures

Every fixture in this repository is synthetic: Acme and `example.com`, never a real
employer, posting or candidate.

## License

MIT. Maintained by [Shipmind Labs](https://shipmindlabs.com).
