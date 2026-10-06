/**
 * Clasificación geográfica (caba / amba / argentina) y temática de una noticia,
 * usando las reglas de rules.js. Devuelve también las señales que dispararon,
 * para poder auditar por qué una nota cayó en cada grupo.
 */
const { stripAccents } = require('./text');
const {
  NATIONAL_SCOPE_RULES,
  IMPACT_CONTEXT,
  NEUTRAL_PHRASES,
  CABA_RULES,
  AMBA_RULES,
  PROVINCIA_RULES,
  EXCLUDED_PATH_SECTIONS,
  EXCLUDED_CATEGORIES,
  TOPIC_RULES,
} = require('./rules');

/** Umbral para considerar una nota local. Una señal fuerte (3) alcanza; una débil no. */
const LOCAL_THRESHOLD = 3;
/** Sección "Ciudades" de Clarín: suma 1 a CABA y a AMBA (cubre ambos). */
const LOCAL_SECTION_BONUS = 1;
const LOCAL_SECTIONS = new Set(['ciudades']);

/** Nombre de lugar para mostrar, con tildes (las reglas trabajan sin ellas). */
const DISPLAY_NAMES = {
  Nunez: 'Núñez', Constitucion: 'Constitución', Agronomia: 'Agronomía',
  'San Nicolas': 'San Nicolás', 'San Cristobal': 'San Cristóbal',
  'Villa Ortuzar': 'Villa Ortúzar', 'Villa Pueyrredon': 'Villa Pueyrredón',
  'Barrio Mugica': 'Barrio Mugica', 'Esteban Echeverria': 'Esteban Echeverría',
  'Gonzalez Catan': 'González Catán', Adrogue: 'Adrogué', Moron: 'Morón',
  'Vicente Lopez': 'Vicente López', Lanus: 'Lanús', Ituzaingo: 'Ituzaingó',
  Canuelas: 'Cañuelas', Benavidez: 'Benavídez', 'General Rodriguez': 'General Rodríguez',
  'San Martin': 'San Martín', 'General San Martin': 'General San Martín',
  'Presidente Peron': 'Presidente Perón', Lujan: 'Luján', Sarandi: 'Sarandí',
  'Jardin Japones': 'Jardín Japonés', 'Teatro Colon': 'Teatro Colón',
  'Reserva Ecologica': 'Reserva Ecológica', 'Mas Monumental': 'Más Monumental',
  Tecnopolis: 'Tecnópolis', Planetario: 'Planetario',
};

const CONTEXT_PREFIX = /^(?:barrio(?:\s+porteno)?\s+de|en\s+el\s+barrio\s+de|vecin[oa]s\s+de|zona\s+de|estacion(?:\s+de)?|terminal\s+de|partido\s+de|municipio\s+de|intendent[ea]\s+de|localidad\s+de|en)\s+/i;

function placeFromMatch(rule, match) {
  if (!rule.place) return null;
  if (rule.place === '$match' || rule.place === '$last') {
    const raw = match[0].replace(CONTEXT_PREFIX, '').replace(/\s+/g, ' ').trim();
    return DISPLAY_NAMES[raw] || raw;
  }
  return rule.place;
}

/**
 * Suma los pesos de las reglas que disparan. El lugar a mostrar sale del título
 * si alguna regla con lugar coincide ahí; si no, de la bajada.
 */
function evaluate(rules, text, title) {
  let score = 0;
  const signals = [];
  let place = null;
  let titlePlace = null;
  for (const rule of rules) {
    const match = text.match(rule.re);
    if (!match) continue;
    score += rule.weight;
    signals.push(rule.id);
    if (!rule.place) continue;
    if (!place) place = placeFromMatch(rule, match);
    const inTitle = !titlePlace && title.match(rule.re);
    if (inTitle) titlePlace = placeFromMatch(rule, inTitle);
  }
  return { score, signals, place: titlePlace || place };
}

function neutralize(text) {
  let out = text;
  for (const re of NEUTRAL_PHRASES) out = out.replace(new RegExp(re.source, 'gu'), ' ');
  return out;
}

function firstPathSegment(path) {
  return String(path || '').split('/').filter(Boolean)[0] || '';
}

/** true si la nota está fuera de alcance (internacional, deportes, espectáculos…). */
function isExcluded(item) {
  if (EXCLUDED_PATH_SECTIONS.has(firstPathSegment(item.path))) return true;
  return (item.categories || []).some((c) =>
    EXCLUDED_CATEGORIES.has(stripAccents(c).toLowerCase().trim())
  );
}

function sectionHints(item) {
  const hints = new Set();
  if (item.feedSection) hints.add(item.feedSection);
  const first = firstPathSegment(item.path);
  if (first) hints.add(first);
  for (const c of item.categories || []) hints.add(stripAccents(c).toLowerCase().trim());
  return hints;
}

/** Hay alguna regla de la lista que dispare en el texto. */
function anyRule(rules, text) {
  return rules.some((r) => r.re.test(text));
}

/**
 * ¿La bajada afecta explícitamente a la localidad? La mención y una expresión de impacto
 * (rige, afecta, cortes, paro…) tienen que estar en la misma oración.
 */
function explicitImpact(description, rules) {
  return description
    .split(/(?<=[.;:!?])\s+/)
    .some((sentence) => anyRule(rules, sentence) && IMPACT_CONTEXT.test(sentence));
}

