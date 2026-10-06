const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeItems, isSimilarTitle } = require('../../lib/news/dedupe');
const { normalizeUrl } = require('../../lib/news/text');
const { makeItem } = require('./helpers');

function classified(overrides) {
  return makeItem({ geo: 'caba', localScore: 3, topics: [], ...overrides });
}

test('normalizeUrl ignora www, query, hash, /amp y barra final', () => {
  const base = normalizeUrl('https://www.clarin.com/ciudades/nota_0_abc.html');
  assert.equal(normalizeUrl('https://clarin.com/ciudades/nota_0_abc.html?utm_source=x#top'), base);
  assert.equal(normalizeUrl('https://www.infobae.com/sociedad/nota/'), normalizeUrl('https://infobae.com/sociedad/nota'));
  assert.equal(normalizeUrl('https://www.tn.com.ar/sociedad/nota/amp/'), normalizeUrl('https://tn.com.ar/sociedad/nota'));
  assert.equal(normalizeUrl('no es una url'), null);
});

test('misma URL en dos feeds → una sola nota con temas combinados', () => {
  const url = 'https://www.clarin.com/prueba/misma';
  const a = classified({ id: normalizeUrl(url), url, topics: ['ciudad'] });
  const b = classified({ id: normalizeUrl(url), url, topics: ['economia'] });
  const out = dedupeItems([a, b]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].topics.sort(), ['ciudad', 'economia']);
  // No muta los ítems de entrada.
  assert.deepEqual(a.topics, ['ciudad']);
});

test('titulares casi idénticos de dos medios → uno, con "también en"', () => {
  const a = classified({ sourceId: 'infobae', sourceName: 'Infobae', title: 'Caputo habló sobre un eventual triunfo de Bolsonaro en Brasil: agrega una afinidad política' });
  const b = classified({ sourceId: 'lanacion', sourceName: 'La Nación', title: 'Luis Caputo habló sobre una eventual victoria de Bolsonaro en Brasil: agrega una afinidad política', localScore: 2 });
  const out = dedupeItems([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sourceId, 'infobae');
  assert.deepEqual(out[0].alsoIn.map((x) => x.sourceId), ['lanacion']);
});

test('no agrupa notas distintas con titulares parecidos', () => {
  // Distinta línea de subte.
  assert.equal(isSimilarTitle(
    classified({ title: 'Paro de subte: anunciaron medidas de fuerza en la línea A para el martes' }),
    classified({ title: 'Paro de subte: anunciaron medidas de fuerza en la línea B para el martes' })
  ), false);
  // Distinta fecha/cifra.
  assert.equal(isSimilarTitle(
    classified({ title: 'Cortes de tránsito en Palermo por la maratón del domingo 11 de octubre' }),
    classified({ title: 'Cortes de tránsito en Palermo por la maratón del domingo 18 de octubre' })
  ), false);
  // Titulares cortos: nunca se agrupan por similitud.
  assert.equal(isSimilarTitle(classified({ title: 'Paro de subte' }), classified({ title: 'Paro de subte' })), false);
  // Misma frase, pero con días de diferencia: notas distintas.
  assert.equal(isSimilarTitle(
    classified({ title: 'Cómo funcionan hoy los subtes, trenes y colectivos en la Ciudad', publishedAt: '2026-10-01T10:00:00Z' }),
    classified({ title: 'Cómo funcionan hoy los subtes, trenes y colectivos en la Ciudad', publishedAt: '2026-10-05T10:00:00Z' })
  ), false);
});

test('misma historia contada distinto no se agrupa (conservador)', () => {
  const out = dedupeItems([
    classified({ sourceId: 'lanacion', title: 'La despedida de Messi: la línea D extiende su horario por el partido del martes' }),
    classified({ sourceId: 'pagina12', title: 'Último partido de Leo Messi: la línea D extiende su horario' }),
  ]);
  assert.equal(out.length, 2);
});
