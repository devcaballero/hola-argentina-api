const test = require('node:test');
const assert = require('node:assert/strict');
const { baTodayIso, baDateOfInstant, addDaysIso, dailyWindow } = require('../../lib/dates');
const H = require('../../lib/historial');

/** Instante a partir de una hora de pared de Buenos Aires (UTC−3, sin horario de verano). */
const ba = (local) => Date.parse(`${local}:00-03:00`);
const fmt = (n, d = 2) => n.toFixed(d);

/** Serie UVA de PRUEBA con la forma real del BCRA: fechas civiles, incluye vigencia futura hasta el 15/10. */
function uvaSeries(from = '2026-09-25', to = '2026-10-15') {
  const out = [];
  for (let f = from, v = 2130; f <= to; f = addDaysIso(f, 1), v += 1.2) out.push({ fecha: f, valorNum: Number(v.toFixed(2)) });
  return out;
}

test('hoy en Buenos Aires: 5/10 23:50 sigue siendo 5/10; 6/10 00:10 ya es 6/10', () => {
  assert.equal(baTodayIso(ba('2026-10-05T23:50')), '2026-10-05');
  assert.equal(baTodayIso(ba('2026-10-06T00:10')), '2026-10-06');
  // El error original: el día UTC a las 23:50 de BA ya es el 6.
  assert.equal(new Date(ba('2026-10-05T23:50')).toISOString().slice(0, 10), '2026-10-06');
});

test('independiente de la zona horaria del servidor (process.env.TZ)', () => {
  // Se ejecuta también con TZ=Asia/Tokyo y TZ=America/Los_Angeles (ver AUDITORIA). Aquí se comprueba
  // que el resultado no depende de getDate()/getHours() locales.
  for (const m of ['getDate', 'getHours', 'getTimezoneOffset', 'getDay']) {
    const orig = Date.prototype[m];
    Date.prototype[m] = () => { throw new Error(`no usar ${m}`); };
    try {
      assert.equal(baTodayIso(ba('2026-10-05T23:50')), '2026-10-05');
      assert.equal(baDateOfInstant(Date.parse('2026-10-06T03:10:00Z')), '2026-10-06');
    } finally {
      Date.prototype[m] = orig;
    }
  }
});

test('aritmética de fechas civiles: cambios de mes, año y bisiesto', () => {
  assert.equal(addDaysIso('2026-10-01', -6), '2026-09-25');
  assert.equal(addDaysIso('2027-01-02', -6), '2026-12-27');
  assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
  assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
});

