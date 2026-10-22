export interface AllowedSource {
  readonly name: string;
  readonly host: string;
  readonly pathPrefix?: string;
}

export const ALLOWED_SOURCES: readonly AllowedSource[] = [
  { name: "EUR-Lex", host: "eur-lex.europa.eu" },
  { name: "Ontario e-Laws", host: "www.ontario.ca", pathPrefix: "/laws" },
  { name: "ISAP, the Sejm law database", host: "isap.sejm.gov.pl" },
  { name: "Google developer documentation", host: "developers.google.com" },
  { name: "California Legislative Information", host: "leginfo.legislature.ca.gov" },
  { name: "Colorado General Assembly", host: "leg.colorado.gov" },
  { name: "Connecticut General Assembly", host: "www.cga.ct.gov" },
  { name: "Council of the District of Columbia, Code", host: "code.dccouncil.gov" },
  { name: "Hawaii State Legislature", host: "www.capitol.hawaii.gov" },
  { name: "Illinois General Assembly", host: "www.ilga.gov" },
  { name: "Maine Legislature", host: "legislature.maine.gov" },
  { name: "Maryland General Assembly", host: "mgaleg.maryland.gov" },
  { name: "Massachusetts General Court", host: "malegislature.gov" },
  { name: "Minnesota Office of the Revisor of Statutes", host: "www.revisor.mn.gov" },
  { name: "Nevada Legislature", host: "www.leg.state.nv.us" },
  { name: "New Jersey Legislature", host: "www.njleg.state.nj.us" },
  { name: "New York State Senate", host: "www.nysenate.gov" },
  { name: "Vermont General Assembly", host: "legislature.vermont.gov" },
  { name: "Washington State Legislature", host: "app.leg.wa.gov" },
];

function matchesPathPrefix(pathname: string, prefix: string | undefined): boolean {
  if (prefix === undefined) {
    return true;
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function findAllowedSource(url: string): AllowedSource | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_SOURCES.find(
    (source) => source.host === host && matchesPathPrefix(parsed.pathname, source.pathPrefix),
  );
}

export function isAllowedSourceUrl(url: string): boolean {
  return findAllowedSource(url) !== undefined;
}

export function describeAllowlist(): string {
  return ALLOWED_SOURCES.map((source) =>
    source.pathPrefix === undefined ? source.host : `${source.host}${source.pathPrefix}`,
  ).join(", ");
}
