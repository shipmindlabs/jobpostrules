import { normalizeText } from "../model.ts";

export const CANADIAN_EXPERIENCE_PHRASES: readonly string[] = [
  "Canadian experience",
  "Canadian work experience",
  "Canadian working experience",
  "Canadian industry experience",
  "Canadian market experience",
  "Canadian employment experience",
  "experience in Canada",
  "experience within Canada",
  "experience working in Canada",
  "Canada-based experience",
  "Canadian-based experience",
];

export function matchCanadianExperience(text: string): string[] {
  const haystack = normalizeText(text);
  return CANADIAN_EXPERIENCE_PHRASES.filter((phrase) => haystack.includes(normalizeText(phrase)));
}
