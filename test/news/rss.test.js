const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRss, normalizeItem, FeedFormatError } = require('../../lib/news/rss');
const { safeArticleUrl, toPlainText, parsePublishedAt } = require('../../lib/news/text');
const { rss } = require('./helpers');

const source = { id: 'clarin', name: 'Clarín', domains: ['clarin.com'], allowSummary: false };
const feed = { url: 'https://www.clarin.com/rss/prueba/', section: 'ciudades' };
const NOW = Date.parse('2026-10-05T18:00:00Z');
const opts = { now: NOW, maxAgeMs: 72 * 3600 * 1000 };

test('parsea ítems RSS 2.0 y rechaza respuestas que no son RSS', () => {
  const items = parseRss(rss([
    { title: '[PRUEBA] Uno', link: 'https://www.clarin.com/prueba/1', pubDate: 'Mon, 05 Oct 2026 13:15:21 +0000', categories: ['Sociedad'] },
    { title: '[PRUEBA] Dos', link: 'https://www.clarin.com/prueba/2', pubDate: '2026-10-05T10:45:27-03:00' },
  ]));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].categories, ['Sociedad']);
  assert.throws(() => parseRss('<!DOCTYPE html><html>Just a moment...</html>'), FeedFormatError);
});

test('sanitiza HTML y entidades del título', () => {
  assert.equal(toPlainText('<b>Paro</b> de &quot;subte&quot;<script>alert(1)</script>'), 'Paro de "subte"alert(1)');
  const [raw] = parseRss(rss([{ title: '<img src=x onerror=alert(1)>[PRUEBA] Hola &amp; chau', link: 'https://www.clarin.com/prueba/1', pubDate: 'Mon, 05 Oct 2026 13:15:21 +0000' }]));
  const item = normalizeItem(raw, source, feed, opts);
  assert.equal(item.title, '[PRUEBA] Hola & chau');
});

test('valida links: solo http(s) del dominio del medio, siempre https', () => {
  assert.equal(safeArticleUrl('javascript:alert(1)', ['clarin.com']), null);
  assert.equal(safeArticleUrl('https://clarin.com.evil.example/x', ['clarin.com']), null);
  assert.equal(safeArticleUrl('https://user:pass@www.clarin.com/x', ['clarin.com']), null);
  assert.equal(safeArticleUrl('https://www.clarin.com:8443/x', ['clarin.com']), null);
  assert.equal(safeArticleUrl('/relativa', ['clarin.com']), null);
  assert.equal(safeArticleUrl('http://www.clarin.com/x', ['clarin.com']), 'https://www.clarin.com/x');
});

test('fechas: descarta futuras (programadas) y viejas; acepta RFC 822 e ISO', () => {
  assert.equal(parsePublishedAt('Tue, 27 Oct 2026 12:30:00 +0000', opts), null);
  assert.equal(parsePublishedAt('Mon, 28 Sep 2026 10:00:00 +0000', opts), null);
  assert.equal(parsePublishedAt('cualquier cosa', opts), null);
  assert.equal(parsePublishedAt('2026-10-05T10:45:27-03:00', opts).toISOString(), '2026-10-05T13:45:27.000Z');
});

test('normalizeItem descarta ítems sin link válido y no expone resumen si la fuente no lo permite', () => {
  const [ok, bad] = parseRss(rss([
    { title: '[PRUEBA] Uno', link: 'https://www.clarin.com/prueba/1', pubDate: 'Mon, 05 Oct 2026 13:15:21 +0000', description: 'Bajada' },
    { title: '[PRUEBA] Dos', link: 'https://otro-sitio.example/2', pubDate: 'Mon, 05 Oct 2026 13:15:21 +0000' },
  ]));
  const item = normalizeItem(ok, source, feed, opts);
  assert.equal(item.summary, null);
  assert.equal(item.description, 'Bajada');
  assert.equal(item.feedSection, 'ciudades');
  assert.equal(normalizeItem(bad, source, feed, opts), null);

  const withSummary = normalizeItem(ok, { ...source, allowSummary: true }, feed, opts);
  assert.equal(withSummary.summary, 'Bajada');
});
