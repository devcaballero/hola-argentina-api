/**
 * Reglas explícitas de relevancia local y tema.
 *
 * Todas se evalúan sobre título + bajada + categorías SIN TILDES (ver stripAccents),
 * por eso los patrones se escriben sin acentos. Cada regla suma su peso una sola vez.
 *
 * "Buenos Aires" a secas NO suma: puede ser la provincia. Solo cuentan formas
 * inequívocas (CABA, Capital Federal, Ciudad de Buenos Aires, porteño…), barrios,
 * organismos, transporte y lugares de la Ciudad.
 *
 * Para mantener: agregar entradas a las listas; documentar casos dudosos con un test.
 */

const L = '\\p{L}\\p{N}';

/** Término con bordes de palabra Unicode (\b de JS no entiende tildes/ñ). */
function term(source, flags = '') {
  return new RegExp(`(?<![${L}])(?:${source})(?![${L}])`, `u${flags}`);
}

function anyOf(names) {
  return names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|');
}

// ---------------------------------------------------------------------------
// CABA
// ---------------------------------------------------------------------------

/** Barrios sin otro significado frecuente en medios argentinos. */
const BARRIOS_INEQUIVOCOS = [
  'Almagro', 'Balvanera', 'Barracas', 'Boedo', 'Caballito', 'Coghlan', 'Colegiales',
  'La Boca', 'La Paternal', 'Mataderos', 'Monte Castro', 'Nueva Pompeya',
  'Parque Avellaneda', 'Parque Chacabuco', 'Parque Chas', 'Parque Patricios',
  'Puerto Madero', 'Recoleta', 'San Telmo', 'Villa Crespo', 'Villa del Parque',
  'Villa Devoto', 'Villa General Mitre', 'Villa Lugano', 'Villa Luro', 'Villa Ortuzar',
  'Villa Pueyrredon', 'Villa Riachuelo', 'Villa Santa Rita', 'Villa Soldati',
  'Villa Urquiza', 'Barrio Norte', 'Microcentro', 'Bajo Flores', 'Villa 31',
  'Barrio 31', 'Barrio Mugica', 'Barrio Padre Mugica', 'Rodrigo Bueno',
  'Palermo Soho', 'Palermo Hollywood', 'Palermo Chico',
];

/** Barrios con otro uso posible (palabra común, apellido, club, otra ciudad). */
const BARRIOS_AMBIGUOS_MEDIOS = ['Chacarita', 'Floresta', 'Montserrat', 'Monserrat', 'Versalles', 'Villa Real'];

/**
 * Barrios que solo cuentan con contexto: "barrio de X", "vecinos de X", "estación X"…
 * o "en X" (con peso menor). Ej.: Martín Palermo, Manuel Belgrano, "retiro voluntario".
 */
const BARRIOS_CON_CONTEXTO = [
  'Palermo', 'Belgrano', 'Nunez', 'Saavedra', 'Flores', 'Retiro', 'Constitucion',
  'Once', 'Liniers', 'Abasto', 'Agronomia', 'San Nicolas', 'San Cristobal', 'Pompeya',
  'Velez Sarsfield',
];
/** Subconjunto donde "en X" basta (excluye San Nicolás y San Cristóbal: hay ciudades homónimas). */
const BARRIOS_EN_X = ['Palermo', 'Belgrano', 'Nunez', 'Saavedra', 'Flores', 'Retiro', 'Constitucion', 'Once', 'Liniers', 'Abasto'];

const CONTEXTO_BARRIO = '(?:barrio(?:\\s+porteno)?\\s+de|en\\s+el\\s+barrio\\s+de|vecinos\\s+de|vecinas\\s+de|zona\\s+de|estacion(?:\\s+de)?|terminal\\s+de)\\s+';

