/**
 * Servicio del feed: una sola caché compartida en memoria para todos los visitantes.
 *
 * - Stale-while-revalidate: si la caché tiene más de `ttlMs`, se responde con lo que hay
 *   y se refresca en segundo plano. Solo la primera visita sin datos espera al refresco.
 * - Single-flight: nunca hay dos refrescos simultáneos (no se consulta a los medios por visitante).
 * - Aislamiento: cada medio y cada feed fallan por separado, con timeout propio.
 * - Último válido: si un medio falla, se conservan sus notas anteriores hasta `sourceMaxAgeMs`.
 *   Si fallan todos, se mantiene el snapshot anterior completo y se marca como desactualizado.
 */
const { parseRss, normalizeItem } = require('./rss');
const { classifyItem } = require('./classify');
const { dedupeItems } = require('./dedupe');
const { queryFeed } = require('./rank');
const { documentFrequency } = require('./cluster');

const MINUTE = 60 * 1000;

const DEFAULTS = {
  ttlMs: 12 * MINUTE,
  /** Más allá de esto la UI avisa que los datos están desactualizados. */
  staleAfterMs: 30 * MINUTE,
  /** Notas de un medio caído se siguen mostrando hasta este límite. */
  sourceMaxAgeMs: 6 * 60 * MINUTE,
  /** Antigüedad máxima de una nota para entrar al feed. */
  itemMaxAgeMs: 72 * 60 * MINUTE,
  /** Timeout de toda la tanda de feeds de un medio (cada request tiene el suyo en el cliente HTTP). */
  sourceTimeoutMs: 15 * 1000,
  maxItemsPerFeed: 60,
  /** Sin datos y con fallo total, no reintentar antes de esto (evita un refresco por visita). */
  retryAfterFailureMs: 60 * 1000,
};

