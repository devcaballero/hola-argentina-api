# hola-argentina-api

API Node/Express que alimenta **Hola Argentina** (`hola-argentina-front`).

Expone cotizaciones, IPC INDEC, tasas BCRA, clima y precios varios bajo `/api/v1`.

> Antes se llamaba `price-webscraper`. Repo: [devcaballero/hola-argentina-api](https://github.com/devcaballero/hola-argentina-api).

## Requisitos

- Node.js 18+ (recomendado)

## Cómo correr

```bash
npm install
npm start
```

Por defecto escucha en el puerto **3000** (`PORT` opcional):

```bash
PORT=3000 npm start
```

Helper local (mata procesos en 3000/3001 y arranca):

```bash
./start-local.sh
```

Health check rápido:

```bash
curl http://localhost:3000/api/v1/dolar-blue
curl http://localhost:3000/api/v1/temperatura
curl http://localhost:3000/api/v1/bitcoin
```

## Endpoints principales (UI)

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/api/v1/dolar-oficial` | Spot + variación + historial 7 días |
| GET | `/api/v1/dolar-blue` | Idem blue |
| GET | `/api/v1/bitcoin` | Spot USD + variación + historial 7 días |
| GET | `/api/v1/oro` | Onza USD + variación + historial 7 días |
| GET | `/api/v1/inflacion-mensual` | IPC mensual + período + historial 6 meses |
| GET | `/api/v1/inflacion-anualizada` | IPC interanual + período |
| GET | `/api/v1/tasa-bcra` | BADLAR/TPM + historial mensual 6 meses |
| GET | `/api/v1/riesgo-pais` | EMBI+ (pb) + variación + historial 7 días |
| GET | `/api/v1/temperatura` | Clima BA + forecast 7 días (condición, viento, humedad, salida/puesta) |
| GET | `/api/v1/minimo-sube` | Tarifa mínima AMBA |
| GET | `/api/v1/nafta-super` | Nafta súper |
| GET | `/api/v1/promedio-precio-asado` | Asado $/kg |
| GET | `/api/v1/promedio-precio-pan` | Pan $/kg |
| GET | `/api/v1/bigmac` | Big Mac ARS |

Hay endpoints legacy adicionales (Fernet, Heineken, etc.) que el front actual puede no mostrar.

## Fuentes (resumen)

- Dólar: [dolarapi.com](https://dolarapi.com) + historial [ArgentinaDatos](https://api.argentinadatos.com)
- Bitcoin: [CoinGecko](https://www.coingecko.com/en/api) → [Binance](https://api.binance.com) / [Binance Vision](https://data-api.binance.vision) → [Coinbase](https://api.exchange.coinbase.com) → [Kraken](https://api.kraken.com) (varios clientes HTTP; típico fallo en Render)
- Oro: [goldprice.dev](https://goldprice.dev) spot + barras diarias
- Inflación: [apis.datos.gob.ar](https://apis.datos.gob.ar) (IPC nacional)
- Tasa: [API BCRA v4](https://api.bcra.gob.ar) monetarias — BADLAR → TPM
- Riesgo país: [ArgentinaDatos](https://api.argentinadatos.com) EMBI+ (serie → último)
- Clima (en paralelo; se prefiere forecast de 7 días):
  1. [Open-Meteo](https://open-meteo.com) (varios transportes / IPv4)
  2. [Met.no](https://api.met.no) locationforecast (rescate 7 días)
  3. [wttr.in](https://wttr.in) (~3 días) — si queda como base, se extiende con Met.no/OM
  - Si faltan salida/puesta (Met.no no las trae; wttr solo ~3 días), se completan con cálculo local NOAA para CABA (UTC−3)
- Big Mac: [bigmacindex.com](https://bigmacindex.com) → CSV [The Economist](https://github.com/TheEconomist/big-mac-data)

Varias respuestas se cachean en memoria (dólar ~1h, BTC ~15m, oro ~30m, IPC ~6h, riesgo país ~1h) para no martillar las fuentes.

## Fallbacks

Helper reutilizable en `lib/fallbacks.js`:

- `withFallbacks(sources, { label })` — cadena secuencial (primera fuente válida gana). Usado en Bitcoin, Big Mac, tasa BCRA y riesgo país.
- `collectFromSources(sources, { label })` — acumula las que respondan (promedios asado/pan).

Clima usa `Promise.allSettled` propio (Open-Meteo / Met.no / wttr) más `ensureForecastSunTimes` para astronomía.

Para agregar una alternativa a un endpoint nuevo: definir `{ name, fetch }` y pasarlo a `withFallbacks`.

## Gitflow

- **Features:** salen de `develop` → PR a `develop` → release PR `develop` → `main`
- **Fixes:** salen de `main` → PR a `main` → backport/PR a `develop`

## Deploy

Prod en Render (hostname actual del servicio): `https://price-webscraper.onrender.com`.

El servicio en Render todavía puede llamarse `price-webscraper`; renombrarlo en el dashboard (y el subdomain) es opcional y aparte del rename del repo.

Tras merges a `main`, a veces hace falta **redeploy manual** en Render.

El front de producción apunta a `…/api/v1` vía `environment.prod.ts`.

## CORS

`cors()` está habilitado de forma global para el front en local (`localhost:4200`) y en hosting.

## Relación con el front

```
hola-argentina-front  →  GET /api/v1/*
hola-argentina-api    →  scrapers / APIs públicas
```

Sin este servicio, el panel no tiene datos.
