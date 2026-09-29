// Deterministic query understanding for retrieval: no model, no embeddings.
// A natural question ("what do you know about my sleep habits?") is reduced to
// its content terms; each source is searched per term and results are ranked
// by how many terms they match.

const STOPWORDS = new Set(
  (
    // English
    "a an the and or but if then else of to in on at by for with about as is are was were be been being do does did doing have has had having " +
    "i me my mine you your yours he she it we they them their our what which who whom whose when where why how this that these those " +
    "not no yes can could should would will shall may might must tell know remember brief please any some all more most from into over under " +
    // Spanish
    "el la los las un una unos unas y o pero si de del al en con por para como es son fue ser estar qué que quién cuál cuándo dónde cómo " +
    "yo tú mi mis tu tus su sus me te se lo nos les sobre dime sabes recuerda favor"
  ).split(/\s+/)
);

export const MAX_TERMS = 5;

/** Lowercased content terms of length >= 3, stopwords removed, unique, in order of appearance, at most MAX_TERMS. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/** Merges per-term result lists: score = number of terms that returned the item; ties keep the earlier (more recent) position. */
export function rankByTermOverlap<T extends { id: string }>(perTerm: T[][], limit: number): T[] {
  const score = new Map<string, number>();
  const first = new Map<string, { item: T; order: number }>();
  let order = 0;
  for (const list of perTerm) {
    for (const item of list) {
      score.set(item.id, (score.get(item.id) ?? 0) + 1);
      if (!first.has(item.id)) first.set(item.id, { item, order: order++ });
    }
  }
  return [...first.values()]
    .sort((a, b) => score.get(b.item.id)! - score.get(a.item.id)! || a.order - b.order)
    .slice(0, limit)
    .map((e) => e.item);
}
