/**
 * Parser RSS 2.0 mínimo. Devuelve campos crudos; la limpieza vive en normalizeItem.
 * Ignora content:encoded a propósito: no reutilizamos el artículo completo.
 */
const cheerio = require('cheerio');
const {
  cleanTitle,
  cleanSummary,
  safeArticleUrl,
  normalizeUrl,
  parsePublishedAt,
  toPlainText,
} = require('./text');

class FeedFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedFormatError';
  }
}

function parseRss(xml) {
  const text = String(xml || '');
  if (!/<rss[\s>]/i.test(text.slice(0, 2000))) {
    throw new FeedFormatError('la respuesta no es un RSS');
  }
  const $ = cheerio.load(text, { xmlMode: true });
  const items = [];
  $('channel > item').each((_, el) => {
    const $el = $(el);
    items.push({
      title: $el.children('title').first().text(),
      link: $el.children('link').first().text(),
      pubDate: $el.children('pubDate').first().text(),
      description: $el.children('description').first().text(),
      categories: $el
        .children('category')
        .map((__, c) => $(c).text())
        .get(),
    });
  });
  return items;
}

/**
 * Ítem crudo → noticia saneada, o null si falta algo imprescindible
 * (título, link del dominio del medio, fecha válida).
 */
function normalizeItem(raw, source, feed, options = {}) {
  const title = cleanTitle(raw.title);
  const url = safeArticleUrl(raw.link, source.domains);
  const publishedAt = parsePublishedAt(raw.pubDate, options);
  if (!title || !url || !publishedAt) return null;

  const description = toPlainText(raw.description);
  return {
    id: normalizeUrl(url),
    title,
    url,
    publishedAt: publishedAt.toISOString(),
    sourceId: source.id,
    sourceName: source.name,
    feedSection: feed.section || null,
    path: new URL(url).pathname.toLowerCase(),
    categories: (raw.categories || []).map(toPlainText).filter(Boolean).slice(0, 10),
    // Se usa solo para clasificar; se expone únicamente si la fuente lo permite.
    description: description.slice(0, 600),
    summary: source.allowSummary ? cleanSummary(raw.description) : null,
  };
}

module.exports = { parseRss, normalizeItem, FeedFormatError };
