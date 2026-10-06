/**
 * Deduplicación conservadora:
 * 1. Misma URL normalizada (ver normalizeUrl) → misma nota.
 * 2. Titulares casi idénticos → misma nota solo si se cumplen TODAS:
 *    - al menos MIN_TOKENS palabras significativas en cada uno;
 *    - Jaccard >= SIMILARITY_THRESHOLD;
 *    - mismos números (fechas, cifras, líneas de colectivo) y mismas líneas de subte/tren;
 *    - publicadas con menos de MAX_GAP_MS de diferencia.
 * Ante la duda se muestran las dos: es preferible un repetido a esconder una nota distinta.
 */
const { stripAccents } = require('./text');

const SIMILARITY_THRESHOLD = 0.7;
const MIN_TOKENS = 5;
const MAX_GAP_MS = 36 * 60 * 60 * 1000;

const STOPWORDS = new Set(
  ('a al ante bajo con contra de del desde durante e el en entre esta este esto hacia hasta la las le les lo los mas me mi muy ni no o para pero por que se si sin sobre su sus tras un una uno unos unas y ya es son fue ser hay como cual cuales cuando donde quien quienes asi tambien todo todos toda todas otra otro otros otras ese esa eso esos esas cada mientras segun tu te nos hoy ayer').split(' ')
);

function titleTokens(title) {
  const text = stripAccents(title).toLowerCase()
    // "línea A", "línea 60", "línea Sarmiento" → un token que distingue notas.
    .replace(/\blinea\s+([a-z0-9]+)/g, ' linea_$1 ')
    .replace(/[^a-z0-9_ ]+/g, ' ');
  const tokens = text.split(/\s+/).filter((t) => t && !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
  return new Set(tokens);
}

function distinguishing(tokens) {
  return [...tokens].filter((t) => /\d/.test(t) || t.startsWith('linea_')).sort().join('|');
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function isSimilarTitle(a, b) {
  const ta = a._tokens || titleTokens(a.title);
  const tb = b._tokens || titleTokens(b.title);
  if (ta.size < MIN_TOKENS || tb.size < MIN_TOKENS) return false;
  if (distinguishing(ta) !== distinguishing(tb)) return false;
  const gap = Math.abs(Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  if (!(gap <= MAX_GAP_MS)) return false;
  return jaccard(ta, tb) >= SIMILARITY_THRESHOLD;
}

/**
 * Recibe ítems clasificados y devuelve una lista sin duplicados.
 * Se conserva la versión con más señal local (y, a igualdad, la más reciente);
 * las otras quedan en `alsoIn` para enlazarlas como "También en".
 */
function dedupeItems(items) {
  const sorted = [...items].sort(
    (a, b) => (b.localScore || 0) - (a.localScore || 0)
      || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
  );
  const byUrl = new Map();
  const kept = [];

  for (const item of sorted) {
    const existing = byUrl.get(item.id);
    if (existing) {
      mergeTopics(existing, item);
      continue;
    }
    const candidate = { ...item, topics: [...(item.topics || [])], alsoIn: [], _tokens: titleTokens(item.title) };
    const twin = kept.find((k) => isSimilarTitle(k, candidate));
    if (twin) {
      if (twin.sourceId !== candidate.sourceId
        && !twin.alsoIn.some((x) => x.sourceId === candidate.sourceId)) {
        twin.alsoIn.push({ sourceId: candidate.sourceId, sourceName: candidate.sourceName, url: candidate.url });
      }
      mergeTopics(twin, candidate);
      byUrl.set(item.id, twin);
      continue;
    }
    kept.push(candidate);
    byUrl.set(item.id, candidate);
  }

  return kept.map(({ _tokens, ...rest }) => rest);
}

/** La misma nota en dos feeds (p. ej. Sociedad y Economía) acumula temas. */
function mergeTopics(target, other) {
  for (const t of other.topics || []) {
    if (!target.topics.includes(t)) target.topics.push(t);
  }
}

module.exports = { dedupeItems, isSimilarTitle, titleTokens, jaccard, SIMILARITY_THRESHOLD };
