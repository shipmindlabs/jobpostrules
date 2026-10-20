import type { Finding, PayRange, Posting } from "./model.ts";
import { PERIODS, isPeriod, sortFindings } from "./model.ts";

const ISO_4217_ALPHA_3 = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BOV",
  "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF",
  "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK",
  "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL",
  "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD",
  "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
  "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD",
  "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR",
  "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN",
  "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD",
  "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP",
  "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU",
  "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XAG", "XAU",
  "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF",
  "XPT", "XSU", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG",
]);

interface OpenEndedPattern {
  readonly pattern: RegExp;
  readonly label: string;
}

const OPEN_ENDED_PATTERNS: readonly OpenEndedPattern[] = [
  { pattern: /\d[\d.,]*\s*k?\s*\+/i, label: "an open upper bound such as 120k+" },
  { pattern: /\bup\s+to\b/i, label: "up to" },
  { pattern: /\bcompetitive\b/i, label: "competitive" },
  { pattern: /\bDOE\b/i, label: "DOE" },
];

function openEndedWording(stated: string): string[] {
  return OPEN_ENDED_PATTERNS.filter((candidate) => candidate.pattern.test(stated)).map(
    (candidate) => candidate.label,
  );
}

export function checkPayRange(posting: Posting): Finding[] {
  const range: PayRange | undefined = posting.payRange;
  if (range === undefined) {
    return [
      {
        ruleId: "pay-range/missing",
        severity: "error",
        message:
          "The posting carries no pay range; a range is two numbers, one currency and one period.",
        at: "/payRange",
      },
    ];
  }

  const findings: Finding[] = [];

  if (range.min > range.max) {
    findings.push({
      ruleId: "pay-range/min-above-max",
      severity: "error",
      message: `The low end ${range.min} is above the high end ${range.max}.`,
      at: "/payRange/min",
    });
  }

  if (!ISO_4217_ALPHA_3.has(range.currency)) {
    findings.push({
      ruleId: "pay-range/unknown-currency",
      severity: "error",
      message: `Currency ${JSON.stringify(range.currency)} is not an ISO 4217 alpha-3 code such as USD or EUR.`,
      at: "/payRange/currency",
    });
  }

  if (!isPeriod(range.period)) {
    findings.push({
      ruleId: "pay-range/unknown-period",
      severity: "error",
      message: `Period ${JSON.stringify(range.period)} is outside ${PERIODS.join(", ")}.`,
      at: "/payRange/period",
    });
  }

  const wording = range.stated === undefined ? [] : openEndedWording(range.stated);
  if (wording.length > 0) {
    findings.push({
      ruleId: "pay-range/open-ended",
      severity: "warning",
      message: `The stated range reads as open ended (${wording.join("; ")}); a candidate needs both ends of the range.`,
      at: "/payRange/stated",
    });
  }

  return sortFindings(findings);
}
