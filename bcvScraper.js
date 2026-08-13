'use strict';
/**
 * bcvScraper.js — Scraper de tasa BCV (Banco Central de Venezuela)
 * Fuente: https://www.bcv.org.ve/
 * Cache: Redis 30 minutos
 */

const CACHE_KEY = 'bcv:tasa_dolar';
const CACHE_TTL = 1800; // 30 minutos
const BCV_URL   = 'https://www.bcv.org.ve/';

let redisClientRef = null;

function setRedisClient(client) {
  redisClientRef = client;
}

/**
 * Scrapea la tasa del dólar desde el BCV.
 * El elemento HTML es: #dolar > strong (o similar)
 * @returns {Promise<number>} tasa como número flotante
 */
async function scrapeTasaBCV() {
  try {
    const response = await fetch(BCV_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BotWabaBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`BCV respondió HTTP ${response.status}`);
    }

    const html = await response.text();

    // El BCV publica: <div id="dolar"> ... <strong>43,21</strong>
    // También puede ser formato: 43.21 o 43,21
    const match = html.match(/id="dolar"[\s\S]{0,500}?<strong>([\d.,]+)<\/strong>/i)
      || html.match(/<strong>([\d]{2,3}[.,]\d{1,6})<\/strong>/);

    if (!match || !match[1]) {
      throw new Error('No se encontró el valor del dólar en el HTML del BCV');
    }

    // Normalizar: "43,21" → 43.21
    const rawValue = match[1].replace(/\./g, '').replace(',', '.');
    const rate = parseFloat(rawValue);

    if (isNaN(rate) || rate < 1) {
      throw new Error(`Tasa BCV inválida: "${match[1]}"`);
    }

    console.log(`[BCV] ✅ Tasa scrapeada: ${rate} Bs/$`);
    return rate;
  } catch (err) {
    console.error('[BCV] ❌ Error al scrapear tasa:', err.message);
    return null;
  }
}

/**
 * Obtiene la tasa BCV con cache Redis.
 * Si Redis falla o no hay cache, scrapea directamente.
 * @returns {Promise<number>} tasa Bs/$
 */
async function getTasaBCV() {
  // 1. Intentar desde Redis
  if (redisClientRef) {
    try {
      const cached = await redisClientRef.get(CACHE_KEY);
      if (cached) {
        const rate = parseFloat(cached);
        console.log(`[BCV] ⚡ Tasa desde caché Redis: ${rate} Bs/$`);
        return rate;
      }
    } catch (err) {
      console.warn('[BCV] ⚠️ Error leyendo caché Redis:', err.message);
    }
  }

  // 2. Scrapear
  const rate = await scrapeTasaBCV();
  if (!rate) {
    // Fallback: retornar una tasa aproximada hardcoded si todo falla
    console.warn('[BCV] ⚠️ Usando tasa de fallback: 50.00 Bs/$');
    return 50.00;
  }

  // 3. Guardar en Redis
  if (redisClientRef && rate) {
    try {
      await redisClientRef.set(CACHE_KEY, rate.toString(), { EX: CACHE_TTL });
      console.log(`[BCV] 💾 Tasa guardada en Redis por ${CACHE_TTL / 60} minutos`);
    } catch (err) {
      console.warn('[BCV] ⚠️ Error guardando en Redis:', err.message);
    }
  }

  return rate;
}

/**
 * Invalida el cache de tasa BCV (útil si el admin quiere forzar refresh)
 */
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

module.exports = { getTasaBCV, invalidateBCVCache, setRedisClient };