const HOSPITALES_CABA = [
  'de Clinicas', 'Argerich', 'Fernandez', 'Durand', 'Pirovano', 'Ramos Mejia',
  'Rivadavia', 'Alvarez', 'Pinero', 'Penna', 'Santojanni', 'Tornu', 'Munoz',
  'Elizalde', 'Gutierrez', 'Garrahan', 'Zubizarreta', 'Velez Sarsfield', 'Moyano',
  'Borda', 'Udaondo', 'Lagleyze', 'Italiano', 'Aleman', 'Britanico',
];

const LUGARES_CABA = [
  'Obelisco', 'Avenida 9 de Julio', 'Av. 9 de Julio', 'Avenida Corrientes',
  'Avenida de Mayo', 'Avenida Santa Fe', 'Avenida Cabildo', 'Costanera Sur',
  'Costanera Norte', 'Reserva Ecologica', 'Jardin Japones', 'Rosedal', 'Planetario',
  'Bosques de Palermo', 'Teatro Colon', 'Usina del Arte', 'Estadio Monumental',
  'Mas Monumental', 'Movistar Arena', 'Luna Park', 'Parque Centenario', 'Parque Lezama',
  'Costa Salguero', 'Aeroparque', 'Autopista 25 de Mayo', 'Autopista Perito Moreno',
  'Autopista Illia', 'Autopista Dellepiane', 'Paseo del Bajo', 'Caminito',
  'Parque de la Ciudad', 'Tecnopolis',
];

/** @type {{ id: string, re: RegExp, weight: number, place?: string }[]} */
const CABA_RULES = [
  { id: 'caba', re: term('CABA'), weight: 3, place: 'CABA' },
  { id: 'capital-federal', re: term('Capital Federal', 'i'), weight: 3, place: 'CABA' },
  { id: 'ciudad-autonoma', re: term('Ciudad Autonoma de Buenos Aires', 'i'), weight: 3, place: 'CABA' },
  { id: 'ciudad-de-ba', re: term('Ciudad de Buenos Aires', 'i'), weight: 3, place: 'CABA' },
  { id: 'porteno', re: term('portenos?|portenas?', 'i'), weight: 3 },
  { id: 'gobierno-ciudad', re: term('Gobierno de la Ciudad|GCBA|GCABA|Jefatura de Gobierno|Jefe de Gobierno|Jorge Macri'), weight: 3 },
  { id: 'legislatura', re: term('Legislatura de la Ciudad|Legislatura portena'), weight: 3 },
  { id: 'policia-ciudad', re: term('Policia de la Ciudad'), weight: 3 },
  { id: 'impuestos-ciudad', re: term('AGIP|ABL'), weight: 3 },
  { id: 'subte', re: term('subtes?|subterraneos?|premetro|Emova|SBASE', 'i'), weight: 3 },
  // Líneas A–E y H en mayúscula: así se nombran las del subte (trenes por nombre, colectivos por número).
  { id: 'linea-subte', re: term('[Ll]inea [ABCDEH]'), weight: 3 },
  { id: 'ecobici', re: term('Ecobici', 'i'), weight: 3 },
  { id: 'metrobus', re: term('Metrobus', 'i'), weight: 2 },
  { id: 'hospital', re: term(`Hospital (?:${anyOf(HOSPITALES_CABA)})`), weight: 3 },
  { id: 'comuna', re: term('Comuna (?:1[0-5]|[1-9])'), weight: 2 },
  { id: 'la-ciudad', re: term('[Ll]a Ciudad(?! de (?!Buenos Aires))'), weight: 1 },
  { id: 'barrio', re: term(anyOf(BARRIOS_INEQUIVOCOS)), weight: 3, place: '$match' },
  { id: 'barrio-ambiguo', re: term(anyOf(BARRIOS_AMBIGUOS_MEDIOS)), weight: 2, place: '$match' },
  {
    id: 'barrio-contexto',
    re: term(`${CONTEXTO_BARRIO}(?:${anyOf(BARRIOS_CON_CONTEXTO)})`),
    weight: 3,
    place: '$last',
  },
  {
    id: 'barrio-en',
    re: term(`en (?:${anyOf(BARRIOS_EN_X)})(?! (?:de|del) (?:Cordoba|Santa Fe|Mendoza|Tucuman))`),
    weight: 2,
    place: '$last',
  },
  { id: 'lugar', re: term(anyOf(LUGARES_CABA)), weight: 2, place: '$match' },
];

