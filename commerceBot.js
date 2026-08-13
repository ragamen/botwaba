'use strict';
/**
 * commerceBot.js — State Machine de Ventas WhatsApp (Adaptativo)
 * 
 * Estados: IDLE → SEARCHING (hardware) / SELECTING (food/retail)
 *   → QUANTITY → EXTRAS (si hay extras) → DELIVERY_TYPE → ADDRESS_INPUT
 *   → PAYMENT_INFO → WAITING_PROOF → ORDER_CONFIRMED
 * 
 * Modos de negocio (heurística en business_nature):
 *   food:     Menú texto formateado, sin imágenes (texto vende más)
 *   retail:   Menú texto → imagen del producto al seleccionar
 *   hardware: Diálogo + búsqueda ILIKE de productos
 * 
 * Extras: productos con category='Extra'/'Agregado'/'Adicional'
 *   Se ofrecen después de elegir producto base y cantidad.
 *   El cliente puede agregar varios extras antes de continuar.
 * 
 * Sesión en botwaba.commerce_sessions | Productos en meta_saas.catalog_products
 * Tasa BCV vía bcvScraper.js
 */

const { getTasaBCV, setRedisClient } = require('./bcvScraper');

// ── Palabras clave que inician el flujo de compra ──────────────────────────
const TRIGGER_WORDS = [
  'menu', 'menú', 'hola', 'buenas', 'pedido', 'quiero', 'comprar',
  'catalogo', 'catálogo', 'ver', 'inicio', 'start',
  'necesito', 'busco', 'tienen', 'productos'
];

const CANCEL_WORDS = ['cancelar', 'cancel', 'salir', 'exit', 'no', 'stop'];

// ── Categorías que se consideran extras/adicionales ───────────────────────
const EXTRA_CATEGORIES = ['extra', 'agregado', 'adicional', 'topping', 'complemento'];

// ── Banco codes Venezuela ─────────────────────────────────────────────────
const BANK_NAMES = {
  '0102': 'Banco de Venezuela', '0104': 'Venezolano de Crédito',
  '0105': 'Banco Mercantil',   '0108': 'Banco Provincial (BBVA)',
  '0114': 'Bancaribe',         '0115': 'Banco Exterior',
  '0116': 'Banco Occidental de Descuento (BOD)',
  '0128': 'Banco Caroní',      '0134': 'Banesco',
  '0137': 'Banco Sofitasa',    '0138': 'Banco Federal',
  '0146': 'Banco de la Gente Emprendedora (BanGente)',
  '0151': 'BFC Banco Fondo Común', '0156': '100% Banco',
  '0157': 'DelSur Banco Universal', '0163': 'Banco del Tesoro',
  '0166': 'Banco Agrícola de Venezuela', '0168': 'Bancrecer',
  '0169': 'Mi Banco', '0171': 'Banco Activo',
  '0172': 'Bancamiga', '0173': 'Banco Internacional de Desarrollo (BID)',
  '0174': 'Banplus', '0175': 'Banco Bicentenario',
  '0177': 'Banco de la Fuerza Armada Nacional (BANFANB)',
  '0178': 'N58 Banco Digital', '0191': 'Banco Nacional de Crédito (BNC)',
  '0601': 'Instituto Municipal de Crédito Popular (IMCP)',
};

function getBankName(code) {
  if (!code) return '';
  const key = String(code).replace(/[^0-9]/g, '').padStart(4, '0');
  return BANK_NAMES[key] ? `${BANK_NAMES[key]} (${key})` : code;
}

// ── Utilidades ─────────────────────────────────────────────────────────────

function normalizeText(text) {
  return String(text || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isTrigger(text) {
  const n = normalizeText(text);
  return TRIGGER_WORDS.some(w => n === w || n.startsWith(w));
}

function isCancel(text) {
  return CANCEL_WORDS.some(w => normalizeText(text) === w);
}

function extractNumber(text) {
  if (!text) return NaN;
  const m = String(text).match(/\d+/);
  return m ? parseInt(m[0]) : NaN;
}

function safeJsonParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    if (val === '') return fallback;
    try { return JSON.parse(val); } catch(e) { return fallback; }
  }
  return fallback;
}

