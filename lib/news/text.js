/**
 * Utilidades para tratar contenido externo como no confiable:
 * texto plano sin HTML, links validados contra el dominio del medio y fechas sanas.
 */
const cheerio = require('cheerio');

const MAX_TITLE_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 280;

/** HTML/entidades → texto plano de una línea. No trunca (Clarín pide no alterar títulos). */
function toPlainText(raw) {
  if (raw == null) return '';
  const str = String(raw);
  const text = str.includes('<') || str.includes('&')
    ? cheerio.load(str, null, false).text()
    : str;
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(raw) {
  const text = toPlainText(raw);
  if (!text || text.length > MAX_TITLE_LENGTH) return null;
  return text;
}

function cleanSummary(raw) {
  const text = toPlainText(raw);
  if (!text) return null;
  if (text.length <= MAX_SUMMARY_LENGTH) return text;
  const cut = text.slice(0, MAX_SUMMARY_LENGTH);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}…`;
}

function hostMatches(hostname, domains) {
  const host = hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Link absoluto https del dominio del medio, o null.
 * Rechaza otros esquemas (javascript:, data:), credenciales, puertos y hosts ajenos.
 */
function safeArticleUrl(raw, domains) {
  const value = toPlainText(raw);
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  if (!hostMatches(url.hostname, domains)) return null;
  url.protocol = 'https:';
  url.hash = '';
  return url.toString();
}

/**
 * Clave para deduplicar por URL: sin www/amp, sin query ni hash, sin barra final.
 * Los medios integrados no usan query strings para identificar notas.
 */
function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^(www|amp|m)\./, '');
    const path = url.pathname.replace(/\/amp\/?$/, '/').replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/** Fecha de publicación válida (no futura ni demasiado vieja) o null. */
function parsePublishedAt(raw, { now = Date.now(), maxAgeMs, maxFutureMs = 10 * 60 * 1000 } = {}) {
  const text = toPlainText(raw);
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  if (ms > now + maxFutureMs) return null;
  if (maxAgeMs != null && now - ms > maxAgeMs) return null;
  return new Date(ms);
}

/** Minúsculas conservadas; sin tildes para que las reglas no dependan de la grafía. */
function stripAccents(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

module.exports = {
  toPlainText,
  cleanTitle,
  cleanSummary,
  safeArticleUrl,
  normalizeUrl,
  parsePublishedAt,
  stripAccents,
  MAX_TITLE_LENGTH,
};
