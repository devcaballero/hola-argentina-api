const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyGeo, classifyTopics, classifyItem } = require('../../lib/news/classify');
const { makeItem } = require('./helpers');

function geoOf(title, extra = {}) {
  return classifyGeo(makeItem({ title, ...extra })).geo;
}

test('CABA: denominaciones inequívocas de la Ciudad', () => {
  assert.equal(geoOf('Alquileres en CABA: suben otra vez'), 'caba');
  assert.equal(geoOf('Cambios en Capital Federal para estacionar'), 'caba');
  assert.equal(geoOf('La Ciudad Autónoma de Buenos Aires lanza un plan'), 'caba');
  assert.equal(geoOf('La Legislatura porteña aprobó el presupuesto'), 'caba');
});

test('"Buenos Aires" a secas no alcanza (puede ser la provincia)', () => {
  assert.equal(geoOf('Buenos Aires: suben los impuestos inmobiliarios'), 'argentina');
  assert.equal(geoOf('Kicillof anunció obras en la provincia de Buenos Aires'), 'argentina');
  assert.equal(geoOf('Universidades de Buenos Aires reclaman fondos'), 'argentina');
});

test('subte y líneas A–E/H cuentan como CABA', () => {
  assert.equal(geoOf('Paro en la línea A: cómo funciona el servicio'), 'caba');
  assert.equal(geoOf('Reabrió una estación del subte D'), 'caba');
  // Línea de colectivo con número: no es subte.
  assert.equal(geoOf('Cambia el recorrido de la línea 60'), 'argentina');
});

test('barrios inequívocos alcanzan; los ambiguos necesitan contexto', () => {
  assert.equal(geoOf('Robo en un edificio de Caballito'), 'caba');
  assert.equal(geoOf('Vecinos de Villa Urquiza reclaman por un árbol caído'), 'caba');
  // Martín Palermo (DT) y Manuel Belgrano (prócer) no son barrios.
  assert.equal(geoOf('Martín Palermo habló tras el empate'), 'argentina');
  assert.equal(geoOf('Homenaje a Manuel Belgrano en Rosario'), 'argentina');
  assert.equal(geoOf('Se acerca el retiro de un histórico jugador'), 'argentina');
  // Con contexto, sí.
  assert.equal(geoOf('Inauguran una plaza en el barrio de Palermo'), 'caba');
  assert.equal(geoOf('Demoras en la estación Constitución por obras'), 'caba');
});

test('AMBA: conurbano, partidos y trenes metropolitanos', () => {
  assert.equal(geoOf('Inseguridad en el conurbano: récord de denuncias'), 'amba');
  assert.equal(geoOf('Un vecino de Nordelta fue denunciado'), 'amba');
  assert.equal(geoOf('Choque en La Matanza deja tres heridos'), 'amba');
  assert.equal(geoOf('El tren Sarmiento no funcionará el fin de semana'), 'amba');
  // Homónimos: Lanús con "en", sí; "Avellaneda" en Santa Fe, no.
  assert.equal(geoOf('Detuvieron a un ladrón en Lanús'), 'amba');
  assert.equal(geoOf('Fiesta del algodón en Avellaneda de Santa Fe'), 'argentina');
});

test('CABA y AMBA a la vez: domina la señal más fuerte', () => {
  // Muchas señales de la Ciudad y una de AMBA → CABA.
  assert.equal(
    geoOf('Subte, Policía de la Ciudad y cortes en CABA por el partido', {
      description: 'También habrá controles en la General Paz.',
    }),
    'caba'
  );
  // Parejas → nota metropolitana.
  assert.equal(geoOf('Paro de colectivos en CABA y el conurbano'), 'amba');
});

test('frases neutralizadas: "la Bolsa porteña" no es una noticia de la Ciudad', () => {
  assert.equal(geoOf('Las acciones subieron 5% en la Bolsa porteña'), 'argentina');
  assert.equal(geoOf('Optimismo en la city porteña tras el dato de inflación'), 'argentina');
});

test('sección Ciudades suma, pero no alcanza sola', () => {
  assert.equal(geoOf('Un nuevo paseo para el fin de semana', { feedSection: 'ciudades' }), 'argentina');
  assert.equal(geoOf('Reclamo de vecinos en Floresta', { feedSection: 'ciudades' }), 'caba');
});

