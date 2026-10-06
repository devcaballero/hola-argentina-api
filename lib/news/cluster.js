/**
 * Agrupación conservadora de coberturas del mismo evento.
 *
 * No es deduplicación (eso es dedupe.js, para titulares casi idénticos): acá se juntan
 * notas DISTINTAS sobre un mismo hecho (p. ej. "cortes de calle por la despedida de Messi" y
 * "la línea D extiende su horario por el partido") para que no ocupen media página,
 * pero cada una sigue visible con su título, medio y link originales.
 *
 * Reglas (todas deben cumplirse entre la nota principal y cada relacionada):
 * - Comparten al menos MIN_SHARED_ANCHORS "anclas" en el título.
 *   Ancla = palabra significativa (>= 4 letras, o "línea X") que es POCO FRECUENTE en el
 *   conjunto de notas del momento (df <= max(ANCHOR_MIN_DF, ANCHOR_MAX_SHARE × N)) y no está
 *   en la lista de palabras genéricas. Los números solos no son anclas (fechas, cifras).
 * - Publicadas con menos de MAX_GAP_MS de diferencia.
 * - Si ambas nombran una línea de subte/tren, tiene que ser la misma.
 * - Si ambas tienen una fecha ("5 de octubre"), tiene que ser la misma.
 * Agrupación en estrella: cada relacionada se compara con la SEMILLA del grupo (la mejor rankeada),
 * nunca en cadena (A~B y B~C no implica agrupar A con C). Máximo MAX_RELATED relacionadas por grupo.
 *
 * Orden de eventos vs. nota principal (criterios separados):
 * - Los eventos se ordenan por su semilla (relevancia local + actualidad + diversidad de medios, rank.js).
 * - La nota principal del grupo se elige aparte (chooseLead): la MÁS RECIENTE entre las
 *   "directamente relevantes", para que una nota reciente pero tangencial no desplace a la cobertura
 *   directa. Relevancia directa, en orden:
 *     1) coincide con la zona elegida por su propio alcance (no solo como localidad afectada);
 *     2) centralidad: comparte >= MIN_SHARED_ANCHORS anclas con al menos la mitad de las otras notas
 *        del grupo (una nota tangencial se conecta con pocas).
 *   Desempates deterministas: más reciente → mayor señal local → medio (id) → id de la nota.
 * - Las relacionadas se muestran de más nueva a más vieja (mismos desempates).
 */
const { titleTokens } = require('./dedupe');

const MIN_SHARED_ANCHORS = 2;
const ANCHOR_MIN_DF = 3;
const ANCHOR_MAX_SHARE = 0.03;
const MAX_GAP_MS = 24 * 60 * 60 * 1000;
const MAX_RELATED = 4;

/** Palabras frecuentes en titulares que no identifican un hecho. */
const GENERIC = new Set(
  ('como cuando donde cual cuales anunciaron anuncio nuevo nueva nuevos nuevas hoy manana ayer '
    + 'ultimo ultima ultimos ultimas semana dias horas mapa video fotos todo todos saber '
    + 'despues antes tras porque explico dijo hablo sera seran fue esta estan hasta desde '
    + 'gobierno ciudad argentina argentinos buenos aires pais caso casos personas gente '
    + 'precio precios cuanto cuesta quien quienes donde ahora otra vez '
    // Vocabulario policial: se repite en hechos distintos (dos crímenes no son un evento).
    + 'hombre mujer pareja joven chico chica vecino vecina vecinos acusado acusada acusados '
    + 'detuvieron detenido detenida matar mato murio muerte muerto asesinato asesino victima '
    + 'ataque ataco golpeo golpeaba abuso sexual denuncia denunciado denunciada crimen policia')
    .split(' ')
);

function anchorCandidates(tokens) {
  return [...tokens].filter(
    (t) => (t.startsWith('linea_') || (t.length >= 4 && !/^\d+$/.test(t))) && !GENERIC.has(t)
  );
}

