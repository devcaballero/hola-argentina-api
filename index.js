const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const dns = require('dns');
const https = require('https');
const {
  withFallbacks,
  collectFromSources,
  AllSourcesFailedError,
} = require('./lib/fallbacks');

// En Render, resolver IPv6 primero suele colgar APIs externas (Open-Meteo).
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Node < 16.13
}

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

const browserHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
};

const http = axios.create({
  timeout: 20000,
  headers: browserHeaders,
  validateStatus: (status) => status >= 200 && status < 400,
});

const jsonHeaders = {
  'User-Agent': 'hola-argentina-api/1.1 (+https://github.com/devcaballero/hola-argentina-api)',
  Accept: 'application/json',
};

const ipv4HttpsAgent = new https.Agent({
  keepAlive: true,
  minVersion: 'TLSv1.2',
  // Render a veces falla IPv6 hacia APIs externas; forzar IPv4.
  family: 4,
});

const defaultHttpsAgent = new https.Agent({
  keepAlive: true,
  minVersion: 'TLSv1.2',
});

/** Client JSON (Open-Meteo, etc.). Evita Accept: text/html que a veces rompe en hosting. */
const jsonHttp = axios.create({
  timeout: 25000,
  headers: jsonHeaders,
  httpsAgent: ipv4HttpsAgent,
  validateStatus: (status) => status >= 200 && status < 400,
});

/** Misma config sin forzar family: por si el Agent family:4 falla en algún runtime. */
const jsonHttpAuto = axios.create({
  timeout: 25000,
  headers: jsonHeaders,
  httpsAgent: defaultHttpsAgent,
  validateStatus: (status) => status >= 200 && status < 400,
});

/**
 * BCRA publica la API con cadena de certificados incompleta.
 * En Render eso dispara UNABLE_TO_GET_ISSUER_CERT_LOCALLY / "unable to get local issuer certificate".
 */
const bcraHttp = axios.create({
  timeout: 25000,
  headers: {
    'User-Agent': 'hola-argentina-api/1.1 (+https://github.com/devcaballero/hola-argentina-api)',
    Accept: 'application/json',
  },
  httpsAgent: new https.Agent({
    keepAlive: true,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: false,
  }),
  validateStatus: (status) => status >= 200 && status < 400,
});

function sendError(res, error, fallback = 'Error en el servidor') {
  console.error(
    '[api-error]',
    error?.code || '',
    error?.message || error,
    error?.response?.status || ''
  );
  if (!res.headersSent) {
    res.status(500).send(fallback);
  }
}

function formatArs(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n.toFixed(2);
}

// Fallback si el catálogo no responde. Si INDEC cambia la base del IPC, este ID puede invalidarse.
const IPC_NACIONAL_FALLBACK_ID = '148.3_INIVELNAL_DICI_M_26';
const DATOS_GOB_SERIES = 'https://apis.datos.gob.ar/series/api';

function formatIpcPercent(ratio) {
  const n = Number(ratio);
  if (Number.isNaN(n) || n === null) return null;
  // La API devuelve proporción (0.019 = 1,9%)
  return (n * 100).toFixed(1).replace('.', ',');
}

/** fecha IPC suele ser YYYY-MM-DD → "Julio 2026" */
function formatIpcPeriodo(fecha) {
  if (!fecha) return null;
  const iso = String(fecha).slice(0, 10);
  const [year, month] = iso.split('-').map(Number);
  if (!year || !month) return null;
  const meses = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  return `${meses[month - 1]} ${year}`;
}

async function resolveIpcNacionalSeriesId() {
  try {
    const { data } = await http.get(`${DATOS_GOB_SERIES}/search/`, {
      params: {
        q: 'IPC Nivel General Nacional',
        limit: 30,
      },
    });

    const match = (data?.data || []).find((item) => {
      const id = item?.field?.id || '';
      const description = `${item?.field?.description || ''} ${item?.dataset?.title || ''}`.toLowerCase();
      return (
        id === IPC_NACIONAL_FALLBACK_ID ||
        (description.includes('nivel general') &&
          description.includes('nacional') &&
          description.includes('diciembre 2016') &&
          item?.field?.frequency === 'R/P1M')
      );
    });

    return match?.field?.id || IPC_NACIONAL_FALLBACK_ID;
  } catch (error) {
    console.error('No se pudo resolver el ID de IPC en el catálogo, uso fallback:', error.message);
    return IPC_NACIONAL_FALLBACK_ID;
  }
}

async function getLatestIpcObservation(representationMode) {
  const series = await getIpcSeries(representationMode, 1);
  const latest = series.historial[series.historial.length - 1];
  if (!latest) {
    throw new Error(`Sin observaciones IPC para ${representationMode}`);
  }
  return {
    fecha: latest.fecha,
    valor: latest.valorRatio,
    seriesId: series.seriesId,
  };
}

const ipcSeriesCache = new Map();
const IPC_SERIES_TTL_MS = 6 * 60 * 60 * 1000;

async function getIpcSeries(representationMode, months = 6) {
  const cacheKey = `${representationMode}:${months}`;
  const cached = ipcSeriesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < IPC_SERIES_TTL_MS) {
    return cached.payload;
  }

  const seriesId = await resolveIpcNacionalSeriesId();
  // percent_change_a_year_ago exige mucho lookback; si start_date es reciente, la API
  // puede devolver data: [] aunque existan observaciones.
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);

  const { data } = await http.get(`${DATOS_GOB_SERIES}/series/`, {
    params: {
      ids: `${seriesId}:${representationMode}`,
      format: 'json',
      start_date: startDate.toISOString().slice(0, 10),
      limit: 36,
    },
  });

  const rows = (data?.data || [])
    .filter((row) => {
      const valor = row?.[1];
      return valor !== null && valor !== undefined && !Number.isNaN(Number(valor));
    })
    .map((row) => {
      const fecha = String(row[0]).slice(0, 10);
      const valorRatio = Number(row[1]);
      return {
        fecha,
        valorRatio,
        valor: formatIpcPercent(valorRatio),
        periodo: formatIpcPeriodo(fecha),
      };
    });

  const historial = rows.slice(-months).map((row, index, arr) => {
    const prev = index === 0
      ? rows[rows.length - months - 1]
      : arr[index - 1];
    const deltaPp =
      prev && Number.isFinite(prev.valorRatio)
        ? Number(((row.valorRatio - prev.valorRatio) * 100).toFixed(1))
        : null;
    return {
      fecha: row.fecha,
      periodo: row.periodo,
      valor: row.valor,
      valorRatio: row.valorRatio,
      deltaPp,
    };
  });

  const payload = { seriesId, historial };
  ipcSeriesCache.set(cacheKey, { at: Date.now(), payload });
  return payload;
}

async function getDolarCotizacion(tipo) {
  const { data } = await http.get(`https://dolarapi.com/v1/dolares/${tipo}`);
  const compra = formatArs(data?.compra);
  const venta = formatArs(data?.venta);
  if (!compra || !venta) {
    throw new Error(`Cotización ${tipo} inválida`);
  }
  return {
    compra: compra.replace('.', ','),
    venta: venta.replace('.', ','),
  };
}

/** Serie diaria de ArgentinaDatos (cache 1h). */
const dolarHistorialCache = new Map();
const DOLAR_HISTORIAL_TTL_MS = 60 * 60 * 1000;