function formatPrice(usd) {
  return `$${parseFloat(usd).toFixed(2)}`;
}

function formatBs(usd, rate) {
  return `Bs. ${(parseFloat(usd) * rate).toFixed(2)}`;
}

function isExtraCategory(category) {
  const c = normalizeText(category);
  return EXTRA_CATEGORIES.some(e => c === e || c.startsWith(e));
}

// ── Clasificar tipo de negocio por heurística ──────────────────────────────
function classifyBusiness(businessNature) {
  const n = normalizeText(businessNature || '');
  if (/(hamburguesa|pizza|comida|restaurante|food|menu|menú|arepa|empanada|perro|patac[oó]n|caf[eé]|panader[ií]a|carnicer[ií]a|bodega|postre|pasteler[ií]a|sushi|pollo|parrilla|sopa|mercadito|loncher[ií]a|desayuno|almuerzo|cena|snack)/.test(n)) return 'food';
  if (/(ferreter[ií]a|hardware|herramienta|tornillo|cemento|construcci[oó]n|plomer[ií]a|el[eé]ctrico|pintura|soldadura|acero|madera|bloque|granz[oó]n)/.test(n)) return 'hardware';
  if (/(franela|camisa|zapato|pantal[oó]n|ropa|tienda|store|boutique|calzado|moda|accesorio|bolso|vestido|abrigo|chaqueta|jean|tenis|sandalia|joyer[ií]a|reloj|gafas|sombrero|gorra)/.test(n)) return 'retail';
  return 'food';
}

// ── Emojis por tipo de negocio ─────────────────────────────────────────────
const BUSINESS_EMOJI = { food: '🍽️', retail: '🛍️', hardware: '🔧' };

// ── Obtener productos base (excluye extras) ─────────────────────────────────
async function getBaseProducts(pgPool, supabaseMeta, catalogId) {
  try {
    if (pgPool) {
      const { rows } = await pgPool.query(
        `SELECT id, retailer_id, title, description, price, currency, image_url, availability, category
         FROM meta_saas.catalog_products
         WHERE catalog_id = $1 AND availability = 'in stock'
           AND (category IS NULL OR category = ''
                OR (category NOT ILIKE 'Extra' AND category NOT ILIKE 'Agregado'
                    AND category NOT ILIKE 'Adicional' AND category NOT ILIKE 'Topping'
                    AND category NOT ILIKE 'Complemento'))
         ORDER BY id ASC`,
        [catalogId]
      );
      return rows;
    } else {
      const { data } = await supabaseMeta
        .from('catalog_products')
        .select('id, retailer_id, title, description, price, currency, image_url, availability, category')
        .eq('catalog_id', catalogId)
        .eq('availability', 'in stock')
        .order('id', { ascending: true });
      return (data || []).filter(p => !isExtraCategory(p.category));
    }
  } catch (err) {
    console.error('[COMMERCE] ❌ Error cargando productos base:', err.message);
    return [];
  }
}

// ── Obtener extras/adicionales ─────────────────────────────────────────────
async function getExtraProducts(pgPool, supabaseMeta, catalogId) {
  try {
    if (pgPool) {
      const { rows } = await pgPool.query(
        `SELECT id, retailer_id, title, description, price, currency, image_url, availability, category
         FROM meta_saas.catalog_products
         WHERE catalog_id = $1 AND availability = 'in stock'
           AND (category ILIKE 'Extra' OR category ILIKE 'Agregado'
                OR category ILIKE 'Adicional' OR category ILIKE 'Topping'
                OR category ILIKE 'Complemento')
         ORDER BY id ASC`,
        [catalogId]
      );
      return rows;
    } else {
      const { data } = await supabaseMeta
        .from('catalog_products')
        .select('id, retailer_id, title, description, price, currency, image_url, availability, category')
        .eq('catalog_id', catalogId)
        .eq('availability', 'in stock')
        .order('id', { ascending: true });
      return (data || []).filter(p => isExtraCategory(p.category));
    }
  } catch (err) {
    console.error('[COMMERCE] ❌ Error cargando extras:', err.message);
    return [];
  }
}

