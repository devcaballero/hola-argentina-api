const test = require('node:test');
const assert = require('node:assert/strict');
const { queryFeed, parseFilters, rankItems } = require('../../lib/news/rank');
const { makeItem } = require('./helpers');

const NOW = Date.parse('2026-10-05T18:00:00Z');

function item(overrides) {
  return makeItem({ geo: 'caba', localScore: 3, topics: [], location: 'CABA', alsoIn: [], ...overrides });
}

test('parseFilters: valores por defecto y saneo de entrada', () => {
  assert.deepEqual(parseFilters({}), { geo: 'caba', tema: 'todas', medio: 'todos', limit: 8 });
  assert.deepEqual(
    parseFilters({ geo: 'marte', tema: '<script>', medio: '../../etc', limit: '9999' }),
    { geo: 'caba', tema: 'todas', medio: 'todos', limit: 40 }
  );
});

test('geo anidado: CABA ⊂ AMBA ⊂ Argentina, sin relleno', () => {
  const items = [
    item({ geo: 'caba' }),
    item({ geo: 'amba' }),
    item({ geo: 'argentina' }),
    item({ geo: 'argentina' }),
  ];
  assert.equal(queryFeed(items, { geo: 'caba' }, NOW).total, 1);
  assert.equal(queryFeed(items, { geo: 'amba' }, NOW).total, 2);
  assert.equal(queryFeed(items, { geo: 'argentina' }, NOW).total, 4);
  // Sin notas CABA: el filtro CABA devuelve vacío, no notas nacionales.
  const empty = queryFeed(items.filter((i) => i.geo !== 'caba'), { geo: 'caba' }, NOW);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
});

test('filtros combinados con AND y facetas calculadas con los otros filtros', () => {
  const items = [
    item({ sourceId: 'clarin', topics: ['transporte'] }),
    item({ sourceId: 'infobae', topics: ['transporte', 'ciudad'] }),
    item({ sourceId: 'infobae', topics: ['economia'] }),
    item({ sourceId: 'tn', geo: 'argentina', topics: ['transporte'] }),
  ];
  const r = queryFeed(items, { geo: 'caba', tema: 'transporte', medio: 'infobae' }, NOW);
  assert.equal(r.total, 1);
  assert.equal(r.facets.tema.transporte, 1); // geo=caba + medio=infobae
  assert.equal(r.facets.tema.economia, 1);
  assert.equal(r.facets.tema.agenda, 0);
  assert.equal(r.facets.medio.clarin, 1); // geo=caba + tema=transporte
  assert.equal(r.facets.medio.tn, undefined);
  assert.equal(r.facets.geo.argentina, 1); // tema=transporte + medio=infobae
});

test('ranking: más reciente y más local primero', () => {
  const vieja = item({ title: 'vieja', publishedAt: '2026-10-04T18:00:00Z' });
  const nueva = item({ title: 'nueva', publishedAt: '2026-10-05T17:30:00Z', sourceId: 'tn' });
  const out = rankItems([vieja, nueva], NOW);
  assert.deepEqual(out.map((i) => i.title), ['nueva', 'vieja']);
});

test('diversidad: un medio con muchas notas no monopoliza la primera página', () => {
  const muchas = Array.from({ length: 10 }, (_, i) => item({
    sourceId: 'infobae',
    publishedAt: new Date(NOW - i * 5 * 60 * 1000).toISOString(),
  }));
  const otras = [
    item({ sourceId: 'clarin', publishedAt: new Date(NOW - 3 * 3600 * 1000).toISOString() }),
    item({ sourceId: 'pagina12', publishedAt: new Date(NOW - 4 * 3600 * 1000).toISOString() }),
  ];
  const top = queryFeed([...muchas, ...otras], { limit: 6 }, NOW).items;
  const medios = top.map((i) => i.source.id);
  assert.ok(medios.includes('clarin'));
  assert.ok(medios.includes('pagina12'));
  // Si solo hay un medio, sus notas igual aparecen.
  assert.equal(queryFeed(muchas, { limit: 6 }, NOW).items.length, 6);
});

