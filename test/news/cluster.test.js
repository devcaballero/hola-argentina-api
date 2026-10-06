const test = require('node:test');
const assert = require('node:assert/strict');
const { clusterRanked, documentFrequency, isSameEvent } = require('../../lib/news/cluster');
const { queryFeed } = require('../../lib/news/rank');
const { makeItem } = require('./helpers');

const NOW = Date.parse('2026-10-05T18:00:00Z');

/** Ruido para que las frecuencias se parezcan a un snapshot real (cientos de notas variadas). */
function background(n = 120) {
  const words = ['inflacion', 'jubilados', 'tormenta', 'elecciones', 'universidad', 'hospital', 'salarios', 'escuelas', 'vacunas', 'turismo', 'campo', 'exportaciones'];
  return Array.from({ length: n }, (_, i) => makeItem({
    title: `[PRUEBA] ${words[i % words.length]} informe ${words[(i * 7) % words.length]} numero ${i}`,
    geo: 'argentina',
  }));
}

function event(title, overrides = {}) {
  return makeItem({ title, geo: 'caba', localScore: 3, topics: [], location: 'CABA', alsoIn: [], ...overrides });
}

test('agrupa distintos impactos de un mismo evento y los mantiene visibles (principal = la más reciente directa)', () => {
  const cortes = event('Mapa de cortes de calle por la despedida de Messi en el Monumental', { sourceId: 'lanacion', publishedAt: '2026-10-05T23:48:00Z' });
  const cortes2 = event('Cómo serán los cortes de calle para el último partido de Lionel Messi', { sourceId: 'infobae', publishedAt: '2026-10-05T23:57:00Z' });
  const subte = event('Despedida de Messi: la línea D extiende su horario por el partido', { sourceId: 'pagina12', publishedAt: '2026-10-05T21:44:00Z' });
  const otra = event('Reabrió una estación del subte tras las obras', { sourceId: 'clarin' });
  const items = [cortes, cortes2, subte, otra, ...background()];
  const stats = documentFrequency(items);

  const groups = clusterRanked([cortes, cortes2, subte, otra], stats, { geo: 'caba' });
  assert.equal(groups.length, 2);
  // El grupo se forma alrededor de la semilla (cortes), pero la principal es la más reciente directa.
  assert.equal(groups[0].lead, cortes2);
  assert.deepEqual(groups[0].related.map((i) => i.sourceId), ['lanacion', 'pagina12']); // nueva → vieja
  assert.equal(groups[1].lead, otra);
});

test('no agrupa notas que comparten una sola palabra rara', () => {
  const a = event('Paro de subte en la línea A por reclamos salariales');
  const b = event('Nueva estación de subte en Parque Patricios');
  const stats = documentFrequency([a, b, ...background()]);
  assert.equal(isSameEvent(a, b, stats), false);
});

test('líneas distintas no se agrupan aunque compartan anclas', () => {
  const a = event('Paro de subte: medidas de fuerza en la línea A desde el martes');
  const b = event('Paro de subte: medidas de fuerza en la línea B desde el martes');
  const stats = documentFrequency([a, b, ...background()]);
  assert.equal(isSameEvent(a, b, stats), false);
});

test('palabras frecuentes del momento no cuentan como ancla', () => {
  // "dólar" y "precio" aparecen en muchas notas: no identifican un hecho puntual.
  const muchas = Array.from({ length: 30 }, (_, i) => event(`[PRUEBA] Dólar hoy cotización blue número ${i}`, { geo: 'argentina' }));
  const a = event('Dólar blue cotización: qué pasó con el mercado');
  const b = event('Dólar blue cotización en las cuevas del microcentro');
  const stats = documentFrequency([a, b, ...muchas, ...background()]);
  assert.equal(isSameEvent(a, b, stats), false);
});

test('fuera de la ventana de 24 h no se agrupan', () => {
  const a = event('Despedida de Messi: operativo en el Monumental', { publishedAt: '2026-10-01T10:00:00Z' });
  const b = event('Despedida de Messi: cortes por el Monumental', { publishedAt: '2026-10-05T10:00:00Z' });
  const stats = documentFrequency([a, b, ...background()]);
  assert.equal(isSameEvent(a, b, stats), false);
});