// ── Buscar productos por palabra (ILIKE) — para ferretería ─────────────────
async function searchProducts(pgPool, catalogId, query) {
  try {
    if (pgPool) {
      const { rows } = await pgPool.query(
        `SELECT id, retailer_id, title, description, price, currency, image_url, availability, category
         FROM meta_saas.catalog_products
         WHERE catalog_id = $1 AND availability = 'in stock'
           AND (title ILIKE $2 OR description ILIKE $2)
           AND (category IS NULL OR category = ''
                OR (category NOT ILIKE 'Extra' AND category NOT ILIKE 'Agregado'
                    AND category NOT ILIKE 'Adicional'))
         ORDER BY id ASC LIMIT 10`,
        [catalogId, `%${query}%`]
      );
      return rows;
    }
    return [];
  } catch (err) {
    console.error('[COMMERCE] ❌ Error buscando productos:', err.message);
    return [];
  }
}

// ── CRUD de sesiones ───────────────────────────────────────────────────────
async function getSession(pgPool, supabaseMeta, inbox_id, customer_phone) {
  try {
    if (pgPool) {
      const { rows } = await pgPool.query(
        `SELECT * FROM botwaba.commerce_sessions WHERE inbox_id=$1 AND customer_phone=$2 LIMIT 1`,
        [inbox_id, customer_phone]
      );
      return rows[0] || null;
    } else {
      const { data } = await supabaseMeta.schema('botwaba')
        .from('commerce_sessions')
        .select('*').eq('inbox_id', inbox_id).eq('customer_phone', customer_phone)
        .maybeSingle();
      return data;
    }
  } catch (err) {
    console.error('[COMMERCE] ❌ getSession error:', err.message);
    return null;
  }
}

async function upsertSession(pgPool, supabaseMeta, inbox_id, customer_phone, updates) {
  try {
    if (pgPool) {
      const sets = Object.keys(updates).map((k, i) => `${k}=$${i + 3}`).join(', ');
      const vals = Object.values(updates);
      await pgPool.query(
        `INSERT INTO botwaba.commerce_sessions (inbox_id, customer_phone, ${Object.keys(updates).join(', ')})
         VALUES ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(', ')})
         ON CONFLICT (inbox_id, customer_phone)
         DO UPDATE SET ${sets}, updated_at=NOW()`,
        [inbox_id, customer_phone, ...vals]
      );
    }
  } catch (err) {
    console.error('[COMMERCE] ❌ upsertSession error:', err.message);
  }
}

async function deleteSession(pgPool, inbox_id, customer_phone) {
  try {
    if (pgPool) {
      await pgPool.query(
        `DELETE FROM botwaba.commerce_sessions WHERE inbox_id=$1 AND customer_phone=$2`,
        [inbox_id, customer_phone]
      );
    }
  } catch (err) {
    console.error('[COMMERCE] ❌ deleteSession error:', err.message);
  }
}

// ── Crear pedido finalizado ────────────────────────────────────────────────
async function createOrder(pgPool, session, botConfig) {
  try {
    const { inbox_id, customer_phone, cart, delivery_type, delivery_address,
            order_total_usd, bcv_rate, proof_media_url } = session;

    const deliveryFee = delivery_type === 'delivery'
      ? parseFloat(botConfig.commerceSettings?.delivery_fee || 0)
      : 0;
    const totalUsd = parseFloat(order_total_usd) + deliveryFee;
    const totalBs  = totalUsd * parseFloat(bcv_rate || 0);

    const { rows: seqRows } = await pgPool.query(
      `SELECT nextval('botwaba.pedidos_order_seq') AS seq`
    );
    const orderNumber = `ORD-${String(seqRows[0].seq).padStart(4, '0')}`;

    const paymentInfo = botConfig.paymentPagoMovil || {};

    await pgPool.query(
      `INSERT INTO botwaba.pedidos
        (order_number, inbox_id, customer_phone, items, subtotal_usd, delivery_fee_usd,
         total_usd, total_bs, bcv_rate, delivery_type, delivery_address,
         payment_info, proof_media_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')`,
      [orderNumber, inbox_id, customer_phone,
       JSON.stringify(cart), parseFloat(order_total_usd), deliveryFee,
       totalUsd, totalBs, parseFloat(bcv_rate || 0),
       delivery_type, delivery_address || null,
       JSON.stringify(paymentInfo), proof_media_url || null]
    );

    console.log(`[COMMERCE] 🛒 Pedido creado: ${orderNumber} — ${customer_phone}`);
    return { orderNumber, totalUsd, totalBs, deliveryFee };
  } catch (err) {
    console.error('[COMMERCE] ❌ createOrder error:', err.message);
    return null;
  }
}

