/**
 * Precio de la hamburguesa Big Mac en Argentina.
 *
 * Fuente: dataset abierto de The Economist (Big Mac index), CC BY 4.0.
 *   https://github.com/TheEconomist/big-mac-data — archivo output-data/big-mac-raw-index.csv
 *   Columna `local_price`: "Price of a Big Mac in the local currency" (fuente: McDonald's; The Economist).
 *   Un relevamiento por semestre (enero y julio). No es por sucursal ni por canal.
 *
 * Qué NO se hace:
 * - No se calcula ni se resta ningún impuesto: se muestra `local_price` tal como se publica.
 * - No se usan dollar_price / adj_price ni columnas de índice (eso sería el "índice", no el precio).
 * - No se scrapea bigmacindex.com: sus términos prohíben scrapear fuera de su API (y es precio de delivery).
 * - Si la consulta falla se sirve el último dato válido marcado `stale`, sin mover `checkedAt`.
 */

const SOURCE = {
  name: 'The Economist · Big Mac index (datos abiertos)',
  url: 'https://github.com/TheEconomist/big-mac-data',
  csvUrl:
    'https://raw.githubusercontent.com/TheEconomist/big-mac-data/master/output-data/big-mac-raw-index.csv',
  license: 'CC BY 4.0',
};

const TTL_MS = 12 * 60 * 60 * 1000; // el dato cambia dos veces por año
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

/** CSV simple de The Economist (sin comillas con comas). Columnas por nombre, no por posición. */
function parseEconomistCsv(csv, { country = 'ARG', now = Date.now() } = {}) {
  const lines = String(csv || '').trim().split(/\r?\n/);
  const header = (lines.shift() || '').split(',').map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const iDate = col('date');
  const iIso = col('iso_a3');
  const iCurrency = col('currency_code');
  const iPrice = col('local_price');
  if ([iDate, iIso, iCurrency, iPrice].some((i) => i < 0)) {
    throw new Error('CSV de The Economist sin las columnas esperadas (date, iso_a3, currency_code, local_price)');
  }

  let best = null;
  for (const line of lines) {
    const cells = line.split(',');
    if (cells[iIso] !== country) continue;
    const date = cells[iDate];
    const price = Number(cells[iPrice]);
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(ms) || ms > now) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (cells[iCurrency] !== 'ARS' && country === 'ARG') continue;
    if (!best || date > best.priceDate) {
      best = { price, currency: cells[iCurrency], priceDate: date };
    }
  }
  if (!best) throw new Error(`CSV de The Economist sin precio válido para ${country}`);
  return best;
}

/**
 * @param {{ fetchText: (url: string) => Promise<string>, now?: () => number, logger?: Console }} deps
 */
function createBigMacService({ fetchText, now = () => Date.now(), logger = console }) {
  let lastGood = null; // { price, currency, priceDate, checkedAt }
  let lastAttemptAt = 0;
  let lastError = null;
  let inflight = null;

  async function refresh() {
    lastAttemptAt = now();
    try {
      const csv = await fetchText(SOURCE.csvUrl);
      const parsed = parseEconomistCsv(csv, { now: now() });
      lastGood = { ...parsed, checkedAt: now() };
      lastError = null;
    } catch (error) {
      lastError = error;
      logger.error('[bigmac] consulta fallida:', error?.code || '', error?.message || error);
    }
  }

  async function get() {
    const t = now();
    const fresh = lastGood && t - lastGood.checkedAt < TTL_MS;
    const recentFailure = lastError && t - lastAttemptAt < RETRY_AFTER_FAILURE_MS;
    if (!fresh && !recentFailure) {
      if (!inflight) inflight = refresh().finally(() => { inflight = null; });
      await inflight;
    }
    if (!lastGood) {
      return { available: false, product: 'Big Mac', source: SOURCE, error: 'Precio no disponible' };
    }
    const stale = Boolean(lastError) || now() - lastGood.checkedAt >= TTL_MS;
    return {
      available: true,
      product: 'Big Mac',
      price: lastGood.price,
      currency: lastGood.currency,
      priceDate: lastGood.priceDate,
      checkedAt: new Date(lastGood.checkedAt).toISOString(),
      stale,
      channel: 'Relevamiento semestral de The Economist (precio local informado por McDonald\'s); no corresponde a una sucursal ni canal específico',
      source: SOURCE,
    };
  }

  return { get };
}

module.exports = { parseEconomistCsv, createBigMacService, SOURCE };