/** Frecuencia de documento de cada token en un conjunto de títulos. */
function documentFrequency(items) {
  const df = new Map();
  for (const item of items) {
    for (const t of new Set(anchorCandidates(titleTokens(item.title)))) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return { df, size: items.length };
}

function anchorsOf(item, stats) {
  const limit = Math.max(ANCHOR_MIN_DF, Math.floor(ANCHOR_MAX_SHARE * stats.size));
  return new Set(
    anchorCandidates(titleTokens(item.title)).filter((t) => (stats.df.get(t) || 0) <= limit)
  );
}

function lines(anchors) {
  return [...anchors].filter((t) => t.startsWith('linea_'));
}

const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DATE_RE = new RegExp(`\\b(\\d{1,2}) de (${MONTHS})\\b`, 'g');

function titleDates(title) {
  const text = String(title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return [...text.matchAll(DATE_RE)].map((m) => `${m[1]}-${m[2]}`).sort().join('|');
}

function isSameEvent(lead, other, stats) {
  const da = titleDates(lead.title);
  const db = titleDates(other.title);
  if (da && db && da !== db) return false;
  const gap = Math.abs(Date.parse(lead.publishedAt) - Date.parse(other.publishedAt));
  if (!(gap <= MAX_GAP_MS)) return false;
  const a = lead._anchors || anchorsOf(lead, stats);
  const b = other._anchors || anchorsOf(other, stats);
  const la = lines(a);
  const lb = lines(b);
  if (la.length && lb.length && !la.some((l) => lb.includes(l))) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared >= MIN_SHARED_ANCHORS;
}

const GEO_DIRECT = {
  caba: (m) => m.geo === 'caba',
  amba: (m) => m.geo === 'caba' || m.geo === 'amba',
  argentina: () => true,
};

/** Orden determinista: más reciente, más local, medio, id. */
function byRecency(a, b) {
  return Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    || (b.localScore || 0) - (a.localScore || 0)
    || String(a.sourceId).localeCompare(String(b.sourceId))
    || String(a.id).localeCompare(String(b.id));
}

/** Elige la nota principal y ordena las relacionadas (ver criterios arriba). */
function chooseLead(members, stats, filters = {}) {
  if (members.length === 1) return { lead: members[0], related: [] };
  const anchors = members.map((m) => anchorsOf(m, stats));
  const geoDirect = GEO_DIRECT[filters.geo] || GEO_DIRECT.argentina;
  const half = Math.ceil((members.length - 1) / 2);
  const tier = members.map((m, i) => {
    let links = 0;
    for (let j = 0; j < members.length; j += 1) {
      if (j === i) continue;
      let shared = 0;
      for (const t of anchors[i]) if (anchors[j].has(t)) shared += 1;
      if (shared >= MIN_SHARED_ANCHORS) links += 1;
    }
    return [geoDirect(m) ? 1 : 0, links >= half ? 1 : 0];
  });
  const best = tier.reduce((acc, t) => (t[0] > acc[0] || (t[0] === acc[0] && t[1] > acc[1]) ? t : acc), [0, 0]);
  const candidates = members.filter((_, i) => tier[i][0] === best[0] && tier[i][1] === best[1]);
  const lead = [...candidates].sort(byRecency)[0];
  const related = members.filter((m) => m !== lead).sort(byRecency);
  return { lead, related };
}

/**
 * Recibe notas YA ordenadas por relevancia. Devuelve grupos en el orden de sus semillas:
 * [{ lead, related: [...] }], con la nota principal elegida por chooseLead.
 */
function clusterRanked(ranked, stats, filters = {}) {
  const pool = ranked.map((item) => ({ item, anchors: anchorsOf(item, stats), used: false }));
  const groups = [];
  for (let i = 0; i < pool.length; i += 1) {
    if (pool[i].used) continue;
    pool[i].used = true;
    const lead = { ...pool[i].item, _anchors: pool[i].anchors };
    const related = [];
    for (let j = i + 1; j < pool.length && related.length < MAX_RELATED; j += 1) {
      if (pool[j].used) continue;
      const other = { ...pool[j].item, _anchors: pool[j].anchors };
      if (isSameEvent(lead, other, stats)) {
        pool[j].used = true;
        related.push(pool[j].item);
      }
    }
    groups.push(chooseLead([pool[i].item, ...related], stats, filters));
  }
  return groups;
}

module.exports = {
  clusterRanked,
  chooseLead,
  documentFrequency,
  isSameEvent,
  anchorsOf,
  MIN_SHARED_ANCHORS,
  MAX_RELATED,
};