// ── Mostrar carrito + opciones de delivery ─────────────────────────────────
async function showCartAndDelivery(pgPool, supabaseBot, inbox_id, phone, botConfig, sendReply) {
  const session = await getSession(pgPool, supabaseBot, inbox_id, phone);
  if (!session) return;
  const cart = safeJsonParse(session.cart, []);
  const subtotal = cart.reduce((acc, c) => acc + c.price * c.qty, 0);
  const cartText = cart.map(c => `• ${c.qty}x ${c.title} — ${formatPrice(c.price * c.qty)}`).join('\n');

  await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
    state: 'DELIVERY_TYPE',
    order_total_usd: subtotal
  });

  await sendReply(
    `🛒 *Tu carrito:*\n${cartText}\n\n` +
    `💰 Subtotal: ${formatPrice(subtotal)}\n\n` +
    `¿Cómo prefieres recibir tu pedido?\n` +
    `1️⃣ Retirar en tienda (Pickup)\n` +
    `${botConfig.isDeliveryEnabled ? '2️⃣ Delivery a domicilio\n' : ''}` +
    `\nEscribe *1*${botConfig.isDeliveryEnabled ? ' o *2*' : ''}`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// DISPATCHER PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════
async function handleCommerceMessage(payload, botConfig, sendReply, pgPool, supabaseBot) {
  const { customer_phone, inbox_id, messageType, messageText, mediaUrl, order_payload } = payload;
  const phone = String(customer_phone).replace(/^\+/, '');

  const catalogId = botConfig.commerceSettings?.catalog_id;
  if (!catalogId) {
    await sendReply('⚙️ Este negocio aún no tiene catálogo configurado. Contáctanos directamente.');
    return;
  }

  const businessMode = classifyBusiness(botConfig.businessNature);
  console.log(`[COMMERCE] 🏪 Modo: ${businessMode} | Nature: "${botConfig.businessNature || '(vacío)'}"`);

  // ── Anuncio click-to-chat: si viene de un anuncio, pre-seleccionar producto ──
  if (payload.context?.referred_product?.product_retailer_id) {
    const refRetailerId = payload.context.referred_product.product_retailer_id;
    console.log(`[COMMERCE] 📢 Anuncio click-to-chat: producto ${refRetailerId}`);
    try {
      let product = null;
      if (pgPool) {
        const { rows } = await pgPool.query(
          `SELECT * FROM meta_saas.catalog_products WHERE catalog_id=$1 AND retailer_id=$2 LIMIT 1`,
          [catalogId, refRetailerId]
        );
        product = rows[0];
      }
      if (product) {
        await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
          state: 'QUANTITY',
          current_item: JSON.stringify(product),
          cart: '[]',
          order_total_usd: 0
        });
        const caption = `✅ *${product.title}* — ${formatPrice(product.price)}\n\n${product.description || ''}\n\n¿Cuántas unidades? (1-10)`;
        await sendReply(caption, product.image_url || undefined);
        return;
      }
    } catch (err) {
      console.error('[COMMERCE] Error procesando anuncio:', err.message);
    }
  }

  let session = await getSession(pgPool, supabaseBot, inbox_id, phone);
  const state = session?.state || 'IDLE';

  console.log(`[COMMERCE] 📍 Estado: ${state} | Cliente: ${phone} | Msg: "${messageText || messageType}"`);

  // ── ESTADO: ORDER RECIBIDO DESDE CATALOGO NATIVO ─────────────────────────
  if (messageType === 'order' && order_payload) {
    const orderItems = order_payload.product_items || [];
    const products = await getBaseProducts(pgPool, supabaseBot, catalogId);
    const extras = await getExtraProducts(pgPool, supabaseBot, catalogId);
    const allProducts = [...products, ...extras];

    const cart = [];
    for (const item of orderItems) {
      const p = allProducts.find(x => x.retailer_id === item.product_retailer_id);
      if (p) {
        cart.push({
          retailer_id: p.retailer_id,
          title: p.title,
          price: parseFloat(p.price),
          qty: parseInt(item.quantity, 10) || 1
        });
      }
    }

    const subtotal = cart.reduce((acc, c) => acc + c.price * c.qty, 0);

    await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
      state: 'DELIVERY_TYPE',
      cart: JSON.stringify(cart),
      order_total_usd: subtotal,
      current_item: 'null'
    });

    await showCartAndDelivery(pgPool, supabaseBot, inbox_id, phone, botConfig, sendReply);
    return;
  }

  // ── CANCELAR en cualquier momento ────────────────────────────────────────
  if (messageText && isCancel(messageText) && state !== 'IDLE') {
    await deleteSession(pgPool, inbox_id, phone);
    await sendReply('❌ Pedido cancelado. Escribe *menú* cuando quieras volver a pedir.');
    return;
  }

  // ── RESET: si el cliente escribe hola/menú/inicio en medio de un flujo, reiniciar ─
  const RESET_WORDS = ['hola', 'holaa', 'menú', 'menu', 'inicio', 'start', 'buenas', 'buenos'];
  const isReset = RESET_WORDS.some(w => normalizeText(messageText) === w);
  if (isReset && state !== 'IDLE') {
    await deleteSession(pgPool, inbox_id, phone);
    console.log('[COMMERCE] 🔄 Reset por palabra clave: ' + messageText);
    // Caer al flujo de IDLE abajo (no return)
  }

  // ── ESTADO: IDLE — arranque del flujo ────────────────────────────────────
  const effectiveState = isReset ? 'IDLE' : state;
  if (effectiveState === 'IDLE' || (messageText && isTrigger(messageText) && (effectiveState === 'SEARCHING' || effectiveState === 'ORDER_CONFIRMED'))) {
    if (businessMode === 'hardware') {
      await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
        state: 'SEARCHING', cart: '[]', cart_meta: '[]', current_item: 'null', order_total_usd: 0
      });
      await sendReply(
        `🔧 ¡Hola! Soy el asistente de *${botConfig.companyName}*.\n\n` +
        `¿Qué necesitas hoy? Escribe el producto o herramienta que buscas.`
      );
      return;
    }
    await showCatalog(pgPool, supabaseBot, catalogId, inbox_id, phone, botConfig, sendReply, businessMode);
    return;
  }

  // ── ESTADO: SEARCHING — búsqueda ILIKE (ferretería/hardware) ─────────────
  if (effectiveState === 'SEARCHING') {
    if (!messageText || messageText.trim().length < 2) {
      await sendReply('Escribe el nombre del producto que buscas, ej: "martillo", "clavos", "cemento"');
      return;
    }
    const results = await searchProducts(pgPool, catalogId, messageText.trim());

    if (!results || results.length === 0) {
      await sendReply(
        `🔍 No encontré *"${messageText.trim()}"* en el catálogo.\n\n` +
        `Intenta con otra palabra o escribe *menú* para ver todo lo disponible.`
      );
      return;
    }

    const emoji = BUSINESS_EMOJI[businessMode];
    const lines = results.map((p, i) => {
      const priceStr = formatPrice(p.price);
      const dots = '.'.repeat(Math.max(3, 30 - p.title.length - priceStr.length));
      return `${i + 1}️⃣ ${p.title} ${dots} ${priceStr}`;
    }).join('\n');

    await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
      state: 'SELECTING',
      cart: '[]',
      cart_meta: JSON.stringify(results),
      current_item: 'null',
      order_total_usd: 0
    });

    await sendReply(
      `${emoji} *Resultados para "${messageText.trim()}" — ${botConfig.companyName}*\n\n` +
      `${lines}\n\n` +
      `Escribe el *número* del producto que deseas 👆\n` +
      `_(Escribe *cancelar* para salir)_`
    );
    return;
  }

  // ── ESTADO: SELECTING — cliente escribe número del producto ──────────────
  if (effectiveState === 'SELECTING') {
    const choice = extractNumber(messageText);
    const products = safeJsonParse(session.cart_meta, []);

    if (isNaN(choice) || choice < 1 || choice > products.length) {
      await sendReply(`Por favor escribe un número del 1 al ${products.length} 👆`);
      return;
    }
    const selected = products[choice - 1];
    await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
      state: 'QUANTITY',
      current_item: JSON.stringify(selected)
    });

    const caption = `✅ *${selected.title}* — ${formatPrice(selected.price)}\n\n` +
      (selected.description ? `${selected.description}\n\n` : '') +
      `¿Cuántas unidades deseas? (responde con un número del 1 al 10)`;

    if (businessMode === 'retail' && selected.image_url) {
      await sendReply(caption, selected.image_url);
    } else {
      await sendReply(caption);
    }
    return;
  }

  // ── ESTADO: QUANTITY ──────────────────────────────────────────────────────
  if (effectiveState === 'QUANTITY') {
    const qty = extractNumber(messageText);
    if (isNaN(qty) || qty < 1 || qty > 10) {
      await sendReply('Por favor escribe un número entre *1* y *10* 📦');
      return;
    }
    const item = JSON.parse(session.current_item || '{}');
    const cart = safeJsonParse(session.cart, []);
    const existingIdx = cart.findIndex(c => c.retailer_id === item.retailer_id);
    if (existingIdx >= 0) {
      cart[existingIdx].qty += qty;
    } else {
      cart.push({ retailer_id: item.retailer_id, title: item.title, price: item.price, qty });
    }
    const subtotal = cart.reduce((acc, c) => acc + c.price * c.qty, 0);
    await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
      cart: JSON.stringify(cart),
      current_item: 'null',
      order_total_usd: subtotal
    });

    // Verificar si hay extras disponibles
    const extras = await getExtraProducts(pgPool, supabaseBot, catalogId);
    if (extras && extras.length > 0) {
      const extraLines = extras.map((e, i) => {
        const ps = formatPrice(e.price);
        const dots = '.'.repeat(Math.max(3, 28 - e.title.length - ps.length));
        return `${i + 1}️⃣ ${e.title} ${dots} ${ps}`;
      }).join('\n');
      const continueNum = extras.length + 1;
      await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
        state: 'EXTRAS',
        cart_meta: JSON.stringify(extras)
      });
      await sendReply(
        `🍕 *¿Agregar extras a tu pedido?*\n\n` +
        `${extraLines}\n\n` +
        `${continueNum}️⃣ No, continuar sin extras\n\n` +
        `Escribe el *número* de la opción que deseas 👆\n` +
        `_(Puedes agregar varios. Escribe *${continueNum}* para continuar)_`
      );
      return;
    }

    // Sin extras → directo a delivery
    await showCartAndDelivery(pgPool, supabaseBot, inbox_id, phone, botConfig, sendReply);
    return;
  }

  // ── ESTADO: EXTRAS — cliente agrega extras o continúa ───────────────────
  if (effectiveState === 'EXTRAS') {
    const choice = extractNumber(messageText);
    const extras = safeJsonParse(session.cart_meta, []);
    const continueOption = extras.length + 1;

    if (isNaN(choice) || choice < 1 || choice > continueOption) {
      await sendReply(`Por favor escribe un número del 1 al ${continueOption} 👆`);
      return;
    }

    // Opción "No, continuar" → ir a DELIVERY_TYPE
    if (choice === continueOption) {
      await showCartAndDelivery(pgPool, supabaseBot, inbox_id, phone, botConfig, sendReply);
      return;
    }

    // Agregar extra seleccionado al carrito (qty=1 por defecto)
    const selectedExtra = extras[choice - 1];
    const cart = safeJsonParse(session.cart, []);
    const existingIdx = cart.findIndex(c => c.retailer_id === selectedExtra.retailer_id);
    if (existingIdx >= 0) {
      cart[existingIdx].qty += 1;
    } else {
      cart.push({ retailer_id: selectedExtra.retailer_id, title: selectedExtra.title, price: selectedExtra.price, qty: 1 });
    }
    const subtotal = cart.reduce((acc, c) => acc + c.price * c.qty, 0);
    await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
      cart: JSON.stringify(cart),
      order_total_usd: subtotal
    });

    const cartText = cart.map(c => `• ${c.qty}x ${c.title} — ${formatPrice(c.price * c.qty)}`).join('\n');
    await sendReply(
      `✅ *${selectedExtra.title}* agregado!\n\n` +
      `🛒 *Tu carrito:*\n${cartText}\n\n` +
      `💰 Subtotal: ${formatPrice(subtotal)}\n\n` +
      `Escribe otro *número* para agregar más extras, o *${continueOption}* para continuar 👆`
    );
    return;
  }

  // ── ESTADO: DELIVERY_TYPE ─────────────────────────────────────────────────
  if (effectiveState === 'DELIVERY_TYPE') {
    const choice = messageText?.trim();
    if (choice === '1') {
      const addr = botConfig.addressDetails?.street
        ? `📍 ${botConfig.addressDetails.street}, ${botConfig.addressDetails.city || ''}`
        : '📍 Consulta la dirección con el negocio';
      await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
        state: 'PAYMENT_INFO', delivery_type: 'pickup', delivery_address: null
      });
      await sendReply(`🏪 *Retiro en tienda*\n${addr}\n\nProcesando datos de pago...`);
      await showPaymentInfo(pgPool, supabaseBot, inbox_id, phone, session, botConfig, sendReply);
    } else if (choice === '2' && botConfig.isDeliveryEnabled) {
      await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
        state: 'ADDRESS_INPUT', delivery_type: 'delivery'
      });
      await sendReply('🏠 Por favor escribe tu *dirección de entrega* completa:\n_(Calle, Sector, Ciudad)_');
    } else {
      await sendReply(`Escribe *1* para pickup${botConfig.isDeliveryEnabled ? ' o *2* para delivery' : ''}`);
    }
    return;
  }

  // ── ESTADO: ADDRESS_INPUT ─────────────────────────────────────────────────
  if (effectiveState === 'ADDRESS_INPUT') {
    if (!messageText || messageText.trim().length < 5) {
      await sendReply('Por favor escribe una dirección más completa 📍');
      return;
    }
    await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
      state: 'PAYMENT_INFO', delivery_address: messageText.trim()
    });
    await showPaymentInfo(pgPool, supabaseBot, inbox_id, phone, session, botConfig, sendReply);
    return;
  }

  // ── ESTADO: WAITING_PROOF — esperar imagen del comprobante ───────────────
  if (effectiveState === 'WAITING_PROOF') {
    if (messageType === 'image' && mediaUrl) {
      await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
        state: 'ORDER_CONFIRMED', proof_media_url: mediaUrl
      });

      const finalSession = await getSession(pgPool, supabaseBot, inbox_id, phone);
      const order = await createOrder(pgPool, { ...finalSession, proof_media_url: mediaUrl }, botConfig);

      if (!order) {
        await sendReply('❌ Error al procesar tu pedido. Por favor contáctanos directamente.');
        return;
      }

      const cart = safeJsonParse(finalSession.cart, []);
      const cartText = cart.map(c => `• ${c.qty}x ${c.title} — ${formatPrice(c.price * c.qty)}`).join('\n');
      const deliveryInfo = finalSession.delivery_type === 'pickup'
        ? '🏪 Retiro en tienda'
        : `🚗 Delivery a: ${finalSession.delivery_address}`;

      await sendReply(
        `✅ *¡Pedido Recibido! #${order.orderNumber}*\n\n` +
        `${cartText}\n\n` +
        `${deliveryInfo}\n` +
        `💰 Total: ${formatPrice(order.totalUsd)}` +
        `${order.deliveryFee > 0 ? ` (incluye delivery ${formatPrice(order.deliveryFee)})` : ''}\n\n` +
        `⏱️ Estamos revisando tu pago y preparando tu pedido.\n` +
        `Te avisamos en cuanto esté listo 🙌\n\n` +
        `_Escribe *menú* para hacer otro pedido_`
      );

      await deleteSession(pgPool, inbox_id, phone);
    } else {
      await sendReply('📸 Por favor envía la *imagen* del comprobante de pago para confirmar tu pedido.');
    }
    return;
  }

  // ── FALLBACK: reiniciar ──────────────────────────────────────────────────
  await deleteSession(pgPool, inbox_id, phone);
  await showCatalog(pgPool, supabaseBot, catalogId, inbox_id, phone, botConfig, sendReply, businessMode);
}