test('agrupación en estrella: no encadena A~B~C', () => {
  const a = event('Despedida de Messi con cortes en Núñez');
  const b = event('Cortes en Núñez por obras de AySA en Cabildo');
  const c = event('Obras de AySA en Cabildo afectan el tránsito');
  const stats = documentFrequency([a, b, c, ...background()]);
  const groups = clusterRanked([a, b, c], stats);
  // A se agrupa con B (messi no; cortes+nunez sí), pero C no comparte 2 anclas con A.
  assert.equal(groups[0].lead, a);
  assert.ok(!groups[0].related.includes(c));
});

test('queryFeed: el límite y "Ver más" cuentan grupos; totalNotes, notas', () => {
  const items = [
    event('Mapa de cortes de calle por la despedida de Messi', { publishedAt: '2026-10-05T17:00:00Z', sourceId: 'lanacion' }),
    event('Cortes de calle por la despedida de Messi: el operativo', { publishedAt: '2026-10-05T16:50:00Z', sourceId: 'infobae' }),
    event('Otra nota sin relación con nada', { publishedAt: '2026-10-05T16:00:00Z' }),
    ...background().map((i) => ({ ...i, topics: [], alsoIn: [] })),
  ];
  const r = queryFeed(items, { geo: 'caba', limit: 1 }, NOW);
  assert.equal(r.totalNotes, 3);
  assert.equal(r.total, 2);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].related.length, 1);
  assert.equal(r.items[0].related[0].source.id, 'infobae');
  assert.ok(r.items[0].related[0].url.startsWith('https://'));
});

test('mismo vocabulario policial no alcanza: dos crímenes distintos no se agrupan', () => {
  const a = event('Imputaron al acusado de matar a Aixa en Tigre: se negó a declarar');
  const b = event('Recapturaron al acusado de matar a un policía para robarle la moto en Lanús');
  const stats = documentFrequency([a, b, ...background()]);
  assert.equal(isSameEvent(a, b, stats), false);
});

test('fechas distintas en el título: notas distintas', () => {
  const a = event('Dólar oficial hoy y dólar blue: a cuánto cotizaron este lunes 5 de octubre');
  const b = event('Dólar oficial hoy y dólar blue: a cuánto cotizan este domingo 4 de octubre');
  const stats = documentFrequency([a, b, ...background()]);
  assert.equal(isSameEvent(a, b, stats), false);
});

test('nota principal: una nota reciente pero tangencial (solo "afecta" a CABA) no desplaza a la cobertura directa', () => {
  const seed = event('Cortes de calle en Núñez por la despedida de Messi', { sourceId: 'lanacion', publishedAt: '2026-10-05T20:00:00Z' });
  const direct = event('Cortes de calle y operativo en Núñez por la despedida de Messi', { sourceId: 'infobae', publishedAt: '2026-10-05T21:00:00Z' });
  const tangential = event('Despedida de Messi: cortes de calle y alerta en las provincias', {
    sourceId: 'tn', geo: 'argentina', affects: ['CABA'], publishedAt: '2026-10-05T23:30:00Z',
  });
  const stats = documentFrequency([seed, direct, tangential, ...background()]);
  const [g] = clusterRanked([seed, direct, tangential], stats, { geo: 'caba' });
  assert.equal(g.lead, direct);                 // la más reciente entre las directamente relevantes
  assert.deepEqual(g.related, [tangential, seed]); // relacionadas: nueva → vieja
});

test('desempate determinista con la misma hora: más local, luego medio, luego id', () => {
  const a = event('Cortes de calle en Núñez por la despedida de Messi', { sourceId: 'tn', localScore: 3 });
  const b = event('Cortes de calle en Núñez por la despedida de Messi hoy', { sourceId: 'clarin', localScore: 3 });
  const stats = documentFrequency([a, b, ...background()]);
  const first = clusterRanked([a, b], stats, { geo: 'caba' })[0];
  const second = clusterRanked([b, a], stats, { geo: 'caba' })[0];
  assert.equal(first.lead, b);
  assert.equal(second.lead, b);
});