test('UVA a las 23:50 del 5/10: historial 29/9…5/10, sin el 6/10 ni posteriores; valor principal del 5/10', () => {
  const series = uvaSeries();
  const today = baTodayIso(ba('2026-10-05T23:50'));
  const r = H.buildBcraDailyIndex(series, { today, days: 7, decimals: 2, format: fmt });
  assert.deepEqual(r.historial.map((d) => d.fecha), [
    '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  ]);
  assert.equal(r.latest.fecha, '2026-10-05');
  assert.equal(r.futureCount, 10); // 6/10 … 15/10 publicados, no mostrados
  // La variación del primer día usa el registro anterior a la ventana (28/9).
  assert.notEqual(r.historial[0].deltaPct, null);
});

test('UVA a las 00:10 del 6/10: el registro del 6/10 entra con su fecha real (no se reasigna)', () => {
  const series = uvaSeries();
  const today = baTodayIso(ba('2026-10-06T00:10'));
  const r = H.buildBcraDailyIndex(series, { today, days: 7, decimals: 2, format: fmt });
  assert.equal(r.latest.fecha, '2026-10-06');
  assert.equal(r.historial.at(-1).fecha, '2026-10-06');
  assert.equal(r.historial[0].fecha, '2026-09-30');
  const original = series.find((s) => s.fecha === '2026-10-06');
  assert.equal(r.historial.at(-1).valor, fmt(original.valorNum));
});

test('días sin registros: no se inventan ni repiten; la variación usa el anterior disponible', () => {
  const series = [
    { fecha: '2026-09-25', valorNum: 100 },
    { fecha: '2026-09-30', valorNum: 110 },
    { fecha: '2026-10-03', valorNum: 121 },
  ];
  const r = H.buildBcraDailyIndex(series, { today: '2026-10-05', days: 7, decimals: 2, format: fmt });
  assert.deepEqual(r.historial.map((d) => d.fecha), ['2026-09-30', '2026-10-03']);
  assert.equal(r.historial[0].deltaPct, 10); // vs 25/9, fuera de la ventana
  assert.equal(r.latest.fecha, '2026-10-03'); // hoy sin registro → vigente = último <= hoy
  assert.equal(r.deltaPct, 10);
});

test('ventana que cruza año: hoy 2/1/2027 → 27/12/2026 … 2/1/2027', () => {
  const series = uvaSeries('2026-12-20', '2027-01-10');
  const r = H.buildBcraDailyIndex(series, { today: '2027-01-02', days: 7, decimals: 2, format: fmt });
  assert.equal(r.historial[0].fecha, '2026-12-27');
  assert.equal(r.historial.at(-1).fecha, '2027-01-02');
  assert.equal(r.historial.length, 7);
});

test('solo datos futuros: no hay valor vigente ni historial', () => {
  const r = H.buildBcraDailyIndex(uvaSeries('2026-10-06', '2026-10-15'), { today: '2026-10-05', format: fmt });
  assert.equal(r.latest, null);
  assert.deepEqual(r.historial, []);
});

test('dailyWindow descarta fechas mal formadas (p. ej. timestamps) en lugar de desplazarlas', () => {
  const w = dailyWindow([{ fecha: '2026-10-05T23:00:00Z', valorNum: 1 }, { fecha: '2026-10-05', valorNum: 2 }], '2026-10-05', 7);
  assert.deepEqual(w.rows.map((r) => r.valorNum), [2]);
});

test('dólar: variación del valor vigente (<= hoy), nunca de un registro futuro', () => {
  const series = [
    { fecha: '2026-10-02', compra: 1480, venta: 1500 },
    { fecha: '2026-10-05', compra: 1490, venta: 1540 },
    { fecha: '2026-10-06', compra: 1500, venta: 1600 },
  ];
  const r = H.buildDolarHistorial(series, '2026-10-05', 7);
  assert.deepEqual(r.historial.map((d) => d.fecha), ['2026-10-02', '2026-10-05']);
  assert.equal(r.variacion.absoluta, 40);
});

test('riesgo país en domingo: sin filas de fin de semana; vigente = viernes', () => {
  const series = [
    { fecha: '2026-09-30', valorNum: 650 },
    { fecha: '2026-10-01', valorNum: 652 },
    { fecha: '2026-10-02', valorNum: 655 },
  ];
  const r = H.buildRiesgoPais(series, '2026-10-04', { days: 7, format: String });
  assert.equal(r.latest.fecha, '2026-10-02');
  assert.equal(r.historial.length, 3);
  assert.equal(r.deltaPb, 3);
});

test('Bitcoin/oro: instantes se agrupan por día de Buenos Aires (02:50 UTC del 6/10 = 5/10 en BA)', () => {
  const series = H.seriesFromInstants([
    { ts: Date.parse('2026-10-05T00:00:00Z'), precio: 85000 }, // 4/10 21:00 BA
    { ts: Date.parse('2026-10-05T18:00:00Z'), precio: 85500 }, // 5/10 15:00 BA
    { ts: Date.parse('2026-10-06T02:50:00Z'), precio: 85900 }, // 5/10 23:50 BA (actual)
  ]);
  assert.deepEqual(series, [
    { fecha: '2026-10-04', precio: 85000 },
    { fecha: '2026-10-05', precio: 85900 },
  ]);
  const p = H.buildPricePayload(series, '2026-10-05');
  assert.equal(p.fecha, '2026-10-05');
  assert.equal(p.precio, 85900);
});

test('velas diarias UTC: se asignan al día BA de su cierre; la vela en curso del 6/10 UTC es futura a las 23:50 BA', () => {
  const day = (openIso) => baDateOfInstant(H.candleCloseInstant(Date.parse(openIso)));
  assert.equal(day('2026-10-05T00:00:00Z'), '2026-10-05'); // cierra 5/10 20:59:59 BA
  assert.equal(day('2026-10-06T00:00:00Z'), '2026-10-06');
  const series = [
    { fecha: day('2026-10-04T00:00:00Z'), precio: 1 },
    { fecha: day('2026-10-05T00:00:00Z'), precio: 2 },
    { fecha: day('2026-10-06T00:00:00Z'), precio: 3 },
  ];
  const p = H.buildPricePayload(series, baTodayIso(ba('2026-10-05T23:50')));
  assert.equal(p.fecha, '2026-10-05');
  assert.deepEqual(p.historial.map((d) => d.fecha), ['2026-10-04', '2026-10-05']);
});

// --- Variación con referencia explícita (it. 13) -----------------------------------------------

test('dólar: la variación compara la cotización vigente con el registro ANTERIOR a su fecha', () => {
  // ArgentinaDatos ya publicó una fila "de hoy" (6/10) antes de operar; la cotización vigente es del 5/10.
  const series = [
    { fecha: '2026-10-02', compra: 1495, venta: 1545 },
    { fecha: '2026-10-03', compra: 1490, venta: 1540 },
    { fecha: '2026-10-04', compra: 1490, venta: 1540 },
    { fecha: '2026-10-05', compra: 1490, venta: 1540 },
    { fecha: '2026-10-06', compra: 1490, venta: 1540 },
  ];
  const r = H.buildDolarHistorial(series, '2026-10-06', 7, { fecha: '2026-10-05', venta: 1545 });
  assert.equal(r.variacion.referencia, '2026-10-04');
  assert.equal(r.variacion.porcentaje, 0.32);
  // Un 0 real solo con dos datos de fechas distintas e iguales.
  const z = H.buildDolarHistorial(series, '2026-10-06', 7, { fecha: '2026-10-05', venta: 1540 });
  assert.equal(z.variacion.porcentaje, 0);
  assert.equal(z.variacion.referencia, '2026-10-04');
});

test('variación no disponible: sin fecha del dato o sin registro anterior', () => {
  assert.equal(H.variationAgainstPrevious([{ fecha: '2026-10-05', v: 1 }], { fecha: null, valor: 1 }, (r) => r.v), null);
  assert.equal(H.variationAgainstPrevious([{ fecha: '2026-10-05', v: 1 }], { fecha: '2026-10-05', valor: 1 }, (r) => r.v), null);
  assert.equal(H.variationAgainstPrevious([], { fecha: '2026-10-05', valor: 1 }, (r) => r.v), null);
  const r = H.buildDolarHistorial([{ fecha: '2026-10-05', compra: 1, venta: 1540 }], '2026-10-05', 7, { fecha: '2026-10-05', venta: 1540 });
  assert.equal(r.variacion, null);
});

test('UVA/BTC: la variación informa la fecha de referencia y conserva el número original', () => {
  const series = [{ fecha: '2026-10-04', valorNum: 2140.88 }, { fecha: '2026-10-05', valorNum: 2142.08 }];
  const u = H.buildBcraDailyIndex(series, { today: '2026-10-05', format: (n) => String(n) });
  assert.equal(u.variacion.referencia, '2026-10-04');
  assert.equal(u.historial.at(-1).valorNum, 2142.08);
  const p = H.buildPricePayload([{ fecha: '2026-10-05', precio: 85632.58 }, { fecha: '2026-10-06', precio: 85459.49 }], '2026-10-06');
  assert.equal(p.variacion.referencia, '2026-10-05');
  assert.equal(p.variacion.porcentaje, -0.2);
});
