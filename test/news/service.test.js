const test = require('node:test');
const assert = require('node:assert/strict');
const { createNewsService, NoNewsDataError } = require('../../lib/news/service');
const { rss } = require('./helpers');

const MIN = 60 * 1000;
const silent = { log() {}, error() {} };

const SOURCES = [
  { id: 'clarin', name: 'Clarín', domains: ['clarin.com'], allowSummary: false, feeds: [{ url: 'https://feeds.test/clarin', section: 'ciudades' }] },
  { id: 'infobae', name: 'Infobae', domains: ['infobae.com'], allowSummary: false, feeds: [
    { url: 'https://feeds.test/infobae-a', section: 'sociedad' },
    { url: 'https://feeds.test/infobae-b', section: 'economia' },
  ] },
];

function feedFor(url, now) {
  const date = new Date(now - 30 * MIN).toUTCString();
  const domain = url.includes('clarin') ? 'www.clarin.com' : 'www.infobae.com';
  return rss([
    { title: `[PRUEBA] Paro de subte en la línea A (${url.slice(-1)})`, link: `https://${domain}/sociedad/prueba-${url.slice(-8)}`, pubDate: date },
  ]);
}

/** Reloj y red controlables. `fail` = set de URLs que fallan. */
function setup({ fail = new Set(), hang = new Set() } = {}) {
  let t = Date.parse('2026-10-05T18:00:00Z');
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (hang.has(url)) return new Promise(() => {});
    if (fail.has(url)) throw Object.assign(new Error('boom'), { response: { status: 502 } });
    return feedFor(url, t);
  };
  const service = createNewsService({
    sources: SOURCES,
    fetchText,
    now: () => t,
    logger: silent,
    sourceTimeoutMs: 50,
  });
  return { service, calls, fail, hang, advance: (ms) => { t += ms; } };
}

test('una sola consulta a los medios para muchas visitas simultáneas', async () => {
  const { service, calls } = setup();
  await Promise.all(Array.from({ length: 20 }, () => service.query({ geo: 'caba' })));
  assert.equal(calls.length, 3);
});

test('dentro del TTL responde desde caché; vencido, refresca en segundo plano', async () => {
  const ctx = setup();
  await ctx.service.query({});
  ctx.advance(5 * MIN);
  await ctx.service.query({});
  assert.equal(ctx.calls.length, 3);

  ctx.advance(10 * MIN);
  const r = await ctx.service.query({});
  assert.equal(r.stale, false); // respondió con lo que había, sin esperar
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.length, 6);
});

test('fallo parcial: un feed caído marca la fuente como parcial y no rompe las demás', async () => {
  const ctx = setup({ fail: new Set(['https://feeds.test/infobae-b']) });
  const r = await ctx.service.query({ geo: 'argentina' });
  const infobae = r.sources.find((s) => s.id === 'infobae');
  assert.equal(infobae.status, 'partial');
  assert.equal(infobae.error, 'HTTP 502');
  assert.equal(r.sources.find((s) => s.id === 'clarin').status, 'ok');
  const all = r.items.flatMap((i) => [i, ...i.related]);
  assert.ok(all.some((i) => i.source.id === 'infobae'));
});

test('fuente caída conserva sus últimas notas (stale) hasta 6 h', async () => {
  const ctx = setup();
  await ctx.service.refresh();
  ctx.fail.add('https://feeds.test/clarin');
  ctx.advance(13 * MIN);
  const snap = await ctx.service.refresh();
  const clarin = snap.sources.find((s) => s.id === 'clarin');
  assert.equal(clarin.status, 'stale');
  assert.ok(snap.items.some((i) => i.sourceId === 'clarin'));

  ctx.advance(6 * 60 * MIN);
  const later = await ctx.service.refresh();
  assert.equal(later.sources.find((s) => s.id === 'clarin').status, 'error');
  assert.ok(!later.items.some((i) => i.sourceId === 'clarin'));
});

test('timeout de una fuente no bloquea a las demás', async () => {
  const ctx = setup({ hang: new Set(['https://feeds.test/clarin']) });
  const r = await ctx.service.query({ geo: 'argentina' });
  assert.equal(r.sources.find((s) => s.id === 'clarin').error, 'timeout');
  assert.ok(r.items.length > 0);
});

test('fallo total con datos previos: conserva el último resultado y avisa desactualizado', async () => {
  const ctx = setup();
  const first = await ctx.service.query({ geo: 'argentina' });
  for (const url of ['https://feeds.test/clarin', 'https://feeds.test/infobae-a', 'https://feeds.test/infobae-b']) ctx.fail.add(url);
  ctx.advance(40 * MIN);
  await ctx.service.refresh();
  const r = await ctx.service.query({ geo: 'argentina' });
  assert.equal(r.total, first.total);
  assert.equal(r.stale, true);
  assert.equal(r.updatedAt, first.updatedAt);
  assert.notEqual(r.checkedAt, first.checkedAt);
});

test('fallo total sin datos previos: error explícito y backoff (no reintenta por cada visita)', async () => {
  const ctx = setup({ fail: new Set(['https://feeds.test/clarin', 'https://feeds.test/infobae-a', 'https://feeds.test/infobae-b']) });
  await assert.rejects(ctx.service.query({}), NoNewsDataError);
  const callsAfterFirst = ctx.calls.length;
  await assert.rejects(ctx.service.query({}), NoNewsDataError);
  assert.equal(ctx.calls.length, callsAfterFirst);
  ctx.advance(2 * MIN);
  await assert.rejects(ctx.service.query({}), NoNewsDataError);
  assert.ok(ctx.calls.length > callsAfterFirst);
});