test('vista pública: no expone descripción cruda ni señales internas', () => {
  const [pub] = queryFeed([item({ description: 'texto completo', signals: { caba: ['x'] } })], {}, NOW).items;
  assert.equal(pub.description, undefined);
  assert.equal(pub.signals, undefined);
  assert.deepEqual(Object.keys(pub).sort(), ['affects', 'alsoIn', 'geo', 'id', 'location', 'publishedAt', 'related', 'source', 'summary', 'title', 'topics', 'url']);
});

// --- Conteos por eventos, temas superpuestos y "Otros" (it. 13) -------------------------------

test('conteos por EVENTOS: temas superpuestos, Otros sin resta y Todas', () => {
  const items = [
    item({ title: 'Nota uno con transporte y economía juntas', topics: ['transporte', 'economia'] }),
    item({ title: 'Nota dos solo de transporte urbano', topics: ['transporte'] }),
    item({ title: 'Nota tres sin ningún tema asignado', topics: [] }),
    item({ title: 'Nota cuatro también sin tema', topics: [] }),
  ];
  const r = queryFeed(items, { geo: 'caba' }, NOW);
  assert.equal(r.unidad, 'eventos');
  assert.equal(r.facets.tema.todas, 4);
  assert.equal(r.facets.tema.transporte, 2);
  assert.equal(r.facets.tema.economia, 1);
  assert.equal(r.facets.tema.otros, 2);
  // Se superponen: la suma de temas (2+1+2) supera a Todas (4); Otros no es Todas − suma.
  assert.ok(r.facets.tema.transporte + r.facets.tema.economia + r.facets.tema.otros > r.facets.tema.todas);
  // La nota con dos temas aparece en cada uno, una sola vez por resultado.
  const t = queryFeed(items, { geo: 'caba', tema: 'transporte', limit: 40 }, NOW);
  assert.equal(new Set(t.items.map((i) => i.id)).size, t.items.length);
  assert.equal(queryFeed(items, { geo: 'caba', tema: 'otros' }, NOW).total, 2);
});

test('los conteos corresponden a eventos agrupados, no a notas', () => {
  const at = (h) => `2026-10-05T${h}:00:00Z`;
  const bg = Array.from({ length: 120 }, (_, i) => item({ geo: 'argentina', title: `[PRUEBA] relleno ${i} informe ${['a', 'b', 'c'][i % 3]} numero ${i}`, publishedAt: at('10') }));
  const items = [
    item({ title: 'Cortes de calle por la despedida de Messi en el Monumental', sourceId: 'lanacion', topics: ['transporte'], publishedAt: at('17') }),
    item({ title: 'Cómo serán los cortes de calle por la despedida de Messi', sourceId: 'infobae', topics: ['transporte'], publishedAt: at('16') }),
    item({ title: 'Otra noticia distinta de la ciudad', topics: ['ciudad'], publishedAt: at('15') }),
    ...bg,
  ];
  const r = queryFeed(items, { geo: 'caba' }, NOW);
  assert.equal(r.total, 2);            // 2 eventos
  assert.equal(r.totalNotes, 3);       // 3 notas detrás
  assert.equal(r.facets.tema.todas, 2);
  assert.equal(r.facets.tema.transporte, 1);
  assert.equal(r.facets.geo.caba, 2);
});

test('una nota nacional que afecta a CABA aparece en CABA y AMBA, presentada como nacional', () => {
  const items = [
    item({ geo: 'argentina', affects: ['CABA'], localScore: 2, title: 'Paro nacional: cómo funcionan los subtes en CABA' }),
    item({ geo: 'argentina', affects: [], title: 'Alerta en las provincias del norte' }),
  ];
  const caba = queryFeed(items, { geo: 'caba' }, NOW);
  assert.equal(caba.total, 1);
  assert.equal(caba.items[0].geo, 'argentina');
  assert.deepEqual(caba.items[0].affects, ['CABA']);
  assert.equal(queryFeed(items, { geo: 'amba' }, NOW).total, 1);
  assert.equal(queryFeed(items, { geo: 'argentina' }, NOW).total, 2);
});
