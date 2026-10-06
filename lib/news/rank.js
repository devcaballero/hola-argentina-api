/**
 * Filtros, facetas y orden del feed.
 *
 * Combinación de filtros (AND entre dimensiones, una opción por dimensión), sobre NOTAS:
 * - geo: alcance anidado. caba = notas de alcance CABA + notas nacionales que afectan
 *        explícitamente a CABA; amba = lo anterior + conurbano (y nacionales que afectan al AMBA);
 *        argentina = todo lo que pasó las exclusiones.
 * - tema: "todas", un tema, u "otros" (notas sin ninguno de los temas). Una nota puede tener
 *         varios temas: aparece en cada uno, sin duplicarse dentro de un resultado.
 * - medio: "todos" o un medio.
 *
 * Después de filtrar, las notas se ordenan y se AGRUPAN por evento (cluster.js). La unidad de
 * navegación y de todos los conteos es el EVENTO (grupo): `total`, "Ver más" y cada faceta cuentan
 * los grupos que se obtendrían al elegir esa opción con los otros dos filtros aplicados (agrupando
 * ese subconjunto). Por eso los temas pueden sumar más que "Todas" (se superponen) y "Otros" no se
 * calcula por resta. `totalNotes` informa cuántas notas hay detrás de esos eventos.
 */
const { TOPIC_IDS } = require('./rules');

/** Temas filtrables: los de rules.js + "otros" (sin ninguno). */
const FILTER_TEMAS = [...TOPIC_IDS, 'otros'];
const { clusterRanked, documentFrequency } = require('./cluster');

const GEO_IDS = ['caba', 'amba', 'argentina'];
const GEO_SCOPE = {
  caba: new Set(['caba']),
  amba: new Set(['caba', 'amba']),
  argentina: new Set(['caba', 'amba', 'argentina']),
};
const GEO_WEIGHT = { caba: 1, amba: 0.6, argentina: 0.2 };

/** Vida media de la actualidad: una nota de hace 8 h pesa la mitad que una recién salida. */
const RECENCY_HALF_LIFE_H = 8;
/** Señal local a partir de la cual se considera "muy local" (normaliza localScore a 0–1). */
const LOCAL_SCORE_CAP = 9;
/** Cada nota ya elegida del mismo medio multiplica el puntaje de las siguientes por este factor. */
const DIVERSITY_PENALTY = 0.75;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 40;

function parseFilters(query = {}) {
  const geo = GEO_IDS.includes(query.geo) ? query.geo : 'caba';
  const tema = FILTER_TEMAS.includes(query.tema) ? query.tema : 'todas';
  const medio = typeof query.medio === 'string' && /^[a-z0-9]{1,20}$/.test(query.medio)
    ? query.medio
    : 'todos';
  const n = Number.parseInt(query.limit, 10);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  return { geo, tema, medio, limit };
}

/** Zona: alcance de la nota, o una localidad afectada explícitamente (notas nacionales). */
function inGeo(item, geo) {
  if (GEO_SCOPE[geo].has(item.geo)) return true;
  const affects = item.affects || [];
  if (geo === 'caba') return affects.includes('CABA');
  if (geo === 'amba') return affects.includes('CABA') || affects.includes('AMBA');
  return false;
}

function inTema(item, tema) {
  if (tema === 'otros') return !item.topics.length;
  return item.topics.includes(tema);
}

function matches(item, { geo, tema, medio }) {
  if (geo && !inGeo(item, geo)) return false;
  if (tema && tema !== 'todas' && !inTema(item, tema)) return false;
  if (medio && medio !== 'todos' && item.sourceId !== medio) return false;
  return true;
}