/**
 * Frases que contienen una señal local pero no hablan de la Ciudad. Se borran del texto
 * antes de evaluar. Ej.: "la Bolsa porteña" o "la city porteña" son el mercado financiero nacional.
 */
const NEUTRAL_PHRASES = [
  term('(?:[Bb]olsa|[Pp]laza|[Mm]ercado|[Rr]ueda|[Cc]ity|[Bb]olsa de Comercio) portenas?'),
  term('(?:[Bb]olsa|[Pp]laza|[Mm]ercado|[Rr]ueda) portenos?'),
];

// ---------------------------------------------------------------------------
// AMBA (sin CABA): conurbano y Gran La Plata
// ---------------------------------------------------------------------------

/** Partidos/localidades del conurbano sin homónimos relevantes: alcanzan solos. */
const AMBA_INEQUIVOCOS = [
  'La Matanza', 'Lomas de Zamora', 'Almirante Brown', 'Esteban Echeverria',
  'Florencio Varela', 'Berazategui', 'Hurlingham', 'Jose C. Paz', 'Nordelta',
  'San Justo', 'Castelar', 'Haedo', 'Temperley', 'Adrogue', 'Ciudadela',
  'Villa Ballester', 'Boulogne', 'Don Torcuato', 'Monte Grande', 'Laferrere',
  'Gonzalez Catan', 'Isidro Casanova', 'Ciudad Evita', 'Lomas del Mirador',
  'Villa Celina', 'Tortuguitas', 'General Pacheco', 'Ingeniero Maschwitz',
  'Punta Lara', 'Berisso', 'Marcos Paz', 'General Rodriguez', 'Canuelas',
  'Rafael Calzada', 'Claypole', 'Burzaco', 'Vicente Lopez', 'San Isidro',
];

/**
 * Partidos con homónimos (club, ciudad de otra provincia, apellido): suman 2 y llegan
 * al umbral con contexto ("en Lanús", "partido de…") u otra señal.
 */
const AMBA_HOMONIMOS = [
  'Lanus', 'Quilmes', 'Avellaneda', 'Merlo', 'Ituzaingo', 'Ezeiza', 'San Fernando',
  'Tigre', 'La Plata', 'Ensenada', 'Moron', 'Bernal', 'Wilde', 'Sarandi', 'Caseros',
  'Benavidez',
];

/** Requieren "partido/municipio/intendente de X" (apellidos, provincias o islas homónimas). */
const AMBA_CON_CONTEXTO = [
  'Moreno', 'San Martin', 'General San Martin', 'San Miguel', 'Pilar', 'Escobar',
  'Malvinas Argentinas', 'Tres de Febrero', 'Lujan', 'Presidente Peron',
];

