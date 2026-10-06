/**
 * Adaptadores de medios para el feed de noticias.
 *
 * Cada fuente es independiente: si una falla, las demás siguen.
 * Solo RSS oficiales, verificados el 2026-10-05 (ver AUDITORIA-NOTICIAS.md).
 *
 * - `domains`: hosts válidos para los links de la fuente (se rechaza cualquier otro).
 * - `allowSummary`: mostrar el <description> del RSS. Apagado en todas: Clarín licencia
 *   solo "títulos y/o links" y el resto no publica condiciones de reutilización.
 * - `feeds[].section`: pista de sección para tema/geografía (no reemplaza las reglas).
 */

const NEWS_SOURCES = [
  {
    id: 'clarin',
    name: 'Clarín',
    domains: ['clarin.com'],
    allowSummary: false,
    terms: 'https://www.clarin.com/rss.html',
    feeds: [
      { url: 'https://www.clarin.com/rss/ciudades/', section: 'ciudades' },
      { url: 'https://www.clarin.com/rss/sociedad/', section: 'sociedad' },
      { url: 'https://www.clarin.com/rss/economia/', section: 'economia' },
      { url: 'https://www.clarin.com/rss/lo-ultimo/', section: null },
    ],
  },
  {
    id: 'lanacion',
    name: 'La Nación',
    domains: ['lanacion.com.ar'],
    allowSummary: false,
    terms: null,
    feeds: [
      {
        url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/sociedad/?outputType=xml',
        section: 'sociedad',
      },
      {
        url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/economia/?outputType=xml',
        section: 'economia',
      },
    ],
  },
  {
    id: 'infobae',
    name: 'Infobae',
    domains: ['infobae.com'],
    allowSummary: false,
    terms: null,
    feeds: [
      {
        url: 'https://www.infobae.com/arc/outboundfeeds/rss/category/sociedad/?outputType=xml',
        section: 'sociedad',
      },
      {
        url: 'https://www.infobae.com/arc/outboundfeeds/rss/category/economia/?outputType=xml',
        section: 'economia',
      },
    ],
  },
  {
    id: 'tn',
    name: 'TN',
    domains: ['tn.com.ar'],
    allowSummary: false,
    terms: null,
    feeds: [
      {
        url: 'https://tn.com.ar/arc/outboundfeeds/rss/category/sociedad/?outputType=xml',
        section: 'sociedad',
      },
      {
        url: 'https://tn.com.ar/arc/outboundfeeds/rss/category/economia/?outputType=xml',
        section: 'economia',
      },
      { url: 'https://tn.com.ar/arc/outboundfeeds/rss/?outputType=xml', section: null },
    ],
  },
  {
    id: 'pagina12',
    name: 'Página/12',
    domains: ['pagina12.com.ar'],
    allowSummary: false,
    terms: null,
    feeds: [
      {
        url: 'https://www.pagina12.com.ar/arc/outboundfeeds/rss/secciones/sociedad/notas',
        section: 'sociedad',
      },
      {
        url: 'https://www.pagina12.com.ar/arc/outboundfeeds/rss/secciones/el-pais/notas',
        section: null,
      },
      {
        url: 'https://www.pagina12.com.ar/arc/outboundfeeds/rss/secciones/economia/notas',
        section: 'economia',
      },
    ],
  },
];

/** `NEWS_DISABLED_SOURCES=tn,infobae` apaga fuentes sin tocar código. */
function enabledSources(env = process.env) {
  const disabled = new Set(
    String(env.NEWS_DISABLED_SOURCES || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return NEWS_SOURCES.filter((s) => !disabled.has(s.id));
}

module.exports = { NEWS_SOURCES, enabledSources };