/** Puntaje base: 50 % actualidad, 30 % alcance geográfico, 20 % fuerza de la señal local. */
function baseScore(item, now = Date.now()) {
  const ageH = Math.max(0, (now - Date.parse(item.publishedAt)) / 3600000);
  const recency = 0.5 ** (ageH / RECENCY_HALF_LIFE_H);
  const local = Math.min(item.localScore || 0, LOCAL_SCORE_CAP) / LOCAL_SCORE_CAP;
  // Nacional con impacto explícito en CABA/AMBA: pesa como AMBA (relevante, no exclusivamente local).
  const geoWeight = item.geo === 'argentina' && (item.affects || []).length ? GEO_WEIGHT.amba : (GEO_WEIGHT[item.geo] || 0);
  return 0.5 * recency + 0.3 * geoWeight + 0.2 * local;
}

/**
 * Orden greedy con penalización por medio: evita que un solo medio llene la primera página
 * sin esconder sus notas (si no hay alternativas, igual aparecen).
 */
function rankItems(items, now = Date.now()) {
  const pool = items.map((item) => ({ item, score: baseScore(item, now) }));
  const perSource = new Map();
  const out = [];
  while (pool.length) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const used = perSource.get(pool[i].item.sourceId) || 0;
      const s = pool[i].score * DIVERSITY_PENALTY ** used;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    const [{ item }] = pool.splice(best, 1);
    perSource.set(item.sourceId, (perSource.get(item.sourceId) || 0) + 1);
    out.push(item);
  }
  return out;
}

/** Eventos (grupos) que resultan de un filtro: lo que efectivamente se puede recorrer. */
function groupsFor(items, filters, now, stats) {
  const subset = items.filter((i) => matches(i, filters));
  return clusterRanked(rankItems(subset, now), stats, filters);
}

/** Cada faceta cuenta EVENTOS con los otros dos filtros aplicados (no notas, no restas). */
function buildFacets(items, filters, now = Date.now(), stats = documentFrequency(items)) {
  const count = (f) => groupsFor(items, f, now, stats).length;
  const geo = {};
  for (const id of GEO_IDS) geo[id] = count({ ...filters, geo: id });

  const tema = { todas: count({ ...filters, tema: 'todas' }) };
  for (const t of FILTER_TEMAS) tema[t] = count({ ...filters, tema: t });

  const medio = { todos: count({ ...filters, medio: 'todos' }) };
  const medios = new Set(items.filter((i) => matches(i, { geo: filters.geo, tema: filters.tema })).map((i) => i.sourceId));
  for (const m of medios) medio[m] = count({ ...filters, medio: m });

  return { geo, tema, medio };
}

/** Vista pública de una nota: sin descripción cruda ni señales internas. */
function toPublicItem(item) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    source: { id: item.sourceId, name: item.sourceName },
    geo: item.geo,
    location: item.location,
    /** Localidades afectadas explícitamente por una nota de alcance nacional (p. ej. ["CABA"]). */
    affects: item.affects || [],
    topics: item.topics,
    summary: item.summary || null,
    alsoIn: (item.alsoIn || []).map((a) => ({ source: { id: a.sourceId, name: a.sourceName }, url: a.url })),
  };
}

function toPublicGroup({ lead, related }) {
  return { ...toPublicItem(lead), related: related.map(toPublicItem) };
}

/**
 * @param {object[]} items notas clasificadas y deduplicadas
 * @param {object} query parámetros crudos
 * @param {number} now
 * @param {{ df: Map<string, number>, size: number }} [stats] frecuencias del snapshot completo
 */
function queryFeed(items, query, now = Date.now(), stats = documentFrequency(items)) {
  const filters = parseFilters(query);
  const groups = groupsFor(items, filters, now, stats);
  return {
    filters,
    unidad: 'eventos',
    total: groups.length,
    totalNotes: groups.reduce((n, g) => n + 1 + g.related.length, 0),
    items: groups.slice(0, filters.limit).map(toPublicGroup),
    facets: buildFacets(items, filters, now, stats),
  };
}

module.exports = {
  queryFeed,
  parseFilters,
  rankItems,
  baseScore,
  buildFacets,
  matches,
  inGeo,
  FILTER_TEMAS,
  GEO_IDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