const AMBA_RULES = [
  { id: 'amba', re: term('AMBA|GBA|conurbano|Gran Buenos Aires|[Aa]rea [Mm]etropolitana|(?:primer|segundo|tercer) cordon'), weight: 3, place: 'AMBA' },
  { id: 'partido', re: term(anyOf(AMBA_INEQUIVOCOS)), weight: 3, place: '$match' },
  { id: 'partido-homonimo', re: term(anyOf(AMBA_HOMONIMOS)), weight: 2, place: '$match' },
  { id: 'partido-en', re: term(`en (?:${anyOf(AMBA_HOMONIMOS)})(?! (?:de|del) (?:Santa Fe|San Luis|Cordoba|Entre Rios|Corrientes|Catamarca))`), weight: 1 },
  { id: 'tres-de-febrero', re: term('(?<!Parque )Tres de Febrero'), weight: 2, place: 'Tres de Febrero' },
  {
    id: 'partido-contexto',
    re: term(`(?:partido|municipio|intendente|intendenta|localidad)\\s+de\\s+(?:${anyOf([...AMBA_INEQUIVOCOS, ...AMBA_HOMONIMOS, ...AMBA_CON_CONTEXTO])})`),
    weight: 3,
    place: '$last',
  },
  { id: 'ramos-mejia', re: term('(?<!Hospital )Ramos Mejia'), weight: 2, place: 'Ramos Mejía' },
  { id: 'trenes', re: term('(?:[Ll]inea|tren|trenes|ramal) (?:Mitre|Sarmiento|Roca|San Martin|Belgrano Sur|Belgrano Norte|Urquiza)|Tren de la Costa'), weight: 3 },
  { id: 'accesos', re: term('General Paz|Panamericana|Acceso Oeste|Acceso Norte|Riccheri|Ricchieri|Camino de Cintura|Puente (?:Pueyrredon|La Noria|Alsina|Saavedra)'), weight: 2 },
  { id: 'servicios', re: term('AySA|Edenor|Edesur|ACUMAR|CEAMSE|Riachuelo|Mercado Central'), weight: 2 },
  { id: 'colectivos', re: term('colectivos?', 'i'), weight: 1 },
  // Siglas en mayúscula: con flag i, "SUBE" chocaría con el verbo "sube".
  { id: 'sube-uta', re: term('UTA|SUBE'), weight: 1 },
];

/**
 * Señales de provincia (no AMBA por sí solas): evitan leer "Buenos Aires" como CABA.
 * No suman a ningún puntaje local; se informan en `signals` para auditoría.
 */
const PROVINCIA_RULES = [
  { id: 'provincia', re: term('[Pp]rovincia de Buenos Aires|bonaerenses?|PBA|Kicillof'), weight: 0 },
];

// ---------------------------------------------------------------------------
// Alcance nacional e impacto explícito
// ---------------------------------------------------------------------------

/**
 * Señales de que la nota es de alcance nacional (no local), aunque mencione la Ciudad.
 * Ej.: "las provincias afectadas", "en todo el país", "Servicio Meteorológico Nacional".
 */
const NATIONAL_SCOPE_RULES = [
  { id: 'provincias', re: term('(?:las|varias|otras|\\d+|diez|nueve|ocho|siete|seis|cinco|cuatro|tres) provincias|provincias (?:afectadas|del pais|argentinas)'), weight: 1 },
  { id: 'todo-el-pais', re: term('todo el pais|en el pais|a nivel nacional|interior del pais|resto del pais|todo el territorio', 'i'), weight: 1 },
  { id: 'smn', re: term('Servicio Meteorologico Nacional|SMN'), weight: 1 },
];

/**
 * Impacto explícito sobre una localidad: la mención y uno de estos verbos/expresiones deben estar
 * en la misma oración de la bajada (o la localidad en el título). Sin esto la mención es incidental.
 */
const IMPACT_CONTEXT = term('rige|regira|rigen|alcanza|alcanzara|alcanzan|afecta|afectara|afectan|afectada|afectadas|afectados|incluye|incluira|alerta (?:amarilla|naranja|roja) para|cortes?|paro|paros|suspend\\p{L}*|cerrad[oa]s?|interrump\\p{L}*|evacu\\p{L}*|emergencia|inund\\p{L}*|anegamientos?|sin (?:luz|agua|servicio)', 'i');

// ---------------------------------------------------------------------------
// Exclusiones (fuera de alcance de "Hoy en Buenos Aires")
// ---------------------------------------------------------------------------

/** Primer segmento del path del link. Internacional, deportes, espectáculos, estilo de vida. */
const EXCLUDED_PATH_SECTIONS = new Set([
  'mundo', 'el-mundo', 'internacional', 'estados-unidos', 'america', 'colombia',
  'mexico', 'peru', 'espana', 'venezuela', 'chile', 'uruguay', 'deportes',
  'espectaculos', 'teleshow', 'show', 'revista-hola', 'lifestyle', 'buena-vida',
  'viva', 'cocina', 'autos', 'tecno', 'tecnologia', 'tendencias', 'videos',
  'horoscopo', 'juegos', 'moda-y-belleza', 'que-puedo-ver', 'musica', 'podcasts',
  'viajes', 'turismo', 'revista-enie', 'br', 'arq', 'rural',
]);

