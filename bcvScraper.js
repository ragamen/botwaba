'use strict';
/**
 * bcvScraper.js — Scraper de tasa BCV (Banco Central de Venezuela)
 * Fuente: https://www.bcv.org.ve/
 * Cache: Redis 30 minutos + BD public.tasas_cambio
 */

const https = require('https');

const CACHE_KEY = 'bcv:tasa_dolar';
const CACHE_TTL = 1800; // 30 minutos
const BCV_HOST  = 'www.bcv.org.ve';
const BCV_PATH  = '/';

let redisClientRef = null;
let pgPoolRef = null;

function setRedisClient(client) {
  redisClientRef = client;
}

function setPgPool(pool) {
  pgPoolRef = pool;
}

/**
 * Scrapea la tasa del dólar desde el BCV usando https.get
 * El BCV publica: <strong class="strong-tb">721,34560000</strong>
 * Formato europeo: coma como decimal, sin separador de miles
 */
async function scrapeTasaBCV() {
  return new Promise((resolve) => {
    const options = {
      hostname: BCV_HOST,
      path: BCV_PATH,
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 15000
    };

    https.get(options, (res) => {
      let html = '';
      res.on('data', (chunk) => { html += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            throw new Error('BCV respondió HTTP ' + res.statusCode);
          }

          // Buscar la sección id="dolar" y extraer el <strong> dentro de ella
          // El BCV publica múltiples monedas (EUR, CNY, TRY, RUB, USD) cada una en su div
          // USD está en: <div id="dolar"> ... <strong class="strong-tb">721,34560000</strong>
          const dolarIdx = html.indexOf('id="dolar"');
          if (dolarIdx === -1) {
            throw new Error('No se encontró sección id="dolar" en BCV');
          }
          const dolarSection = html.substring(dolarIdx, dolarIdx + 800);
          const match = dolarSection.match(/<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i);

          if (!match || !match[1]) {
            throw new Error('No se encontró <strong> con valor del USD en sección dolar');
          }

          // Formato BCV: "721,34560000" → 721.3456
          // La coma es el separador decimal, no hay separador de miles
          const rawValue = match[1].replace(',', '.');
          const rate = parseFloat(rawValue);

          if (isNaN(rate) || rate < 1) {
            throw new Error('Tasa BCV inválida: "' + match[1] + '"');
          }

          console.log('[BCV] ✅ Tasa scrapeada: ' + rate + ' Bs/$');

          // Guardar en BD
          if (pgPoolRef) {
            pgPoolRef.query(
              "INSERT INTO public.tasas_cambio (codigo_divisa, monto_tasa, fecha_vigencia) VALUES ('VES', $1, CURRENT_DATE) ON CONFLICT (codigo_divisa, fecha_vigencia) DO UPDATE SET monto_tasa = EXCLUDED.monto_tasa",
              [rate]
            ).then(() => {
              console.log('[BCV] 💾 Tasa guardada en BD');
            }).catch((e) => {
              console.warn('[BCV] ⚠️ Error guardando en BD:', e.message);
            });
          }

          resolve(rate);
        } catch (err) {
          console.error('[BCV] ❌ Error parseando:', err.message);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('[BCV] ❌ Error de conexión:', err.message);
      resolve(null);
    }).on('timeout', function() {
      console.error('[BCV] ❌ Timeout scraping BCV');
      this.destroy();
      resolve(null);
    });
  });
}

/**
 * Obtiene la tasa BCV con cache Redis → BD → scrape.
 * @returns {Promise<number>} tasa Bs/$
 */
async function getTasaBCV() {
  // 1. Intentar desde Redis
  if (redisClientRef) {
    try {
      const cached = await redisClientRef.get(CACHE_KEY);
      if (cached) {
        const rate = parseFloat(cached);
        if (!isNaN(rate) && rate > 1) {
          console.log('[BCV] ⚡ Tasa desde caché Redis: ' + rate + ' Bs/$');
          return rate;
        }
      }
    } catch (err) {
      console.warn('[BCV] ⚠️ Error leyendo caché Redis:', err.message);
    }
  }

  // 2. Scrapear
  let rate = await scrapeTasaBCV();

  // 3. Si el scrape falla, intentar desde BD (última tasa guardada)
  if (!rate && pgPoolRef) {
    try {
      const { rows } = await pgPoolRef.query(
        "SELECT monto_tasa FROM public.tasas_cambio WHERE codigo_divisa = 'VES' ORDER BY fecha_vigencia DESC LIMIT 1"
      );
      if (rows[0]) {
        rate = parseFloat(rows[0].monto_tasa);
        console.log('[BCV] 💾 Tasa desde BD: ' + rate + ' Bs/$');
      }
    } catch (e) {
      console.warn('[BCV] ⚠️ Error leyendo desde BD:', e.message);
    }
  }

  // 4. Fallback final
  if (!rate) {
    console.warn('[BCV] ⚠️ Sin tasa disponible. Usando última conocida o 0.');
    return 0;
  }

  // 5. Guardar en Redis
  if (redisClientRef && rate) {
    try {
      await redisClientRef.set(CACHE_KEY, rate.toString(), { EX: CACHE_TTL });
      console.log('[BCV] 💾 Tasa guardada en Redis por ' + (CACHE_TTL / 60) + ' minutos');
    } catch (err) {
      console.warn('[BCV] ⚠️ Error guardando en Redis:', err.message);
    }
  }

  return rate;
}

async function invalidateBCVCache() {
  if (redisClientRef) {
    try {
      await redisClientRef.del(CACHE_KEY);
      console.log('[BCV] 🗑️ Cache de tasa BCV invalidado');
    } catch (err) {
      console.warn('[BCV] ⚠️ Error invalidando cache:', err.message);
    }
  }
}

module.exports = { getTasaBCV, invalidateBCVCache, setRedisClient, setPgPool };