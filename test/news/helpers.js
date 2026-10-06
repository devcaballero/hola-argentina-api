/**
 * Datos de PRUEBA para tests. No son noticias reales ni se usan en producción:
 * los títulos son inventados y los links apuntan a paths "/prueba/…".
 */

let seq = 0;

function makeItem(overrides = {}) {
  seq += 1;
  const sourceId = overrides.sourceId || 'clarin';
  const url = overrides.url || `https://www.${sourceId}.com/prueba/nota-${seq}`;
  return {
    id: url.replace(/^https:\/\/(www\.)?/, ''),
    title: `Nota de prueba ${seq}`,
    url,
    publishedAt: new Date('2026-10-05T15:00:00Z').toISOString(),
    sourceId,
    sourceName: sourceId,
    feedSection: null,
    path: new URL(url).pathname,
    categories: [],
    description: '',
    summary: null,
    ...overrides,
  };
}

function rss(items) {
  const body = items
    .map(
      (i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link>`
        + `<pubDate>${i.pubDate}</pubDate><description><![CDATA[${i.description || ''}]]></description>`
        + `${(i.categories || []).map((c) => `<category>${c}</category>`).join('')}</item>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Prueba</title>${body}</channel></rss>`;
}

module.exports = { makeItem, rss };