// ── Mostrar catálogo (adaptativo por modo) ─────────────────────────────────
async function showCatalog(pgPool, supabaseBot, catalogId, inbox_id, phone, botConfig, sendReply, businessMode) {
  const products = await getBaseProducts(pgPool, supabaseBot, catalogId);
  const emoji = BUSINESS_EMOJI[businessMode];

  if (!products || products.length === 0) {
    await sendReply(
      `👋 ¡Hola! Soy el asistente de *${botConfig.companyName}*.\n\n` +
      `Por el momento no tenemos productos disponibles en el catálogo.\n` +
      `Por favor escríbenos directamente para más información.`
    );
    return;
  }

  const lines = products.map((p, i) => {
    const priceStr = formatPrice(p.price);
    const dots = '.'.repeat(Math.max(3, 30 - p.title.length - priceStr.length));
    return `${i + 1}️⃣ ${p.title} ${dots} ${priceStr}`;
  }).join('\n');

  await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
    state: 'SELECTING',
    cart: '[]',
    cart_meta: JSON.stringify(products),
    current_item: 'null',
    order_total_usd: 0
  });

  // Si no es hardware, enviar el product_list nativo
  if (businessMode !== 'hardware') {
    const interactivePayload = {
      type: "product_list",
      header: { type: "text", text: `Menú de ${botConfig.companyName}` },
      body: { text: "Selecciona los productos que deseas" },
      action: {
        catalog_id: catalogId,
        sections: [
          {
            title: "Productos",
            product_items: products.slice(0, 30).map(p => ({ product_retailer_id: p.retailer_id }))
          }
        ]
      }
    };
    await sendReply(
      `🍽️ *Menú de ${botConfig.companyName}*\nToca el botón abajo para abrir nuestro catálogo nativo 👇`,
      null,
      interactivePayload
    );
  } else {
    // Fallback para hardware o si preferimos texto
    await sendReply(
      `${emoji} *MENÚ — ${botConfig.companyName}*\n\n` +
      `${lines}\n\n` +
      `Escribe el *número* del producto que deseas 👆\n` +
      `_(Escribe *cancelar* en cualquier momento)_`
    );
  }
}

