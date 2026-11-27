export const PAY_HISTORY_PHRASES: readonly string[] = [
  "current salary",
  "current pay",
  "current compensation",
  "current wage",
  "current earnings",
  "present salary",
  "salary history",
  "pay history",
  "compensation history",
  "wage history",
  "previous salary",
  "previous pay",
  "last salary",
  "most recent salary",
  "what do you currently earn",
  "obecne wynagrodzenie",
  "aktualne wynagrodzenie",
  "obecna pensja",
  "obecne zarobki",
  "aktualne zarobki",
  "poprzednie wynagrodzenie",
  "ostatnie wynagrodzenie",
  "dotychczasowe wynagrodzenie",
  "poprzednie zarobki",
  "dotychczasowe zarobki",
  "historia wynagrodzeń",
  "wysokość obecnego wynagrodzenia",
];

// A form field carries its question as a name as well as a label, so camelCase and
// snake_case are folded to the words a phrase is written in.
export function foldQuestion(value: string): string {
  return value
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

export function matchPayHistory(text: string): string[] {
  const haystack = foldQuestion(text);
  return PAY_HISTORY_PHRASES.filter((phrase) => haystack.includes(foldQuestion(phrase)));
}