test('ubicación: prioriza el lugar del título y lo muestra con tildes', () => {
  const r = classifyGeo(makeItem({
    title: 'Crimen en Tigre: detuvieron a un sospechoso',
    description: 'La causa la investiga una fiscalía de Vicente López.',
  }));
  assert.equal(r.geo, 'amba');
  assert.equal(r.location, 'Tigre');
  assert.equal(classifyGeo(makeItem({ title: 'Choque en el barrio de Nunez' })).location, 'Núñez');
});

test('temas por reglas explícitas y pista de sección', () => {
  assert.deepEqual(classifyTopics(makeItem({ title: 'Paro de subte en la línea B' })), ['transporte']);
  assert.ok(classifyTopics(makeItem({ title: 'Sube el ABL en la Ciudad' })).includes('economia'));
  // "sube" (verbo) no es la tarjeta SUBE.
  assert.ok(!classifyTopics(makeItem({ title: 'El dólar sube otra vez' })).includes('transporte'));
  assert.ok(classifyTopics(makeItem({ title: 'Festival gratis en Parque Centenario' })).includes('agenda'));
  assert.ok(classifyTopics(makeItem({ title: 'Nota sin pistas', feedSection: 'economia' })).includes('economia'));
  // "obras sociales" no es obra pública.
  assert.ok(!classifyTopics(makeItem({ title: 'Las obras sociales suben sus cuotas' })).includes('ciudad'));
});

test('exclusiones: internacional, deportes y estilo de vida quedan fuera', () => {
  assert.equal(classifyItem(makeItem({ url: 'https://www.infobae.com/mexico/2026/10/05/metro', path: '/mexico/2026/10/05/metro', title: 'Metrobús hoy' })), null);
  assert.equal(classifyItem(makeItem({ path: '/deportes/futbol/x', title: 'Partido en el Monumental' })), null);
  assert.equal(classifyItem(makeItem({ title: 'Receta', categories: ['Lifestyle'] })), null);
  assert.ok(classifyItem(makeItem({ path: '/sociedad/x', title: 'Paro de subte' })));
});

// --- Alcance nacional vs. localidades afectadas (it. 13) --------------------------------------

test('nacional con mención incidental de la Ciudad en la bajada: alcance nacional, no CABA ni tema Ciudad', () => {
  const r = classifyItem(makeItem({
    path: '/sociedad/x',
    title: 'Alerta amarilla por vientos y lluvias para el miércoles: las provincias afectadas',
    description: 'El Servicio Meteorológico Nacional emitió avisos; en la Ciudad de Buenos Aires la mínima será de 12°C',
  }));
  assert.equal(r.geo, 'argentina');
  assert.deepEqual(r.affects, []);
  assert.equal(r.location, null);
  assert.ok(!r.topics.includes('ciudad'));
});

test('nacional con impacto explícito en CABA (bajada): alcance nacional y CABA como localidad afectada', () => {
  const r = classifyItem(makeItem({
    path: '/sociedad/x',
    title: 'Alerta naranja por tormentas en las provincias del centro del país',
    description: 'El Servicio Meteorológico Nacional informó que la alerta rige también para la Ciudad de Buenos Aires y el conurbano.',
  }));
  assert.equal(r.geo, 'argentina');
  assert.ok(r.affects.includes('CABA'));
});

test('nacional con CABA en el título: localidad afectada aunque el alcance sea nacional', () => {
  const r = classifyGeo(makeItem({ title: 'Paro de transporte en todo el país: cómo funcionan subtes y colectivos en CABA' }));
  assert.equal(r.geo, 'argentina');
  assert.ok(r.affects.includes('CABA'));
});

test('local sin alcance nacional se conserva: cortes por un partido en Núñez', () => {
  const r = classifyItem(makeItem({
    path: '/sociedad/x',
    title: 'Cómo serán los cortes de calle para el partido en el estadio',
    description: 'Más de mil efectivos de la Policía de la Ciudad desplegarán anillos de contención en el barrio de Núñez',
  }));
  assert.equal(r.geo, 'caba');
  assert.equal(r.location, 'Núñez');
  assert.deepEqual(r.affects, []);
  assert.ok(r.topics.includes('transporte'));
});

test('local con título fuerte y una mención nacional solo en la bajada: sigue siendo local', () => {
  const r = classifyGeo(makeItem({
    title: 'Paro en la línea A del subte: cómo funciona el servicio',
    description: 'La medida se suma a otros reclamos gremiales en el país.',
  }));
  assert.equal(r.geo, 'caba');
});