// ── Mostrar datos de Pago Móvil ─────────────────────────────────────────────
async function showPaymentInfo(pgPool, supabaseBot, inbox_id, phone, sessionIn, botConfig, sendReply) {
  const session = await getSession(pgPool, supabaseBot, inbox_id, phone);
  if (!session) return;

  const rate = await getTasaBCV();
  await upsertSession(pgPool, supabaseBot, inbox_id, phone, {
    state: 'WAITING_PROOF', bcv_rate: rate
  });

  const pm = botConfig.paymentPagoMovil || {};
  const deliveryFee = session.delivery_type === 'delivery'
    ? parseFloat(botConfig.commerceSettings?.delivery_fee || 0)
    : 0;
  const totalUsd = parseFloat(session.order_total_usd || 0) + deliveryFee;
  const totalBs  = totalUsd * rate;

  const bankName = getBankName(pm.bank_code || pm.banco || '');
  const cedula   = pm.cedula || pm.rif || 'N/D';
  const telefono = pm.phone || pm.telefono || 'N/D';

  await sendReply(
    `💳 *Datos de Pago Móvil*\n\n` +
    `🏦 Banco: ${bankName || 'Consultar'}\n` +
    `🪪 Cédula: ${cedula}\n` +
    `📱 Teléfono: ${telefono}\n` +
    `💵 Monto: *Bs. ${totalBs.toFixed(2)}*\n` +
    `   (${formatPrice(totalUsd)} × Tasa BCV: ${rate.toFixed(2)} Bs/$)\n\n` +
    `📸 Realiza el pago y envía la *imagen del comprobante* para confirmar tu pedido ✅`
  );
}

module.exports = { handleCommerceMessage, setRedisClient };