const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEconomistCsv, createBigMacService } = require('../../lib/bigmac');

const HEADER = 'date,iso_a3,currency_code,name,local_price,dollar_ex,dollar_price,USD,EUR,GBP,JPY,CNY';
/** Filas de PRUEBA con la forma real del CSV de The Economist. */
const CSV = [
  HEADER,
  '2026-01-01,ARG,ARS,Argentina,8000,1445.755,5.53,-0.09,-0.2,-0.21,0.82,0.51',
  '2026-07-01,ARG,ARS,Argentina,8700,1472.98,5.90,-0.05,-0.16,-0.20,0.91,0.50',
  '2026-07-01,BRA,BRL,Brazil,23.9,5.4,4.42,0,0,0,0,0',
  '2025-07-01,ARG,ARS,Argentina,6600,1286.0,5.13,-0.14,-0.25,-0.24,0.59,0.44',
].join('\n');
const NOW = Date.parse('2026-10-05T12:00:00Z');
const silent = { error() {}, log() {} };

test('toma local_price (precio en pesos de la Big Mac), no dollar_price ni columnas de índice', () => {
  const r = parseEconomistCsv(CSV, { now: NOW });
  assert.equal(r.price, 8700);
  assert.equal(r.currency, 'ARS');
});

test('solo Argentina y el relevamiento más reciente aunque no sea la última fila', () => {
  const r = parseEconomistCsv(CSV, { now: NOW });
  assert.equal(r.priceDate, '2026-07-01');
});

test('columnas por nombre: si cambian de orden, sigue tomando la correcta', () => {
  const reordered = ['local_price,date,currency_code,iso_a3', '8700,2026-07-01,ARS,ARG', '23.9,2026-07-01,BRL,BRA'].join('\n');
  assert.deepEqual(parseEconomistCsv(reordered, { now: NOW }), { price: 8700, currency: 'ARS', priceDate: '2026-07-01' });
});

test('precio final publicado tal cual: no resta ni suma impuestos', () => {
  // 9100 con IVA 21 % → 7520,66 sin impuestos nacionales. El parser no debe derivar ninguno de los dos.
  const csv = [HEADER, '2026-07-01,ARG,ARS,Argentina,9100,1,1,0,0,0,0,0'].join('\n');
  assert.equal(parseEconomistCsv(csv, { now: NOW }).price, 9100);
});

test('rechaza CSV sin columnas esperadas, sin fila ARG, con precios inválidos o fechas futuras', () => {
  assert.throws(() => parseEconomistCsv('a,b,c\n1,2,3', { now: NOW }), /columnas/);
  assert.throws(() => parseEconomistCsv([HEADER, '2026-07-01,BRA,BRL,Brazil,23.9,1,1,0,0,0,0,0'].join('\n'), { now: NOW }), /sin precio/);
  assert.throws(() => parseEconomistCsv([HEADER, '2026-07-01,ARG,ARS,Argentina,NaN,1,1,0,0,0,0,0'].join('\n'), { now: NOW }), /sin precio/);
  assert.throws(() => parseEconomistCsv([HEADER, '2027-01-01,ARG,ARS,Argentina,9999,1,1,0,0,0,0,0'].join('\n'), { now: NOW }), /sin precio/);
  assert.throws(() => parseEconomistCsv([HEADER, '2026-07-01,ARG,USD,Argentina,5.9,1,1,0,0,0,0,0'].join('\n'), { now: NOW }), /sin precio/);
});

function service({ fail = false } = {}) {
  let t = NOW;
  let calls = 0;
  const state = { fail };
  const svc = createBigMacService({
    fetchText: async () => { calls += 1; if (state.fail) throw new Error('boom'); return CSV; },
    now: () => t,
    logger: silent,
  });
  return { svc, state, advance: (ms) => { t += ms; }, calls: () => calls };
}

test('dato verificado: incluye fecha del dato y última verificación por separado, sin stale', async () => {
  const { svc } = service();
  const r = await svc.get();
  assert.equal(r.available, true);
  assert.equal(r.price, 8700);
  assert.equal(r.priceDate, '2026-07-01');
  assert.equal(r.checkedAt, new Date(NOW).toISOString());
  assert.equal(r.stale, false);
  assert.ok(r.source.url.startsWith('https://github.com/TheEconomist/'));
});

test('caché de 12 h: no consulta la fuente en cada visita', async () => {
  const ctx = service();
  await ctx.svc.get();
  ctx.advance(60 * 60 * 1000);
  await ctx.svc.get();
  assert.equal(ctx.calls(), 1);
});

test('fallo con dato previo: sirve el último conocido marcado stale y NO actualiza checkedAt', async () => {
  const ctx = service();
  const first = await ctx.svc.get();
  ctx.state.fail = true;
  ctx.advance(13 * 60 * 60 * 1000);
  const r = await ctx.svc.get();
  assert.equal(r.available, true);
  assert.equal(r.stale, true);
  assert.equal(r.checkedAt, first.checkedAt);
  assert.equal(r.price, 8700);
});

test('sin ningún dato verificable: "Precio no disponible", sin valor ni fecha inventados', async () => {
  const { svc } = service({ fail: true });
  const r = await svc.get();
  assert.equal(r.available, false);
  assert.equal(r.price, undefined);
  assert.equal(r.checkedAt, undefined);
  assert.equal(r.priceDate, undefined);
  assert.equal(r.error, 'Precio no disponible');
});