async function getDolarHistorialSeries(tipo) {
  const cached = dolarHistorialCache.get(tipo);
  if (cached && Date.now() - cached.at < DOLAR_HISTORIAL_TTL_MS) {
    return cached.series;
  }

  const { data } = await http.get(
    `https://api.argentinadatos.com/v1/cotizaciones/dolares/${tipo}`
  );
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`Historial vacío para ${tipo}`);
  }

  const series = data
    .filter((row) => row && row.fecha && row.venta != null && !Number.isNaN(Number(row.venta)))
    .map((row) => ({
      fecha: String(row.fecha).slice(0, 10),
      compra: row.compra == null ? null : Number(row.compra),
      venta: Number(row.venta),
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  dolarHistorialCache.set(tipo, { at: Date.now(), series });
  return series;
}

function pctChange(from, to) {
  if (from == null || to == null || Number(from) === 0) return null;
  return ((Number(to) - Number(from)) / Number(from)) * 100;
}

function isoMinusDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

function buildDolarHistorial(series, days = 7) {
  if (!series.length) {
    return { historial: [], variacion: null };
  }

  const end = series[series.length - 1].fecha;
  const start = isoMinusDays(end, days - 1);
  const windowDays = series.filter((day) => day.fecha >= start && day.fecha <= end);

  const beforeIndex = series.findIndex((day) => day.fecha === windowDays[0]?.fecha) - 1;
  const before = beforeIndex >= 0 ? series[beforeIndex] : null;

  const historial = windowDays.map((day, index) => {
    const prev = index === 0 ? before : windowDays[index - 1];
    const variacionPct = pctChange(prev?.venta, day.venta);
    return {
      fecha: day.fecha,
      compra: day.compra,
      venta: day.venta,
      variacionPct: variacionPct == null ? null : Number(variacionPct.toFixed(2)),
    };
  });

  const hoy = historial[historial.length - 1] || null;
  const ayer = historial.length >= 2 ? historial[historial.length - 2] : null;
  const variacionPct = hoy ? hoy.variacionPct : null;

  return {
    historial,
    variacion:
      variacionPct == null || !hoy
        ? null
        : {
            porcentaje: variacionPct,
            absoluta: ayer ? Number((hoy.venta - ayer.venta).toFixed(2)) : null,
            direccion: variacionPct > 0 ? 'up' : variacionPct < 0 ? 'down' : 'flat',
          },
  };
}

async function getDolarPayload(tipo) {
  const [cotizacion, series] = await Promise.all([
    getDolarCotizacion(tipo),
    getDolarHistorialSeries(tipo).catch((error) => {
      console.error(`Historial ${tipo} no disponible:`, error.message);
      return [];
    }),
  ]);

  const { historial, variacion } = buildDolarHistorial(series, 7);
  return {
    ...cotizacion,
    variacion,
    historial,
  };
}

app.get('/api/v1/dolar-oficial', async (_req, res) => {
  try {
    const payload = await getDolarPayload('oficial');
    console.log(
      `Dólar Oficial C/V: $${payload.compra} / $${payload.venta}` +
        (payload.variacion ? ` (${payload.variacion.porcentaje}%)` : '')
    );
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/dolar-blue', async (_req, res) => {
  try {
    const payload = await getDolarPayload('blue');
    console.log(
      `Dólar Blue C/V: $${payload.compra} / $${payload.venta}` +
        (payload.variacion ? ` (${payload.variacion.porcentaje}%)` : '')
    );
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

const oroCache = { at: 0, payload: null };
const ORO_TTL_MS = 30 * 60 * 1000;

async function getOroPayload() {
  if (oroCache.payload && Date.now() - oroCache.at < ORO_TTL_MS) {
    return oroCache.payload;
  }

  const toIso = new Date().toISOString().slice(0, 10);
  const fromIso = isoMinusDays(toIso, 10);

  const [{ data: spotData }, { data: barsData }] = await Promise.all([
    http.get('https://api.goldprice.dev/v1/prices', {
      params: { symbol: 'XAU-USD-SPOT' },
    }),
    http.get('https://api.goldprice.dev/v1/bars', {
      params: {
        symbol: 'XAU-USD-SPOT',
        interval: '1d',
        from: fromIso,
        to: toIso,
      },
    }),
  ]);

  const byFecha = new Map();
  for (const bar of barsData?.bars || []) {
    const close = Number(bar?.close);
    const start = bar?.bar_start;
    if (!start || !Number.isFinite(close)) continue;
    const fecha = String(start).slice(0, 10);
    byFecha.set(fecha, close);
  }

  const live = Number(spotData?.symbols?.[0]?.price);
  if (Number.isFinite(live)) {
    byFecha.set(toIso, live);
  }

  const series = [...byFecha.entries()]
    .map(([fecha, precio]) => ({ fecha, precio }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  if (!series.length) {
    throw new Error('Historial de oro vacío');
  }

  const end = series[series.length - 1].fecha;
  const start = isoMinusDays(end, 6);
  const windowDays = series.filter((day) => day.fecha >= start && day.fecha <= end);
  const beforeIndex = series.findIndex((day) => day.fecha === windowDays[0]?.fecha) - 1;
  const before = beforeIndex >= 0 ? series[beforeIndex] : null;

  const historial = windowDays.map((day, index) => {
    const prev = index === 0 ? before : windowDays[index - 1];
    const variacionPct = pctChange(prev?.precio, day.precio);
    return {
      fecha: day.fecha,
      precio: Number(day.precio.toFixed(2)),
      variacionPct: variacionPct == null ? null : Number(variacionPct.toFixed(2)),
    };
  });

  const hoy = historial[historial.length - 1];
  const ayer = historial.length >= 2 ? historial[historial.length - 2] : null;
  const variacionPct = hoy?.variacionPct ?? null;

  const payload = {
    precio: hoy.precio,
    precioLabel: hoy.precio.toFixed(2).replace('.', ','),
    variacion:
      variacionPct == null
        ? null
        : {
            porcentaje: variacionPct,
            absoluta: ayer ? Number((hoy.precio - ayer.precio).toFixed(2)) : null,
            direccion: variacionPct > 0 ? 'up' : variacionPct < 0 ? 'down' : 'flat',
          },
    historial,
  };

  oroCache.at = Date.now();
  oroCache.payload = payload;
  return payload;
}

app.get('/api/v1/oro', async (_req, res) => {
  try {
    const payload = await getOroPayload();
    console.log(
      `Oro: U$S ${payload.precioLabel}` +
        (payload.variacion ? ` (${payload.variacion.porcentaje}%)` : '')
    );
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

const bitcoinCache = { at: 0, payload: null };
const BITCOIN_TTL_MS = 15 * 60 * 1000;

async function getBitcoinPayload() {
  if (bitcoinCache.payload && Date.now() - bitcoinCache.at < BITCOIN_TTL_MS) {
    return bitcoinCache.payload;
  }

  // En Render CoinGecko/Binance suelen fallar (rate-limit / red). Varias fuentes + clientes.
  const { value, source } = await withFallbacks(
    [
      { name: 'coingecko', fetch: () => fetchBitcoinCoinGecko(jsonHttpAuto) },
      { name: 'coingecko-ipv4', fetch: () => fetchBitcoinCoinGecko(jsonHttp) },
      {
        name: 'binance-vision',
        fetch: () =>
          fetchBitcoinBinance(jsonHttpAuto, 'https://data-api.binance.vision'),
      },
      {
        name: 'binance',
        fetch: () => fetchBitcoinBinance(jsonHttpAuto, 'https://api.binance.com'),
      },
      {
        name: 'binance-ipv4',
        fetch: () => fetchBitcoinBinance(jsonHttp, 'https://api.binance.com'),
      },
      { name: 'coinbase', fetch: () => fetchBitcoinCoinbase(jsonHttpAuto) },
      { name: 'kraken', fetch: () => fetchBitcoinKraken(jsonHttpAuto) },
    ],
    {
      label: 'bitcoin',
      isValid: (p) =>
        p != null &&
        p.precio != null &&
        Array.isArray(p.historial) &&
        p.historial.length > 0,
    }
  );

  console.log(`[bitcoin] fuente: ${source}`);
  bitcoinCache.at = Date.now();
  bitcoinCache.payload = value;
  return value;
}

async function fetchBitcoinCoinGecko(client) {
  const { data } = await client.get(
    'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart',
    {
      params: {
        vs_currency: 'usd',
        days: 7,
      },
    }
  );

  const byFecha = new Map();
  for (const row of data?.prices || []) {
    const [ts, price] = row;
    if (ts == null || price == null || Number.isNaN(Number(price))) continue;
    const fecha = new Date(Number(ts)).toISOString().slice(0, 10);
    byFecha.set(fecha, Number(price));
  }

  const series = [...byFecha.entries()]
    .map(([fecha, precio]) => ({ fecha, precio }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  return buildBitcoinPayloadFromSeries(series);
}

async function fetchBitcoinBinance(client, baseUrl) {
  const root = String(baseUrl || 'https://api.binance.com').replace(/\/$/, '');
  const { data: klines } = await client.get(`${root}/api/v3/klines`, {
    params: {
      symbol: 'BTCUSDT',
      interval: '1d',
      limit: 10,
    },
  });

  if (!Array.isArray(klines) || !klines.length) {
    throw new Error('Binance sin klines de BTC');
  }

  const series = klines
    .map((row) => {
      const openTime = Number(row?.[0]);
      const close = Number(row?.[4]);
      if (!Number.isFinite(openTime) || !Number.isFinite(close)) return null;
      return {
        fecha: new Date(openTime).toISOString().slice(0, 10),
        precio: close,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  return buildBitcoinPayloadFromSeries(series);
}

/** Coinbase Exchange daily candles → serie close. */
async function fetchBitcoinCoinbase(client) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 10 * 86400;
  const { data } = await client.get(
    'https://api.exchange.coinbase.com/products/BTC-USD/candles',
    {
      params: {
        granularity: 86400,
        start: new Date(start * 1000).toISOString(),
        end: new Date(end * 1000).toISOString(),
      },
    }
  );

  if (!Array.isArray(data) || !data.length) {
    throw new Error('Coinbase sin candles de BTC');
  }

  // [time, low, high, open, close, volume] — time en segundos
  const series = data
    .map((row) => {
      const ts = Number(row?.[0]);
      const close = Number(row?.[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(close)) return null;
      return {
        fecha: new Date(ts * 1000).toISOString().slice(0, 10),
        precio: close,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  return buildBitcoinPayloadFromSeries(series);
}

/** Kraken daily OHLC → serie close. */
async function fetchBitcoinKraken(client) {
  const { data } = await client.get('https://api.kraken.com/0/public/OHLC', {
    params: {
      pair: 'XBTUSD',
      interval: 1440,
    },
  });

  if (data?.error?.length) {
    throw new Error(`Kraken: ${data.error.join(', ')}`);
  }

  const rows =
    data?.result?.XXBTZUSD ||
    data?.result?.XBTUSD ||
    Object.values(data?.result || {}).find((v) => Array.isArray(v));

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Kraken sin OHLC de BTC');
  }

  // [time, open, high, low, close, vwap, volume, count]
  const series = rows
    .slice(-10)
    .map((row) => {
      const ts = Number(row?.[0]);
      const close = Number(row?.[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(close)) return null;
      return {
        fecha: new Date(ts * 1000).toISOString().slice(0, 10),
        precio: close,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  return buildBitcoinPayloadFromSeries(series);
}

function buildBitcoinPayloadFromSeries(series) {
  if (!Array.isArray(series) || !series.length) {
    throw new Error('Historial de Bitcoin vacío');
  }

  const end = series[series.length - 1].fecha;
  const start = isoMinusDays(end, 6);
  const windowDays = series.filter((day) => day.fecha >= start && day.fecha <= end);
  const beforeIndex = series.findIndex((day) => day.fecha === windowDays[0]?.fecha) - 1;
  const before = beforeIndex >= 0 ? series[beforeIndex] : null;

  const historial = windowDays.map((day, index) => {
    const prev = index === 0 ? before : windowDays[index - 1];
    const variacionPct = pctChange(prev?.precio, day.precio);
    return {
      fecha: day.fecha,
      precio: Number(day.precio.toFixed(2)),
      variacionPct: variacionPct == null ? null : Number(variacionPct.toFixed(2)),
    };
  });

  if (!historial.length) {
    throw new Error('Ventana de Bitcoin vacía');
  }

  const hoy = historial[historial.length - 1];
  const ayer = historial.length >= 2 ? historial[historial.length - 2] : null;
  const variacionPct = hoy?.variacionPct ?? null;

  return {
    precio: hoy.precio,
    precioLabel: hoy.precio.toFixed(2).replace('.', ','),
    variacion:
      variacionPct == null
        ? null
        : {
            porcentaje: variacionPct,
            absoluta: ayer ? Number((hoy.precio - ayer.precio).toFixed(2)) : null,
            direccion: variacionPct > 0 ? 'up' : variacionPct < 0 ? 'down' : 'flat',
          },
    historial,
  };
}

app.get('/api/v1/bitcoin', async (_req, res) => {
  try {
    const payload = await getBitcoinPayload();
    console.log(
      `Bitcoin: U$S ${payload.precioLabel}` +
        (payload.variacion ? ` (${payload.variacion.porcentaje}%)` : '')
    );
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/nafta-super', async (_req, res) => {
  try {
    const url = 'https://surtidores.com.ar/precios/';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const fuelType = 'Super';

    let fuelRow = null;
    $('table tr').each((_, row) => {
      if ($(row).text().includes(fuelType)) {
        fuelRow = $(row);
        return false;
      }
    });

    if (!fuelRow) {
      return res.status(404).send('Información no encontrada');
    }

    const priceCells = fuelRow.find('td');
    const priceIndex = new Date().getMonth() + 1;
    if (priceIndex < 1 || priceIndex >= priceCells.length) {
      return res.status(404).send('Información no encontrada');
    }

    const price = priceCells.eq(priceIndex).text().trim();
    if (!price) {
      return res.status(404).send('Precio no disponible');
    }

    console.log(`El precio de la nafta 'Super' es : ${price}`);
    res.status(200).send(price.replace('.', ','));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/bigmac', async (_req, res) => {
  try {
    const { value: precio, source } = await withFallbacks(
      [
        { name: 'bigmacindex', fetch: fetchBigMacFromIndex },
        { name: 'economist-csv', fetch: fetchBigMacFromEconomist },
      ],
      {
        label: 'bigmac',
        isValid: (v) => typeof v === 'string' && v.length > 0 && v !== 'NaN',
      }
    );
    console.log(`El precio del bigmac (${source}) es : ${precio}`);
    res.status(200).send(precio);
  } catch (error) {
    if (error instanceof AllSourcesFailedError) {
      return res.status(404).send('Precio del bigmac no encontrado');
    }
    sendError(res, error);
  }
});

/** Precio local en ARS desde bigmacindex (actualización frecuente). */
async function fetchBigMacFromIndex() {
  const { data: html } = await http.get('https://bigmacindex.com/country/argentina');
  const match = String(html).match(/ARS\s*([\d.,]+)/i);
  const precio = match?.[1]?.replace(/[^\d]/g, '');
  if (!precio) throw new Error('bigmacindex sin precio ARS');
  return precio;
}

/** Fallback: Big Mac Index de The Economist (CSV semi-anual). */
async function fetchBigMacFromEconomist() {
  const { data: csv } = await http.get(
    'https://raw.githubusercontent.com/TheEconomist/big-mac-data/master/output-data/big-mac-raw-index.csv'
  );
  const rows = String(csv)
    .trim()
    .split('\n')
    .filter((line) => line.includes(',ARG,') || line.includes(',Argentina,'));
  const latest = rows[rows.length - 1];
  if (!latest) throw new Error('CSV Economist sin fila ARG');
  // date,iso_a3,currency_code,name,local_price,...
  const localPrice = latest.split(',')[4];
  const precio = String(Math.round(Number(localPrice)));
  if (!precio || precio === 'NaN') throw new Error('CSV Economist sin local_price válido');
  return precio;
}

app.get('/api/v1/heineken', async (_req, res) => {
  try {
    const url =
      'https://diaonline.supermercadosdia.com.ar/cerveza-heineken-envase-retornable-1-lt-61144/p';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const precioElement = $('span.vtex-product-price-1-x-currencyInteger');

    if (!precioElement.length) {
      return res.status(404).send('Precio de la heineken no encontrado');
    }

    const precio = precioElement.first().text().trim();
    console.log(`Precio de la Heineken de Litro: ${precio}`);
    res.status(200).send(precio);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/cocacola', async (_req, res) => {
  try {
    const url =
      'https://diaonline.supermercadosdia.com.ar/gaseosa-coca-cola-sabor-original-15-lts-16861/p';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const precioElement = $('span.vtex-product-price-1-x-currencyInteger');

    if (!precioElement.length) {
      return res.status(404).send('Precio de la cocacola no encontrado');
    }

    const precio = precioElement.first().text().trim();
    console.log(`Precio de la Coca-Cola de 1,5L: ${precio}`);
    res.status(200).send(precio);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/forros-prime', async (_req, res) => {
  try {
    const url = 'https://www.farmalife.com.ar/prime-preserv-ultra-fino-x-3-/p';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const precioElement = $('strong.skuBestPrice');

    if (!precioElement.length) {
      return res.status(404).send('Precio del primex3 no encontrado');
    }

    const precio = precioElement.text().trim().replace('$', '').trim();
    console.log(`Precio del preservativos prime x3 unidades: ${precio}`);
    res.status(200).send(precio);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/minimo-sube', async (_req, res) => {
  try {
    // Tarifa mínima oficial AMBA (0-3 km, SUBE registrada)
    const url =
      'https://www.argentina.gob.ar/transporte/conoce-las-tarifas-vigentes-en-colectivos-y-trenes-del-amba';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    let tarifa = '';

    $('table').each((_, table) => {
      if (tarifa) return false;
      $(table)
        .find('tr')
        .each((__, row) => {
          const cells = $(row).find('td');
          if (cells.length < 2) return;
          const distancia = $(cells[0]).text().replace(/\s+/g, ' ').trim().toLowerCase();
          if (distancia.includes('0') && distancia.includes('3') && distancia.includes('km')) {
            const raw = $(cells[1]).text().replace(/\s+/g, ' ').trim();
            const match = raw.match(/([\d.]+,\d{2})/);
            if (match) {
              tarifa = match[1];
              return false;
            }
          }
        });
    });

    if (!tarifa) {
      const text = $.text().replace(/\s+/g, ' ');
      const match = text.match(/0\s*[-–]\s*3\s*km[^$]*\$\s*([\d.]+,\d{2})/i);
      if (match) {
        tarifa = match[1];
      }
    }

    if (!tarifa) {
      return res.status(404).send('Tarifa minimia sube no encontrada');
    }

    console.log(`Tarifa mínima de tarjeta sube: ${tarifa}`);
    res.status(200).send(tarifa);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/inflacion-anualizada', async (_req, res) => {
  try {
    // IPC Nacional INDEC — variación interanual (percent_change_a_year_ago)
    const { fecha, valor, seriesId } = await getLatestIpcObservation(
      'percent_change_a_year_ago'
    );
    const inflation = formatIpcPercent(valor);
    if (!inflation) {
      return res.status(404).send('Inflación anualizada no encontrada');
    }
    const periodo = formatIpcPeriodo(fecha);
    console.log(`IPC interanual INDEC (${seriesId}, ${fecha}): %${inflation}`);
    res.status(200).json({ valor: inflation, periodo, fecha });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/phillipbox', async (_req, res) => {
  try {
    const url = 'https://www.tarducciytordini.com.ar/nv/public/precios-de-cigarrillos';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const philipMorrisBox20Element = $('td:contains("PHILIP MORRIS BOX 20")').first();
    const priceElement = philipMorrisBox20Element.next();

    if (!priceElement.length) {
      return res.status(404).send('Precio del phillipbox no encontrado');
    }

    const precio = priceElement.text().trim().replace('$', '').trim();
    console.log(`Precio de PHILIP MORRIS BOX 20: ${precio}`);
    res.status(200).send(precio);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/fernet', async (_req, res) => {
  try {
    const url =
      'https://www.cotodigital3.com.ar/sitios/cdigi/producto/-fernet-branca---botella-750-cc/_/A-00005525-00005525-200';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const precioText = $('span.atg_store_newPrice').text().trim();
    const precioMatches = precioText.match(/\d{1,3}(?:\.\d{3})*(?:,\d{2})?/);

    if (!precioMatches) {
      return res.status(404).send('Precio no encontrado');
    }

    const precio = precioMatches[0].replace(/\./g, '');
    console.log(`Precio del Fernet x 750ml: ${precio}`);
    res.status(200).send(precio);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/inflacion-mensual', async (_req, res) => {
  try {
    // IPC Nacional INDEC — variación mensual (percent_change), últimos 6 meses
    const { seriesId, historial } = await getIpcSeries('percent_change', 6);
    const latest = historial[historial.length - 1];
    if (!latest?.valor) {
      return res.status(404).send('Inflación mensual no encontrada');
    }

    const deltaPp = latest.deltaPp;
    const payload = {
      valor: latest.valor,
      periodo: latest.periodo,
      fecha: latest.fecha,
      variacion:
        deltaPp == null
          ? null
          : {
              porcentaje: deltaPp,
              unidad: 'pp',
              direccion: deltaPp > 0 ? 'up' : deltaPp < 0 ? 'down' : 'flat',
            },
      historial: historial.map(({ fecha, periodo, valor, deltaPp: d }) => ({
        fecha,
        periodo,
        valor,
        deltaPp: d,
      })),
    };

    console.log(`IPC mensual INDEC (${seriesId}, ${latest.fecha}): %${latest.valor}`);
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/tasa-bcra', async (_req, res) => {
  try {
    // Preferimos BADLAR (viva). TPM (160) suele estar desactualizada y su serie a veces viene vacía.
    const candidates = [
      { idVariable: 7, codigo: 'BADLAR', nombre: 'BADLAR', meta: 'Referencia BCRA · TNA' },
      { idVariable: 160, codigo: 'TPM', nombre: 'Política monetaria', meta: 'Tasa BCRA · TNA' },
    ];

    const { value: payload } = await withFallbacks(
      candidates.map((meta) => ({
        name: meta.codigo,
        fetch: () => buildTasaBcraPayload(meta),
      })),
      {
        label: 'tasa-bcra',
        isValid: (p) => p != null && p.valor != null,
      }
    );

    console.log(`Tasa BCRA ${payload.codigo} (${payload.fecha}): %${payload.valor}`);
    res.status(200).json(payload);
  } catch (error) {
    if (error instanceof AllSourcesFailedError) {
      if (error.lastError) return sendError(res, error.lastError);
      return res.status(404).send('Tasa BCRA no encontrada');
    }
    sendError(res, error);
  }
});

const RIESGO_PAIS_TTL_MS = 60 * 60 * 1000;
let riesgoPaisCache = null;

function formatPb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1).replace('.', ',');
}

function parseRiesgoPaisRows(data) {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const series = rows
    .filter((row) => row && row.fecha && Number.isFinite(Number(row.valor)))
    .map((row) => ({
      fecha: String(row.fecha).slice(0, 10),
      valorNum: Number(row.valor),
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (!series.length) throw new Error('serie riesgo país vacía');
  return series;
}

async function fetchRiesgoPaisSeries(client) {
  const { data } = await client.get(
    'https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais'
  );
  return parseRiesgoPaisRows(data);
}

async function fetchRiesgoPaisUltimo(client) {
  const { data } = await client.get(
    'https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo'
  );
  return parseRiesgoPaisRows(data);
}

/** Últimas N observaciones (días hábiles; fines de semana suele no haber dato). */
function buildRiesgoPaisHistorial(series, days = 7) {
  if (!series.length) return [];

  const window = series.slice(-(days + 1));
  const visible = window.slice(-days);
  const before = window.length > days ? window[0] : null;

  return visible.map((row, index) => {
    const prev = index === 0 ? before : visible[index - 1];
    const deltaPb =
      prev && Number.isFinite(prev.valorNum)
        ? Number((row.valorNum - prev.valorNum).toFixed(1))
        : null;
    return {
      fecha: row.fecha,
      valor: formatPb(row.valorNum),
      deltaPb,
    };
  });
}

async function getRiesgoPaisSeries() {
  if (riesgoPaisCache && Date.now() - riesgoPaisCache.at < RIESGO_PAIS_TTL_MS) {
    return riesgoPaisCache.series;
  }

  const { value: series } = await withFallbacks(
    [
      { name: 'argentinadatos-ipv4', fetch: () => fetchRiesgoPaisSeries(jsonHttp) },
      { name: 'argentinadatos-auto', fetch: () => fetchRiesgoPaisSeries(jsonHttpAuto) },
      { name: 'argentinadatos-http', fetch: () => fetchRiesgoPaisSeries(http) },
      { name: 'argentinadatos-ultimo-ipv4', fetch: () => fetchRiesgoPaisUltimo(jsonHttp) },
      { name: 'argentinadatos-ultimo-auto', fetch: () => fetchRiesgoPaisUltimo(jsonHttpAuto) },
    ],
    {
      label: 'riesgo-pais',
      isValid: (s) => Array.isArray(s) && s.length > 0,
    }
  );

  riesgoPaisCache = { at: Date.now(), series };
  return series;
}

app.get('/api/v1/riesgo-pais', async (_req, res) => {
  try {
    const series = await getRiesgoPaisSeries();
    const historial = buildRiesgoPaisHistorial(series, 7);
    const latest = historial[historial.length - 1];
    if (!latest) {
      return res.status(404).send('Riesgo país no encontrado');
    }

    const deltaPb = latest.deltaPb;
    const payload = {
      valor: latest.valor,
      unidad: 'pb',
      fecha: latest.fecha,
      variacion:
        deltaPb == null
          ? null
          : {
              puntos: deltaPb,
              unidad: 'pb',
              direccion: deltaPb > 0 ? 'up' : deltaPb < 0 ? 'down' : 'flat',
            },
      historial,
    };

    console.log(`Riesgo país (${payload.fecha}): ${payload.valor} pb`);
    res.status(200).json(payload);
  } catch (error) {
    if (error instanceof AllSourcesFailedError) {
      if (error.lastError) return sendError(res, error.lastError);
      return res.status(404).send('Riesgo país no encontrado');
    }
    sendError(res, error);
  }
});

/** CER id 30 · UVA id 31 (Principales Variables BCRA, diarios). */
const BCRA_DAILY_INDEX_TTL_MS = 60 * 60 * 1000;
const bcraDailyIndexCache = new Map();

function formatBcraIndexValue(value, decimals) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Últimas N observaciones diarias con Δ% vs el día previo. */
function buildBcraDailyHistorial(series, days = 7, decimals = 2) {
  if (!series.length) return [];

  const window = series.slice(-(days + 1));
  const visible = window.slice(-days);
  const before = window.length > days ? window[0] : null;

  return visible.map((row, index) => {
    const prev = index === 0 ? before : visible[index - 1];
    let deltaPct = null;
    if (prev && Number.isFinite(prev.valorNum) && prev.valorNum !== 0) {
      deltaPct = Number((((row.valorNum - prev.valorNum) / prev.valorNum) * 100).toFixed(2));
    }
    return {
      fecha: row.fecha,
      valor: formatBcraIndexValue(row.valorNum, decimals),
      valorNum: row.valorNum,
      deltaPct,
    };
  });
}

async function getBcraDailyIndexSeries(idVariable) {
  const cached = bcraDailyIndexCache.get(idVariable);
  if (cached && Date.now() - cached.at < BCRA_DAILY_INDEX_TTL_MS) {
    return cached.series;
  }
  const series = await getBcraVariableSeries(idVariable, 40);
  if (!series.length) throw new Error(`serie BCRA ${idVariable} vacía`);
  bcraDailyIndexCache.set(idVariable, { at: Date.now(), series });
  return series;
}

async function buildBcraDailyIndexPayload({
  idVariable,
  codigo,
  nombre,
  meta,
  decimals,
}) {
  const series = await getBcraDailyIndexSeries(idVariable);
  const historial = buildBcraDailyHistorial(series, 7, decimals);
  const latest = historial[historial.length - 1];
  if (!latest) throw new Error(`${codigo} sin observaciones`);

  const deltaPct = latest.deltaPct;
  return {
    valor: latest.valor,
    codigo,
    nombre,
    meta,
    unidad: codigo === 'UVA' ? 'ARS' : 'índice',
    fecha: latest.fecha,
    variacion:
      deltaPct == null
        ? null
        : {
            porcentaje: deltaPct,
            unidad: '%',
            direccion: deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat',
          },
    historial: historial.map(({ fecha, valor, deltaPct: d }) => ({
      fecha,
      valor,
      deltaPct: d,
    })),
  };
}

app.get('/api/v1/uva', async (_req, res) => {
  try {
    const payload = await buildBcraDailyIndexPayload({
      idVariable: 31,
      codigo: 'UVA',
      nombre: 'UVA',
      meta: 'Préstamos / plazos fijos · BCRA',
      decimals: 2,
    });
    console.log(`UVA (${payload.fecha}): ${payload.valor}`);
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/cer', async (_req, res) => {
  try {
    const payload = await buildBcraDailyIndexPayload({
      idVariable: 30,
      codigo: 'CER',
      nombre: 'CER',
      meta: 'Coef. estabilización · BCRA',
      decimals: 4,
    });
    console.log(`CER (${payload.fecha}): ${payload.valor}`);
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

async function buildTasaBcraPayload(selectedMeta) {
  const { value: latestBundle } = await withFallbacks(
    [
      {
        name: `${selectedMeta.codigo}-serie`,
        fetch: async () => {
          const series = await getBcraVariableSeries(selectedMeta.idVariable, 220);
          const historial = buildBcraMonthlyHistorial(series, 6);
          const latest = historial[historial.length - 1];
          if (!latest) throw new Error('serie mensual vacía');
          return { latest, historial };
        },
      },
      {
        name: `${selectedMeta.codigo}-latest`,
        fetch: async () => {
          const point = await getBcraVariableLatest(selectedMeta.idVariable);
          if (!point || point.valor == null) throw new Error('sin último valor');
          const valorNum = Number(point.valor);
          if (!Number.isFinite(valorNum)) throw new Error('último valor no numérico');
          const latest = {
            fecha: String(point.fecha).slice(0, 10),
            periodo: formatIpcPeriodo(point.fecha),
            valor: valorNum.toFixed(2).replace('.', ','),
            deltaPp: null,
          };
          return { latest, historial: [latest] };
        },
      },
    ],
    {
      label: `tasa-bcra-${selectedMeta.codigo}`,
      isValid: (bundle) => bundle?.latest?.valor != null,
    }
  );

  const { latest, historial } = latestBundle;
  const deltaPp = latest.deltaPp;
  return {
    valor: latest.valor,
    codigo: selectedMeta.codigo,
    nombre: selectedMeta.nombre,
    meta: selectedMeta.meta,
    fecha: latest.fecha,
    periodo: latest.periodo,
    variacion:
      deltaPp == null
        ? null
        : {
            porcentaje: deltaPp,
            unidad: 'pp',
            direccion: deltaPp > 0 ? 'up' : deltaPp < 0 ? 'down' : 'flat',
          },
    historial: historial.map(({ fecha, periodo, valor, deltaPp: d }) => ({
      fecha,
      periodo,
      valor,
      deltaPp: d,
    })),
  };
}

async function getBcraVariableLatest(idVariable) {
  const { data } = await bcraHttp.get(
    `https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias/${idVariable}`,
    { params: { limit: 1 } }
  );
  const row = data?.results?.[0]?.detalle?.[0];
  if (!row) {
    const list = await bcraHttp.get('https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias', {
      params: { IdVariable: idVariable },
    });
    const meta = list.data?.results?.[0];
    if (!meta) return null;
    return {
      fecha: meta.ultFechaInformada,
      valor: meta.ultValorInformado,
    };
  }
  return { fecha: row.fecha, valor: row.valor };
}

async function getBcraVariableSeries(idVariable, daysBack = 220) {
  const hasta = new Date().toISOString().slice(0, 10);
  const desde = isoMinusDays(hasta, daysBack);
  const { data } = await bcraHttp.get(
    `https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias/${idVariable}`,
    {
      params: {
        desde,
        hasta,
        limit: 1000,
      },
    }
  );

  const detalle = data?.results?.[0]?.detalle || [];
  return detalle
    .filter((row) => row?.fecha != null && row?.valor != null && Number.isFinite(Number(row.valor)))
    .map((row) => ({
      fecha: String(row.fecha).slice(0, 10),
      valorNum: Number(row.valor),
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Último valor informado de cada mes, últimos N meses. */
function buildBcraMonthlyHistorial(series, months = 6) {
  if (!series.length) return [];

  const byMonth = new Map();
  for (const row of series) {
    const key = row.fecha.slice(0, 7); // YYYY-MM
    byMonth.set(key, row);
  }

  const monthly = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, row]) => row);

  // Incluye un mes previo para calcular delta del primero visible
  const window = monthly.slice(-(months + 1));
  const visible = window.slice(-months);
  const before = window.length > months ? window[0] : null;

  return visible.map((row, index) => {
    const prev = index === 0 ? before : visible[index - 1];
    const deltaPp =
      prev && Number.isFinite(prev.valorNum)
        ? Number((row.valorNum - prev.valorNum).toFixed(2))
        : null;
    return {
      fecha: row.fecha,
      periodo: formatIpcPeriodo(row.fecha),
      valor: row.valorNum.toFixed(2).replace('.', ','),
      valorNum: row.valorNum,
      deltaPp,
    };
  });
}

function daysSince(isoDate) {
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return Number.POSITIVE_INFINITY;
  const ms = Date.now() - then.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

app.get('/api/v1/temperatura', async (_req, res) => {
  try {
    const payload = await getTemperaturaPayload();
    if (!payload) {
      return res.status(404).send('Temperatura no disponible');
    }
    console.log(
      `Temperatura: ${payload.temperature} | código: ${payload.weatherCode} | ${payload.condition}`
    );
    res.status(200).json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

async function getTemperaturaPayload() {
  try {
    // Paralelo: Open-Meteo (7 días, varios transportes) vs wttr (3 días) vs Met.no (rescate 7d).
    const settled = await Promise.allSettled([
      fetchOpenMeteoWeather(jsonHttp).then((payload) => ({
        name: 'open-meteo-ipv4',
        payload,
      })),
      fetchOpenMeteoWeather(jsonHttpAuto).then((payload) => ({
        name: 'open-meteo-auto',
        payload,
      })),
      fetchOpenMeteoWeather(http).then((payload) => ({
        name: 'open-meteo-http',
        payload,
      })),
      fetchOpenMeteoNative().then((payload) => ({
        name: 'open-meteo-native',
        payload,
      })),
      fetchWttrWeather().then((payload) => ({ name: 'wttr', payload })),
      fetchMetNoWeather().then((payload) => ({ name: 'met-no', payload })),
    ]);

    const ok = settled
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((x) => x?.payload != null && x.payload.temperature != null);

    for (const r of settled) {
      if (r.status === 'rejected') {
        console.error(
          '[temperatura] fuente falló:',
          r.reason?.code || '',
          r.reason?.message || r.reason
        );
      }
    }

    if (!ok.length) return null;

    const openMeteo = ok.find((x) => x.name.startsWith('open-meteo'));
    const metNo = ok.find((x) => x.name === 'met-no');
    const wttr = ok.find((x) => x.name === 'wttr');

    const preferred = [openMeteo, metNo].find(
      (x) => (x?.payload?.forecast?.length || 0) >= 7
    ) || openMeteo || metNo;

    if (preferred) {
      console.log(
        `[temperatura] fuente: ${preferred.name} | días=${preferred.payload.forecast?.length || 0}`
      );
      let payload = preferred.payload;
      if (preferred.name === 'met-no' && wttr?.payload) {
        payload = mergeForecastSunTimes(payload, wttr.payload);
      }
      return ensureForecastSunTimes(payload);
    }

    // Solo wttr (3 días): si Met.no/OM llegaron sin temperature filter miss, reintentar forecast.
    if (wttr) {
      const rescued = await rescueExtendedForecast(wttr.payload);
      if (rescued) return ensureForecastSunTimes(rescued);

      console.log(
        `[temperatura] fuente: wttr | días=${wttr.payload.forecast?.length || 0}`
      );
      return ensureForecastSunTimes(wttr.payload);
    }

    return null;
  } catch (error) {
    if (error instanceof AllSourcesFailedError) return null;
    throw error;
  }
}

async function rescueExtendedForecast(wttrPayload) {
  const attempts = [
    () => fetchOpenMeteoWeather(jsonHttpAuto),
    () => fetchOpenMeteoNative(),
    () => fetchMetNoWeather(),
  ];

  for (const attempt of attempts) {
    try {
      const om = await attempt();
      if (!om?.forecast?.length) continue;
      console.log(
        `[temperatura] fuente: wttr+${om.forecast.length >= 7 ? 'extended' : 'partial'} | días=${om.forecast.length}`
      );
      return mergeForecastSunTimes(
        {
          ...wttrPayload,
          temperature: om.temperature ?? wttrPayload.temperature,
          weatherCode: om.weatherCode ?? wttrPayload.weatherCode,
          condition: om.condition ?? wttrPayload.condition,
          label: om.label ?? wttrPayload.label,
          isDay: om.isDay ?? wttrPayload.isDay,
          humidity: om.humidity ?? wttrPayload.humidity,
          sunrise: om.sunrise ?? wttrPayload.sunrise,
          sunset: om.sunset ?? wttrPayload.sunset,
          forecast: om.forecast,
        },
        wttrPayload
      );
    } catch (error) {
      console.error(
        '[temperatura] rescate forecast falló:',
        error?.code || '',
        error?.message || error
      );
    }
  }
  return null;
}

/** Completa salida/puesta solar faltantes (p.ej. Met.no) con las de wttr por fecha. */
function mergeForecastSunTimes(primary, sunSource) {
  if (!primary?.forecast?.length || !sunSource?.forecast?.length) return primary;
  const byDate = new Map(
    sunSource.forecast.map((day) => [day.date, day])
  );
  return normalizeCurrentDayNight({
    ...primary,
    sunrise: primary.sunrise || sunSource.sunrise || null,
    sunset: primary.sunset || sunSource.sunset || null,
    forecast: primary.forecast.map((day) => {
      const extra = byDate.get(day.date);
      if (!extra) return day;
      return {
        ...day,
        sunrise: day.sunrise || extra.sunrise || null,
        sunset: day.sunset || extra.sunset || null,
      };
    }),
  });
}

/**
 * Rellena sunrise/sunset faltantes con cálculo local para CABA.
 * Met.no no trae astronomía; wttr solo cubre ~3 días.
 */
function ensureForecastSunTimes(payload) {
  if (!payload?.forecast?.length) return normalizeCurrentDayNight(payload);

  const forecast = payload.forecast.map((day) => {
    if (day.sunrise && day.sunset) return day;
    const computed = computeBuenosAiresSunTimes(day.date);
    if (!computed) return day;
    return {
      ...day,
      sunrise: day.sunrise || computed.sunrise,
      sunset: day.sunset || computed.sunset,
    };
  });

  const today = forecast[0] || {};
  return normalizeCurrentDayNight({
    ...payload,
    sunrise: payload.sunrise || today.sunrise || null,
    sunset: payload.sunset || today.sunset || null,
    forecast,
  });
}

/** After sunrise/sunset are known, remap clear-sky-at-night away from "sunny". */
function normalizeCurrentDayNight(payload) {
  if (!payload) return payload;
  let isDay = payload.isDay;
  if (typeof isDay !== 'boolean') {
    isDay = isDaytimeFromSun(payload.sunrise, payload.sunset);
  }
  const baseCondition =
    payload.condition === 'clearnight' ? 'sunny' : payload.condition;
  const condition = resolveClearNight(baseCondition, isDay);
  if (condition === payload.condition && isDay === payload.isDay) {
    return payload;
  }
  return {
    ...payload,
    isDay,
    condition,
    label: weatherLabel(condition),
  };
}

const BA_LAT = -34.6037;
const BA_LON = -58.3816;
/** Argentina continental: UTC−3 fijo (sin DST). */
const BA_TZ_HOURS = -3;

/**
 * Salida/puesta solar aproximada (NOAA) en HH:mm hora de Buenos Aires.
 * Suficiente para el widget; no depende de APIs externas.
 */
function computeBuenosAiresSunTimes(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const dayOfYear = dayOfYearUtc(year, month, day);
  if (!dayOfYear) return null;

  const sunriseUtc = solarUtcHours(dayOfYear, BA_LAT, BA_LON, true);
  const sunsetUtc = solarUtcHours(dayOfYear, BA_LAT, BA_LON, false);
  if (sunriseUtc == null || sunsetUtc == null) return null;

  return {
    sunrise: formatUtcHoursAsBaClock(sunriseUtc),
    sunset: formatUtcHoursAsBaClock(sunsetUtc),
  };
}

function dayOfYearUtc(year, month, day) {
  const date = Date.UTC(year, month - 1, day);
  const start = Date.UTC(year, 0, 0);
  return Math.round((date - start) / 86400000);
}

function solarUtcHours(dayOfYear, lat, lon, isSunrise) {
  const rad = Math.PI / 180;
  const lngHour = lon / 15;
  const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
  let M = 0.9856 * t - 3.289;
  let L =
    M +
    1.916 * Math.sin(M * rad) +
    0.02 * Math.sin(2 * M * rad) +
    282.634;
  L = ((L % 360) + 360) % 360;

  let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  const Lquadrant = Math.floor(L / 90) * 90;
  const RAquadrant = Math.floor(RA / 90) * 90;
  RA = (RA + (Lquadrant - RAquadrant)) / 15;

  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH =
    (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) /
    (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;

  let H = Math.acos(cosH) / rad;
  if (isSunrise) H = 360 - H;
  H /= 15;

  const T = H + RA - 0.06571 * t - 6.622;
  return ((T - lngHour) % 24 + 24) % 24;
}

function formatUtcHoursAsBaClock(utcHours) {
  let local = utcHours + BA_TZ_HOURS;
  local = ((local % 24) + 24) % 24;
  const hour = Math.floor(local);
  const minute = Math.round((local - hour) * 60);
  if (minute === 60) {
    return `${String((hour + 1) % 24).padStart(2, '0')}:00`;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const OPEN_METEO_PARAMS = {
  latitude: -34.6037,
  longitude: -58.3816,
  current: 'temperature_2m,weather_code,relative_humidity_2m,is_day',
  daily:
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,relative_humidity_2m_mean',
  timezone: 'America/Argentina/Buenos_Aires',
  forecast_days: 7,
};

async function fetchOpenMeteoWeather(client) {
  const { data } = await client.get('https://api.open-meteo.com/v1/forecast', {
    params: OPEN_METEO_PARAMS,
  });
  return parseOpenMeteoPayload(data);
}

/** Fetch nativo sin axios: útil si el Agent de axios falla en el runtime de Render. */
function fetchOpenMeteoNative() {
  const qs = new URLSearchParams(OPEN_METEO_PARAMS).toString();
  const url = `https://api.open-meteo.com/v1/forecast?${qs}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        family: 4,
        headers: jsonHeaders,
        timeout: 25000,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 400) {
            reject(new Error(`Open-Meteo native HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(parseOpenMeteoPayload(JSON.parse(raw)));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Open-Meteo native timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseOpenMeteoPayload(data) {
  const temperature = data?.current?.temperature_2m;
  const weatherCode = data?.current?.weather_code;
  if (temperature === undefined || temperature === null) {
    throw new Error('Open-Meteo sin temperatura actual');
  }

  const forecast = buildForecastDays(data?.daily);
  const today = forecast[0] || {};
  const humidityCurrent = Number(data?.current?.relative_humidity_2m);
  const humidity = Number.isFinite(humidityCurrent)
    ? Math.round(humidityCurrent)
    : today.humidity ?? null;
  const sunrise = today.sunrise || null;
  const sunset = today.sunset || null;
  const isDayRaw = data?.current?.is_day;
  const isDay =
    isDayRaw === 0 || isDayRaw === 1
      ? isDayRaw === 1
      : isDaytimeFromSun(sunrise, sunset);
  const condition = resolveClearNight(mapWeatherCondition(weatherCode), isDay);
  return {
    temperature,
    weatherCode,
    condition,
    label: weatherLabel(condition),
    isDay,
    humidity,
    sunrise,
    sunset,
    forecast,
  };
}

async function fetchMetNoWeather() {
  const { data } = await jsonHttpAuto.get(
    'https://api.met.no/weatherapi/locationforecast/2.0/compact',
    {
      params: { lat: -34.6037, lon: -58.3816 },
      headers: {
        ...jsonHeaders,
        // Met.no exige User-Agent identificable.
        'User-Agent': jsonHeaders['User-Agent'],
      },
    }
  );

  const forecast = buildMetNoForecast(data?.properties?.timeseries);
  if (!forecast.length) {
    throw new Error('Met.no sin forecast diario');
  }

  const today = forecast[0];
  const first = data?.properties?.timeseries?.[0];
  const details = first?.data?.instant?.details || {};
  const temperature = Number(details.air_temperature);
  if (!Number.isFinite(temperature)) {
    throw new Error('Met.no sin temperatura actual');
  }

  const humidityRaw = Number(details.relative_humidity);
  const symbol =
    first?.data?.next_1_hours?.summary?.symbol_code ||
    first?.data?.next_6_hours?.summary?.symbol_code ||
    today.condition;
  const sunrise = today.sunrise || null;
  const sunset = today.sunset || null;
  const isDayFromSymbol = metNoSymbolIsDay(symbol);
  const isDay =
    isDayFromSymbol != null
      ? isDayFromSymbol
      : isDaytimeFromSun(sunrise, sunset);
  const condition = resolveClearNight(mapMetNoSymbol(symbol), isDay);

  return {
    temperature,
    weatherCode: null,
    condition,
    label: weatherLabel(condition),
    isDay,
    humidity: Number.isFinite(humidityRaw)
      ? Math.round(humidityRaw)
      : today.humidity ?? null,
    sunrise,
    sunset,
    forecast,
  };
}

function buildMetNoForecast(timeseries) {
  if (!Array.isArray(timeseries) || !timeseries.length) return [];

  const byDay = new Map();
  for (const point of timeseries) {
    const iso = point?.time;
    if (!iso) continue;
    const date = toBuenosAiresDate(iso);
    if (!date) continue;

    const details = point?.data?.instant?.details || {};
    const temp = Number(details.air_temperature);
    const wind = Number(details.wind_speed);
    const windDir = Number(details.wind_from_direction);
    const humidity = Number(details.relative_humidity);
    const precip = Number(
      point?.data?.next_6_hours?.details?.precipitation_amount ??
        point?.data?.next_1_hours?.details?.precipitation_amount ??
        0
    );
    const symbol =
      point?.data?.next_6_hours?.summary?.symbol_code ||
      point?.data?.next_1_hours?.summary?.symbol_code ||
      point?.data?.next_12_hours?.summary?.symbol_code ||
      '';

    let day = byDay.get(date);
    if (!day) {
      day = {
        date,
        temps: [],
        winds: [],
        windDirs: [],
        humidities: [],
        precipSum: 0,
        symbols: [],
      };
      byDay.set(date, day);
    }

    if (Number.isFinite(temp)) day.temps.push(temp);
    if (Number.isFinite(wind)) day.winds.push(wind * 3.6); // m/s → km/h
    if (Number.isFinite(windDir)) day.windDirs.push(windDir);
    if (Number.isFinite(humidity)) day.humidities.push(humidity);
    if (Number.isFinite(precip)) day.precipSum += precip;
    if (symbol) day.symbols.push(symbol);
  }

  return [...byDay.values()]
    .slice(0, 7)
    .map((day) => {
      const condition = mapMetNoSymbol(pickMidSymbol(day.symbols) || 'cloudy');
      const windMax = day.winds.length
        ? Math.round(Math.max(...day.winds))
        : 0;
      const windMin = day.winds.length
        ? Math.round(Math.min(...day.winds))
        : 0;
      const humidityAvg = day.humidities.length
        ? Math.round(
            day.humidities.reduce((a, b) => a + b, 0) / day.humidities.length
          )
        : null;
      const precipProb = day.precipSum > 0.2 ? 40 : day.precipSum > 0 ? 20 : 0;

      return {
        date: day.date,
        weatherCode: null,
        condition,
        label: weatherLabel(condition),
        tempMax: day.temps.length ? Math.round(Math.max(...day.temps)) : null,
        tempMin: day.temps.length ? Math.round(Math.min(...day.temps)) : null,
        precipProbability: precipProb,
        precipSum: Number(day.precipSum.toFixed(1)),
        showPrecip: condition === 'rainy' || precipProb >= 30 || day.precipSum > 0,
        windMin: Math.min(windMin, windMax),
        windMax: Math.max(windMin, windMax),
        windDirection: day.windDirs.length
          ? Math.round(
              day.windDirs.reduce((a, b) => a + b, 0) / day.windDirs.length
            )
          : 0,
        humidity: humidityAvg,
        sunrise: null,
        sunset: null,
      };
    })
    .filter((d) => d.tempMax != null && d.tempMin != null);
}

function toBuenosAiresDate(iso) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date(iso)); // YYYY-MM-DD
  } catch {
    return String(iso).slice(0, 10);
  }
}

function pickMidSymbol(symbols) {
  if (!symbols?.length) return '';
  return symbols[Math.min(Math.floor(symbols.length / 2), symbols.length - 1)];
}

function mapMetNoSymbol(symbolOrCondition) {
  const s = String(symbolOrCondition || '').toLowerCase();
  if (['sunny', 'partly', 'cloudy', 'rainy', 'clearnight'].includes(s)) return s;
  if (s.includes('thunder') || s.includes('rain') || s.includes('sleet') || s.includes('snow') || s.includes('storm')) {
    return 'rainy';
  }
  if (s.includes('fog') || s === 'cloudy' || s.includes('cloud')) return 'cloudy';
  if (s.includes('partlycloudy') || s.includes('fair')) return 'partly';
  if (s.includes('clearsky') || s.includes('clear')) {
    return s.includes('night') ? 'clearnight' : 'sunny';
  }
  return 'cloudy';
}

/** Met.no symbols often end in _day / _night. */
function metNoSymbolIsDay(symbol) {
  const s = String(symbol || '').toLowerCase();
  if (s.includes('_night') || s.endsWith('night')) return false;
  if (s.includes('_day') || s.endsWith('day')) return true;
  return null;
}

async function fetchWttrWeather() {
  const { data } = await http.get('https://wttr.in/Buenos%20Aires', {
    params: { format: 'j1' },
    headers: { Accept: 'application/json' },
  });

  const current = data?.current_condition?.[0];
  const temperature = Number(current?.temp_C);
  if (!Number.isFinite(temperature)) {
    throw new Error('wttr.in sin temperatura');
  }

  const code = Number(current?.weatherCode);
  const forecast = buildWttrForecast(data?.weather);
  const today = forecast[0] || {};
  const sunrise = today.sunrise || null;
  const sunset = today.sunset || null;
  const isDayFlag = String(current?.isday ?? current?.isDay ?? '').toLowerCase();
  const isDay =
    isDayFlag === 'yes' || isDayFlag === '1'
      ? true
      : isDayFlag === 'no' || isDayFlag === '0'
        ? false
        : isDaytimeFromSun(sunrise, sunset);
  const condition = resolveClearNight(mapWttrCondition(code), isDay);
  const humidityCurrent = Number(current?.humidity);
  const humidity = Number.isFinite(humidityCurrent)
    ? Math.round(humidityCurrent)
    : today.humidity ?? null;
  return {
    temperature,
    weatherCode: code,
    condition,
    label: weatherLabel(condition),
    isDay,
    humidity,
    sunrise,
    sunset,
    forecast,
  };
}

function mapWttrCondition(code) {
  const n = Number(code);
  if ([113].includes(n)) return 'sunny';
  if ([116, 119].includes(n)) return 'partly';
  if ([122, 143, 248, 260].includes(n)) return 'cloudy';
  if (
    (n >= 176 && n <= 377) ||
    (n >= 386 && n <= 395) ||
    [293, 296, 299, 302, 305, 308, 353, 356, 359].includes(n)
  ) {
    return 'rainy';
  }
  return 'cloudy';
}

function buildWttrForecast(days) {
  if (!Array.isArray(days)) return [];
  return days.slice(0, 7).map((day) => {
    const hourly = day?.hourly || [];
    const mid = hourly[Math.min(4, hourly.length - 1)] || hourly[0] || {};
    const code = Number(mid.weatherCode ?? day.hourly?.[0]?.weatherCode);
    const condition = mapWttrCondition(code);
    const precipProb = Number(mid.chanceofrain ?? 0);
    const precipSum = Number(day.totalSnow_cm ?? 0) > 0 ? Number(day.totalSnow_cm) : Number(mid.precipMM ?? 0);
    const wind = Math.round(Number(mid.windspeedKmph ?? 0));
    const astronomy = day?.astronomy?.[0] || {};
    const humidityRaw = Number(mid.humidity);
    return {
      date: day.date,
      weatherCode: code,
      condition,
      label: weatherLabel(condition),
      tempMax: Number(day.maxtempC),
      tempMin: Number(day.mintempC),
      precipProbability: precipProb,
      precipSum,
      showPrecip: condition === 'rainy' || precipProb >= 30 || precipSum > 0,
      windMin: wind,
      windMax: wind,
      windDirection: Number(mid.winddirDegree ?? 0),
      humidity: Number.isFinite(humidityRaw) ? Math.round(humidityRaw) : null,
      sunrise: formatSunClock(astronomy.sunrise),
      sunset: formatSunClock(astronomy.sunset),
    };
  });
}

function buildForecastDays(daily) {
  if (!daily?.time?.length) return [];

  return daily.time.map((date, index) => {
    const weatherCode = daily.weather_code?.[index];
    const condition = mapWeatherCondition(weatherCode);
    const precipProb = Number(daily.precipitation_probability_max?.[index] ?? 0);
    const precipSum = Number(daily.precipitation_sum?.[index] ?? 0);
    const windMin = Math.round(Number(daily.wind_speed_10m_max?.[index] ?? 0));
    const windMax = Math.round(Number(daily.wind_gusts_10m_max?.[index] ?? windMin));
    const humidityRaw = Number(daily.relative_humidity_2m_mean?.[index]);

    return {
      date,
      weatherCode,
      condition,
      label: weatherLabel(condition),
      tempMax: Number(daily.temperature_2m_max?.[index]),
      tempMin: Number(daily.temperature_2m_min?.[index]),
      precipProbability: precipProb,
      precipSum,
      showPrecip: condition === 'rainy' || precipProb >= 30 || precipSum > 0,
      windMin: Math.min(windMin, windMax),
      windMax: Math.max(windMin, windMax),
      windDirection: Number(daily.wind_direction_10m_dominant?.[index] ?? 0),
      humidity: Number.isFinite(humidityRaw) ? Math.round(humidityRaw) : null,
      sunrise: formatSunClock(daily.sunrise?.[index]),
      sunset: formatSunClock(daily.sunset?.[index]),
    };
  });
}

/** Normaliza ISO Open-Meteo o "06:45 AM" de wttr → "HH:mm". */
function formatSunClock(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const isoMatch = raw.match(/T(\d{2}):(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}:${isoMatch[2]}`;

  const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2];
    const period = ampm[3].toUpperCase();
    if (period === 'AM' && hour === 12) hour = 0;
    if (period === 'PM' && hour !== 12) hour += 12;
    return `${String(hour).padStart(2, '0')}:${minute}`;
  }

  const h24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) return `${String(Number(h24[1])).padStart(2, '0')}:${h24[2]}`;

  return null;
}

function mapWeatherCondition(code) {
  const n = Number(code);
  if (Number.isNaN(n)) return 'cloudy';
  if (n === 0) return 'sunny';
  if (n === 1 || n === 2) return 'partly';
  if (n === 3 || n === 45 || n === 48) return 'cloudy';
  if (
    (n >= 51 && n <= 67) ||
    (n >= 80 && n <= 82) ||
    (n >= 95 && n <= 99)
  ) {
    return 'rainy';
  }
  if ((n >= 71 && n <= 77) || n === 85 || n === 86) return 'rainy';
  return 'cloudy';
}

/** Clear sky at night is not "sunny" — map to clearnight for label/icon. */
function resolveClearNight(condition, isDay) {
  if (condition === 'sunny' && isDay === false) return 'clearnight';
  return condition;
}

function clockToMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function buenosAiresClockMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/** true/false if sunrise+sunset known; null if unknown. */
function isDaytimeFromSun(sunrise, sunset) {
  const now = buenosAiresClockMinutes();
  const rise = clockToMinutes(sunrise);
  const set = clockToMinutes(sunset);
  if (now == null || rise == null || set == null) return null;
  return now >= rise && now < set;
}

function weatherLabel(condition) {
  if (condition === 'sunny') return 'Soleado';
  if (condition === 'clearnight') return 'Despejado';
  if (condition === 'partly') return 'Parcialmente nublado';
  if (condition === 'rainy') return 'Lluvia';
  return 'Nublado';
}
app.get('/api/v1/johnny-red', async (_req, res) => {
  try {
    const url = 'https://www.craftmoments.com.ar/producto/red-label/';
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const precio = $('span.woocommerce-Price-amount').first().text().trim();

    if (!precio) {
      return res.status(404).send('Precio no encontrado');
    }

    console.log(`Precio del Johnnie Walker Red Label: ${precio}`);
    res.status(200).send(precio);
  } catch (error) {
    sendError(res, error);
  }
});

async function averagePriceFromSources(sources, label = 'precios') {
  const { values } = await collectFromSources(
    sources.map((source) => ({
      name: source.name || source.url,
      fetch: async () => {
        const { data: html } = await http.get(source.url);
        const $ = cheerio.load(html);
        const precioText = source.selector($);
        const precioMatches = String(precioText).match(/\d{1,3}(?:\.\d{3})*(?:,\d{2})?/);
        if (!precioMatches?.length) {
          throw new Error('sin precio parseable');
        }
        return parseFloat(precioMatches[0].replace(/\./g, '').replace(',', '.'));
      },
    })),
    {
      label,
      isValid: (n) => Number.isFinite(n),
    }
  );
  return values;
}

app.get('/api/v1/promedio-precio-asado', async (_req, res) => {
  try {
    const prices = await averagePriceFromSources(
      [
        {
          name: 'res.com.ar',
          url: 'https://www.res.com.ar/asado.html',
          selector: ($) => $('span.price').text(),
        },
        {
          name: 'frigorifico90',
          url: 'https://www.frigorifico90.com.ar/productos/asado-x-kg/',
          selector: ($) => $('h3.js-price-display').text(),
        },
        {
          name: 'briosa',
          url: 'https://www.briosa.com.ar/productos/asado-especial-x-kg/',
          selector: ($) => $('h2.js-price-display').text(),
        },
      ],
      'asado'
    );

    if (!prices.length) {
      return res.status(404).send('Precios del kilo de asado no encontrados');
    }

    const averagePrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const formatted = averagePrice.toFixed(2).replace('.', ',');
    console.log(`El promedio del precio del kilo de asado es: ${formatted}`);
    res.status(200).send(formatted);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/v1/promedio-precio-pan', async (_req, res) => {
  try {
    const prices = await averagePriceFromSources(
      [
        {
          name: 'briosa',
          url: 'https://www.briosa.com.ar/productos/pan-mignon-x-kg/',
          selector: ($) => $('.js-price-display').first().text(),
        },
        {
          name: 'clargentina',
          url: 'https://www.clargentina.com.ar/productos/pan-frances-x-kilo/',
          selector: ($) => $('.js-price-display').first().text(),
        },
        {
          name: 'nuevosiglo',
          url: 'https://fiambrerianuevosiglo.com.ar/productos/pan-frances-x1kg/',
          selector: ($) => $('.js-price-display').first().text(),
        },
        {
          name: 'tuchanguito',
          url: 'https://www.tuchanguito.com.ar/productos/pan-frances-x-kg/',
          selector: ($) => $('.js-price-display').first().text(),
        },
      ],
      'pan'
    );

    if (!prices.length) {
      return res.status(404).send('Precios del kilo de pan no encontrados');
    }

    const averagePrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const formatted = averagePrice.toFixed(2).replace('.', ',');
    console.log(`El promedio del precio del kilo de pan es: ${formatted}`);
    res.status(200).send(formatted);
  } catch (error) {
    sendError(res, error);
  }
});

app.listen(port, () => {
  console.log(`Servidor Express escuchando en el puerto ${port}`);
});