const CABA_NAME_RULES = CABA_RULES.filter((r) => r.weight >= 2);

/**
 * Decide alcance (geo) y localidades afectadas (affects):
 *
 * 1. Puntaje local como antes (reglas CABA/AMBA sobre título + bajada):
 *    - caba: CABA >= 3 y (AMBA < 3, o CABA >= 2 × AMBA).
 *    - amba: AMBA >= 3, CABA y AMBA fuertes y parejos, o señales débiles de ambos que suman 3.
 * 2. Alcance nacional explícito (NATIONAL_SCOPE_RULES: "las provincias", "todo el país", SMN…):
 *    si aparece en el título, o si el título no tiene señales locales fuertes, la nota es
 *    `argentina` aunque la bajada nombre la Ciudad. Así una mención incidental en la bajada
 *    ("en la ciudad de Buenos Aires la máxima será de 21°C") no la vuelve porteña.
 * 3. En una nota nacional, CABA/AMBA son "localidades afectadas" solo si están en el título o si
 *    la bajada las nombra junto a un impacto explícito en la misma oración. Esas notas aparecen
 *    en el filtro CABA/AMBA por su relevancia local, pero se presentan como de alcance nacional.
 * Nunca se "promueve" una nota a CABA por falta de resultados.
 */
function classifyGeo(item) {
  const title = neutralize(stripAccents(item.title));
  const description = neutralize(stripAccents(
    [item.description, ...(item.categories || [])].filter(Boolean).join(' . ')
  ));
  const text = `${title} . ${description}`;
  const caba = evaluate(CABA_RULES, text, title);
  const amba = evaluate(AMBA_RULES, text, title);
  const provincia = evaluate(PROVINCIA_RULES, text, title);
  const cabaTitle = evaluate(CABA_RULES, title, title);
  const ambaTitle = evaluate(AMBA_RULES, title, title);
  const nationalInTitle = anyRule(NATIONAL_SCOPE_RULES, title);
  const nationalAnywhere = nationalInTitle || anyRule(NATIONAL_SCOPE_RULES, description);

  const hints = sectionHints(item);
  const localSection = [...hints].some((h) => LOCAL_SECTIONS.has(h));
  const cabaScore = caba.score + (localSection ? LOCAL_SECTION_BONUS : 0);
  const ambaScore = amba.score + (localSection && amba.score > 0 ? LOCAL_SECTION_BONUS : 0);

  let geo = 'argentina';
  if (cabaScore >= LOCAL_THRESHOLD && ambaScore >= LOCAL_THRESHOLD) {
    geo = cabaScore >= 2 * ambaScore ? 'caba' : 'amba';
  } else if (cabaScore >= LOCAL_THRESHOLD) {
    geo = 'caba';
  } else if (ambaScore >= LOCAL_THRESHOLD) {
    geo = 'amba';
  } else if (caba.score > 0 && amba.score > 0 && caba.score + amba.score >= LOCAL_THRESHOLD) {
    geo = 'amba';
  }

  const affects = [];
  let national = false;
  const titleLocalScore = cabaTitle.score + ambaTitle.score;
  if (geo !== 'argentina' && nationalAnywhere && (nationalInTitle || titleLocalScore < LOCAL_THRESHOLD)) {
    national = true;
    geo = 'argentina';
    if (cabaTitle.score > 0 || explicitImpact(description, CABA_NAME_RULES)) affects.push('CABA');
    if (ambaTitle.score > 0 || explicitImpact(description, AMBA_RULES)) affects.push('AMBA');
  }

  let location = null;
  if (geo === 'caba') location = caba.place || 'CABA';
  else if (geo === 'amba') location = amba.place || caba.place || 'AMBA';

  let localScore = 0;
  if (geo !== 'argentina') localScore = cabaScore + ambaScore;
  else if (affects.length) localScore = LOCAL_THRESHOLD - 1; // relevante, pero menos que una nota local

  return {
    geo,
    location,
    affects,
    localScore,
    signals: {
      caba: caba.signals,
      amba: amba.signals,
      provincia: provincia.signals,
      nacional: nationalAnywhere,
      alcanceNacionalAplicado: national,
      section: localSection,
    },
  };
}

function classifyTopics(item) {
  const title = stripAccents(item.title);
  const rest = stripAccents([item.description, ...(item.categories || [])].join(' . '));
  const hints = sectionHints(item);
  const topics = [];
  for (const [id, rule] of Object.entries(TOPIC_RULES)) {
    let score = 0;
    if (rule.patterns.some((re) => re.test(title))) score += 2;
    else if (rule.patterns.some((re) => re.test(rest))) score += 1;
    if (rule.sections.some((s) => hints.has(s))) score += 2;
    if (score >= 2) topics.push(id);
  }
  return topics;
}

/** Ítem normalizado → ítem clasificado, o null si queda fuera de alcance. */
function classifyItem(item) {
  if (isExcluded(item)) return null;
  const geo = classifyGeo(item);
  let topics = classifyTopics(item);
  // "Ciudad" es gestión y vida urbana: una nota nacional sin impacto local no entra en ese tema.
  if (geo.geo === 'argentina' && !geo.affects.length) topics = topics.filter((t) => t !== 'ciudad');
  return { ...item, ...geo, topics };
}

module.exports = { classifyItem, classifyGeo, classifyTopics, isExcluded, LOCAL_THRESHOLD };