class NoNewsDataError extends Error {
  constructor(sources) {
    super('No hay noticias disponibles: fallaron todas las fuentes y no hay datos previos');
    this.name = 'NoNewsDataError';
    this.sources = sources;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label}: timeout ${ms} ms`), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Mensaje apto para el público: sin stack ni detalles internos del upstream. */
function publicError(error) {
  if (!error) return null;
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') return 'timeout';
  if (error.name === 'FeedFormatError') return 'formato inválido';
  const status = error.response?.status;
  if (status) return `HTTP ${status}`;
  return 'sin respuesta';
}

/**
 * @param {{
 *   sources: object[],
 *   fetchText: (url: string) => Promise<string>,
 *   now?: () => number,
 *   logger?: { log: Function, error: Function },
 * } & Partial<typeof DEFAULTS>} options
 */
function createNewsService(options) {
  const config = { ...DEFAULTS, ...options };
  const { sources, fetchText } = config;
  const now = config.now || (() => Date.now());
  const logger = config.logger || console;

  /** @type {null | { updatedAt: number, checkedAt: number, items: object[], sources: object[] }} */
  let snapshot = null;
  /** Último resultado válido por medio: { at, items }. */
  const lastGoodBySource = new Map();
  let inflight = null;
  let lastAttemptAt = 0;
  let lastFailure = null;

  async function fetchSource(source) {
    const feeds = await Promise.allSettled(
      source.feeds.map(async (feed) => {
        const xml = await fetchText(feed.url);
        const raw = parseRss(xml).slice(0, config.maxItemsPerFeed);
        const t = now();
        return raw
          .map((r) => normalizeItem(r, source, feed, { now: t, maxAgeMs: config.itemMaxAgeMs }))
          .filter(Boolean);
      })
    );
    const ok = feeds.filter((f) => f.status === 'fulfilled');
    const failed = feeds
      .map((f, i) => ({ f, feed: source.feeds[i] }))
      .filter(({ f }) => f.status === 'rejected');
    for (const { f, feed } of failed) {
      logger.error(`[noticias] ${source.id} ${feed.url} falló:`, f.reason?.code || '', f.reason?.message || f.reason);
    }
    if (!ok.length) {
      throw failed[0]?.f.reason || new Error('sin feeds');
    }
    return {
      items: ok.flatMap((f) => f.value),
      feedsOk: ok.length,
      feedsTotal: source.feeds.length,
      firstError: failed[0]?.f.reason || null,
    };
  }

  async function doRefresh() {
    const startedAt = now();
    const results = await Promise.allSettled(
      sources.map((s) => withTimeout(fetchSource(s), config.sourceTimeoutMs, s.id))
    );

    const statuses = [];
    const collected = [];
    let anyFresh = false;

    results.forEach((result, i) => {
      const source = sources[i];
      const previous = lastGoodBySource.get(source.id);
      if (result.status === 'fulfilled') {
        anyFresh = true;
        lastGoodBySource.set(source.id, { at: startedAt, items: result.value.items });
        collected.push(...result.value.items);
        const partial = result.value.feedsOk < result.value.feedsTotal;
        statuses.push({
          id: source.id,
          name: source.name,
          status: partial ? 'partial' : 'ok',
          lastSuccessAt: new Date(startedAt).toISOString(),
          error: partial ? publicError(result.value.firstError) : null,
        });
        return;
      }

      logger.error(`[noticias] ${source.id} sin datos nuevos:`, result.reason?.code || '', result.reason?.message || result.reason);
      const usable = previous && startedAt - previous.at <= config.sourceMaxAgeMs;
      if (usable) collected.push(...previous.items);
      statuses.push({
        id: source.id,
        name: source.name,
        status: usable ? 'stale' : 'error',
        lastSuccessAt: previous ? new Date(previous.at).toISOString() : null,
        error: publicError(result.reason),
      });
    });

    if (!anyFresh) {
      if (snapshot) {
        // Fallo total con datos previos: se conserva el último resultado válido.
        snapshot = { ...snapshot, checkedAt: startedAt, sources: statuses };
        return snapshot;
      }
      throw new NoNewsDataError(statuses);
    }

    const minDate = startedAt - config.itemMaxAgeMs;
    const classified = collected
      .filter((item) => Date.parse(item.publishedAt) >= minDate)
      .map(classifyItem)
      .filter(Boolean);
    const items = dedupeItems(classified);
    snapshot = {
      updatedAt: startedAt,
      checkedAt: startedAt,
      items,
      stats: documentFrequency(items),
      sources: statuses,
    };
    logger.log(
      `[noticias] ${items.length} notas (${classified.length} antes de deduplicar) · `
        + statuses.map((s) => `${s.id}:${s.status}`).join(' ')
    );
    return snapshot;
  }

  function refresh() {
    if (!inflight) {
      lastAttemptAt = now();
      inflight = doRefresh()
        .then((snap) => {
          lastFailure = null;
          return snap;
        })
        .catch((error) => {
          lastFailure = error;
          throw error;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function getSnapshot() {
    if (!snapshot) {
      if (lastFailure && !inflight && now() - lastAttemptAt < config.retryAfterFailureMs) {
        throw lastFailure;
      }
      return refresh();
    }
    if (now() - Math.max(snapshot.checkedAt, lastAttemptAt) >= config.ttlMs) {
      refresh().catch((error) => logger.error('[noticias] refresco en segundo plano falló:', error.message));
    }
    return snapshot;
  }

  async function query(params) {
    const snap = await getSnapshot();
    const t = now();
    return {
      updatedAt: new Date(snap.updatedAt).toISOString(),
      checkedAt: new Date(snap.checkedAt).toISOString(),
      stale: t - snap.updatedAt > config.staleAfterMs,
      ...queryFeed(snap.items, params, t, snap.stats),
      sources: snap.sources,
    };
  }

  return { query, refresh, getSnapshot, config };
}

module.exports = { createNewsService, NoNewsDataError, DEFAULTS };
