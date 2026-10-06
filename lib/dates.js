/**
 * Fechas para históricos diarios.
 *
 * Dos tipos de dato, que no se mezclan:
 * - Fecha civil "YYYY-MM-DD" (BCRA, ArgentinaDatos): un día de vigencia. Se compara como texto y
 *   se opera con aritmética de calendario; nunca se convierte a instante ni se desplaza por zona.
 * - Instante (timestamp): se lleva al día civil de Buenos Aires con Intl antes de agrupar.
 *
 * "Hoy" es siempre el día civil en America/Argentina/Buenos_Aires, sin importar la zona del
 * servidor (nunca `toISOString().slice(0, 10)`, que da el día UTC: después de las 21 h de BA ya es mañana).
 */

const AR_TZ = 'America/Argentina/Buenos_Aires';
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: AR_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Día civil (YYYY-MM-DD) en Buenos Aires de un instante. */
function baDateOfInstant(instant) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant);
  if (!Number.isFinite(ms)) return null;
  return dayFmt.format(new Date(ms));
}

/** Hoy en Buenos Aires (YYYY-MM-DD). */
function baTodayIso(now = Date.now()) {
  return baDateOfInstant(now);
}

/** Suma días a una fecha civil (aritmética de calendario; cruza meses y años). */
function addDaysIso(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  // Date.UTC solo como calendario: entrada y salida son fechas civiles, sin zona.
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isCivilDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

/**
 * Ventana diaria "últimos N días" según el calendario de Buenos Aires.
 *
 * @param {{ fecha: string }[]} series ordenada por fecha ascendente (fechas civiles)
 * @param {string} today YYYY-MM-DD (hoy en BA)
 * @param {number} days tamaño de la ventana (7 → hoy−6 … hoy, inclusive)
 * @returns {{ rows: object[], before: object|null, latest: object|null, future: object[] }}
 *   - rows: registros con fecha en la ventana (no se inventan días faltantes)
 *   - before: último registro anterior a la ventana (para la variación del primer día)
 *   - latest: último registro con fecha <= hoy (valor vigente; nunca uno futuro)
 *   - future: registros con vigencia posterior a hoy (conservan su fecha real; no se muestran)
 */
function dailyWindow(series, today, days = 7) {
  const start = addDaysIso(today, -(days - 1));
  const rows = [];
  const future = [];
  let before = null;
  let latest = null;
  for (const row of series) {
    if (!isCivilDate(row.fecha)) continue;
    if (row.fecha > today) {
      future.push(row);
      continue;
    }
    latest = row;
    if (row.fecha < start) before = row;
    else rows.push(row);
  }
  return { rows, before, latest, future };
}

module.exports = { AR_TZ, baTodayIso, baDateOfInstant, addDaysIso, dailyWindow, isCivilDate };
