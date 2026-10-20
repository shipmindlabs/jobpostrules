# jobpostrules

Lint a job posting before it is published: pay-transparency and disclosure rules by
jurisdiction as of the posting date, prohibited application questions, the pay range
reaching candidates before the first interview, and Google JobPosting markup that matches
the visible page. Rules are data with primary-source citations.

This is a lint, not legal advice.

## Status

Core phase. The pay range is in place: a range is two numbers, one currency and one
period, or it is a finding. Jurisdiction rules, application questions and markup checks
follow.

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