/** Categorías RSS (sin tildes, minúsculas) que también excluyen. */
const EXCLUDED_CATEGORIES = new Set([
  'futbol', 'deportes', 'lifestyle', 'personajes', 'espectaculos', 'el mundo',
  'estados unidos', 'autos', 'moda y belleza', 'horoscopo',
]);

// ---------------------------------------------------------------------------
// Temas
// ---------------------------------------------------------------------------

/**
 * Coincidencia en el título = 2 puntos; en bajada/categorías = 1 (por tema, no por patrón).
 * Se asigna el tema con >= 2.
 * `sections`: pista de sección del feed o del path (suma 2).
 */
const TOPIC_RULES = {
  transporte: {
    label: 'Transporte',
    sections: [],
    patterns: [
      term('subtes?|subterraneos?|premetro|colectivos?|trenes|tren|ferrocarril(?:es)?|boletos?|peajes?|autopistas?|transito|cortes? de (?:calles?|transito)|Ecobici|Metrobus|taxis?|Uber|Aeroparque|vuelos?|aerolineas?|Flybondi|La Fraternidad|ciclovias?', 'i'),
      term('SUBE|UTA|[Ll]inea [ABCDEH]'),
    ],
  },
  ciudad: {
    label: 'Ciudad',
    sections: ['ciudades'],
    patterns: [
      term('obras(?! sociales)|vecinos|vecinas|barrios?|basura|recoleccion|residuos|limpieza|espacio publico|plazas?|parques?|arbolado|edificios?|Codigo Urbanistico|construccion|inundaci\\p{L}*|anegamientos?|tormentas?|lluvias?|llover|pronostico|alerta (?:amarilla|naranja|roja|meteorologica)|ola de calor|cortes? de (?:luz|agua)|apagon(?:es)?|Legislatura|hospital(?:es)?|escuelas?|bacheo|veredas|cuidacoches|trapitos|situacion de calle|Policia de la Ciudad|Gobierno de la Ciudad|Jorge Macri', 'i'),
      term('AySA|Edesur|Edenor'),
    ],
  },
  economia: {
    label: 'Economía',
    sections: ['economia'],
    patterns: [
      term('dolar(?:es)?|inflacion|precios?|salarios?|sueldos?|paritarias?|Banco Central|impuestos?|tarifas?|aumentos?|alquiler(?:es)?|comercios?|ventas|consumo|empleo|desempleo|jubilacion(?:es)?|jubilados|concurso de acreedores|quiebra|deuda|bonos|riesgo pais|Caputo|economia', 'i'),
      term('IPC|BCRA|ABL|AGIP|FMI'),
    ],
  },
  agenda: {
    label: 'Agenda',
    sections: [],
    patterns: [
      term('agenda|que hacer|festival(?:es)?|ferias?|exposicion(?:es)?|recitales?|conciertos?|shows?|teatros?|museos?|entradas|gratis|gratuit[oa]s?|fin de semana|finde|visitas? guiadas?|maraton|Noche de los Museos|BAFICI|Tango BA|Feria del Libro|Gallery Nights', 'i'),
      term('\\d+K'),
    ],
  },
};

const TOPIC_IDS = Object.keys(TOPIC_RULES);

module.exports = {
  NATIONAL_SCOPE_RULES,
  IMPACT_CONTEXT,
  NEUTRAL_PHRASES,
  CABA_RULES,
  AMBA_RULES,
  PROVINCIA_RULES,
  EXCLUDED_PATH_SECTIONS,
  EXCLUDED_CATEGORIES,
  TOPIC_RULES,
  TOPIC_IDS,
  term,
};
