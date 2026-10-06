/**
 * Históricos diarios ("Últimos 7 días") y valor vigente, comunes a UVA/CER, dólar, oro,
 * Bitcoin y riesgo país. Funciones puras: reciben `today` (YYYY-MM-DD en Buenos Aires).
 *
 * Reglas:
 * - Ventana = hoy−6 … hoy (inclusive), por calendario de Buenos Aires.
 * - Registros con vigencia posterior a hoy se excluyen del historial y del valor principal
 *   (conservan su fecha real; nunca se reasignan a hoy).
 * - Días sin registro quedan sin fila: no se inventan ni repiten valores.
 * - La variación compara con el registro anterior disponible (puede estar fuera de la ventana).
 */
const { dailyWindow, baDateOfInstant } = require('./dates');

const DAY_MS = 24 * 60 * 60 * 1000;

function pctChange(from, to) {
  if (from == null || to == null || Number(from) === 0) return null;
  return ((Number(to) - Number(from)) / Number(from)) * 100;
}

const round = (n, d) => (n == null ? null : Number(n.toFixed(d)));
const direction = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

/**
 * Variación de un dato contra el registro inmediatamente ANTERIOR a su fecha (no "cierre anterior":
 * solo se afirma qué fecha se usa como referencia). null si falta la fecha, el valor o la referencia:
 * así un 0 solo aparece cuando hay dos datos de fechas distintas que efectivamente no cambiaron.
 *
 * @param {{ fecha: string }[]} series ordenada por fecha
 * @param {{ fecha: string|null, valor: number }} dato
 * @param {(row: object) => number} valueOf
 */
function variationAgainstPrevious(series, dato, valueOf) {
  if (!dato || !dato.fecha || !Number.isFinite(dato.valor)) return null;
  let ref = null;
  for (const row of series) if (row.fecha < dato.fecha) ref = row;
  const refValue = ref ? valueOf(ref) : NaN;
  if (!ref || !Number.isFinite(refValue) || refValue === 0) return null;
  const porcentaje = round(pctChange(refValue, dato.valor), 2);
  return {
    porcentaje,
    absoluta: Number((dato.valor - refValue).toFixed(2)),
    direccion: direction(porcentaje),
    referencia: ref.fecha,
  };
}

/** Registro inmediatamente anterior a `row` en la serie (ordenada). */
function previousOf(series, row) {
  const i = series.indexOf(row);
  return i > 0 ? series[i - 1] : null;
}

/** UVA / CER (BCRA): serie [{ fecha, valorNum }] con fechas civiles de vigencia. */
function buildBcraDailyIndex(series, { today, days = 7, decimals = 2, format }) {
  const { rows, before, latest, future } = dailyWindow(series, today, days);
  const historial = rows.map((row, i) => {
    const prev = i === 0 ? before : rows[i - 1];
    const deltaPct = prev && Number.isFinite(prev.valorNum) && prev.valorNum !== 0
      ? round(pctChange(prev.valorNum, row.valorNum), 2)
      : null;
    return { fecha: row.fecha, valor: format(row.valorNum, decimals), valorNum: row.valorNum, deltaPct };
  });
  const variacion = latest
    ? variationAgainstPrevious(series, { fecha: latest.fecha, valor: latest.valorNum }, (r) => r.valorNum)
    : null;
  return { latest, deltaPct: variacion ? variacion.porcentaje : null, variacion, historial, futureCount: future.length };
}

/**
 * Dólar: historial de ArgentinaDatos (fechas civiles) + variación de la cotización vigente.
 * `live` = { fecha (día BA de fechaActualizacion de dolarapi), venta }. Sin `live`, la variación se
 * calcula entre los dos últimos registros vigentes de la serie.
 */
function buildDolarHistorial(series, today, days = 7, live = null) {
  const { rows, before, latest } = dailyWindow(series, today, days);
  const historial = rows.map((day, i) => {
    const prev = i === 0 ? before : rows[i - 1];
    return {
      fecha: day.fecha,
      compra: day.compra,
      venta: day.venta,
      variacionPct: round(pctChange(prev?.venta, day.venta), 2),
    };
  });
  const dato = live
    ? { fecha: live.fecha, valor: live.venta }
    : latest ? { fecha: latest.fecha, valor: latest.venta } : null;
  return {
    historial,
    variacion: variationAgainstPrevious(series.filter((r) => r.fecha <= today), dato, (r) => r.venta),
  };
}

/** Oro / Bitcoin: serie [{ fecha, precio }] (fecha = día civil de Buenos Aires). */
function buildPricePayload(series, today, days = 7) {
  const { rows, before, latest } = dailyWindow(series, today, days);
  if (!latest) return null;
  const historial = rows.map((day, i) => {
    const prev = i === 0 ? before : rows[i - 1];
    return {
      fecha: day.fecha,
      precio: Number(day.precio.toFixed(2)),
      variacionPct: round(pctChange(prev?.precio, day.precio), 2),
    };
  });
  const precio = Number(latest.precio.toFixed(2));
  return {
    precio,
    precioLabel: precio.toFixed(2).replace('.', ','),
    fecha: latest.fecha,
    variacion: variationAgainstPrevious(series, { fecha: latest.fecha, valor: latest.precio }, (r) => r.precio),
    historial,
  };
}

/** Riesgo país (ArgentinaDatos, días hábiles): serie [{ fecha, valorNum }]. */
function buildRiesgoPais(series, today, { days = 7, format }) {
  const { rows, before, latest } = dailyWindow(series, today, days);
  const historial = rows.map((row, i) => {
    const prev = i === 0 ? before : rows[i - 1];
    return {
      fecha: row.fecha,
      valor: format(row.valorNum),
      valorNum: row.valorNum,
      deltaPb: prev && Number.isFinite(prev.valorNum) ? round(row.valorNum - prev.valorNum, 1) : null,
    };
  });
  const prev = latest ? previousOf(series, latest) : null;
  return {
    latest,
    deltaPb: latest && prev ? round(latest.valorNum - prev.valorNum, 1) : null,
    referencia: prev ? prev.fecha : null,
    historial,
  };
}

/**
 * Instantes → días de Buenos Aires: para cada día se queda el último precio observado.
 * Para puntos sueltos (CoinGecko) o el spot actual. `points`: [{ ts (ms), precio }].
 */
function seriesFromInstants(points) {
  const byDay = new Map();
  for (const { ts, precio } of [...points].sort((a, b) => a.ts - b.ts)) {
    const fecha = baDateOfInstant(ts);
    if (fecha && Number.isFinite(precio)) byDay.set(fecha, precio);
  }
  return [...byDay.entries()].map(([fecha, precio]) => ({ fecha, precio })).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/**
 * Vela diaria (apertura en `openMs`, duración `intervalMs`): su cierre es un instante; el día que
 * representa es el día de Buenos Aires de ese cierre. Velas de 00:00 UTC cierran 21:00 BA del mismo día.
 */
function candleCloseInstant(openMs, intervalMs = DAY_MS) {
  return openMs + intervalMs - 1;
}

module.exports = {
  pctChange,
  variationAgainstPrevious,
  buildBcraDailyIndex,
  buildDolarHistorial,
  buildPricePayload,
  buildRiesgoPais,
  seriesFromInstants,
  candleCloseInstant,
};
