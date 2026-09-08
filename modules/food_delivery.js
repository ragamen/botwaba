// modules/food_delivery.js
'use strict';
const crypto = require('crypto');
const { getTasaBCV } = require('../bcvScraper');

async function extractOrderWithLLM(historyMessages, openRouterApiKey) {
  if (!historyMessages || historyMessages.length === 0 || !openRouterApiKey) return null;
  try {
    const prompt = `Analiza la conversación entre el cliente y el restaurante.
Extrae los datos finales del pedido acordado en formato JSON EXACTO:
{
  "items": [
    {"name": "nombre claro del plato o producto", "quantity": 1, "price": 0.0}
  ],
  "delivery_type": "delivery" | "pickup",
  "delivery_address": "dirección de entrega o null",
  "subtotal_usd": 0.0,
  "delivery_fee_usd": 0.0,
  "total_usd": 0.0
}
REGLAS:
- Para los items, usa nombres naturales claros para la cocina (ej: "Promo Estrella", "Cachapa Tradicional", "Picadillo Llanero (Sopa)", "1/2 kg de cochino al tambor").
- Queda ESTRICTAMENTE PROHIBIDO incluir datos de pago móvil, bancos, teléfonos, cuentas, cédulas o costo de delivery dentro de "items". Los items son ÚNICAMENTE comida o bebida.
- Si especificó cantidades, colócalas en "quantity".
- Si es delivery y hay dirección, indícala en "delivery_address" y pon "delivery_type": "delivery".
- Devuelve ÚNICAMENTE el objeto JSON válido.`;

    const msgs = [
      { role: 'system', content: prompt },
      ...historyMessages.slice(-20),
      { role: 'user', content: 'Extrae el pedido acordado en formato JSON.' }
    ];

    const { callLlmChat } = require('../llmClient');
    const { content } = await callLlmChat({
      messages: msgs,
      response_format: { type: 'json_object' }
    });

    if (content) {
      const cleanJson = content.replace(/^```json\s*|\s*```$/g, '').trim();
      return JSON.parse(cleanJson);
    }
  } catch (err) {
    console.warn('[FOOD_DELIVERY] Error extracting order with LLM:', err.message);
  }
  return null;
}

function parseOrderFromText(text) {
  if (!text) return null;
  // Requiere obligatoriamente símbolo de moneda ($ o Bs) para que números de teléfono nunca coincidan como platos
  const itemRegex = /(?:^|\n)\s*(?:\d+[\.\)]|\-|\*)\s*([^\n\-\$]+?)\s*[-:]\s*(?:\$|usd|bs\.?)\s*([\d\.]+)\s*(?:\((?:Cantidad:\s*|cant:\s*)?(\d+)\))?/gi;
  let m;
  const items = [];
  const IGNORE = ['subtotal', 'total', 'delivery', 'costo', 'almuerzos', 'bebidas', 'platos', 'pago', 'móvil', 'movil', 'banco', 'cédula', 'cedula', 'teléfono', 'telefono', 'número', 'numero', 'cuenta', 'rif', 'referencia', 'comprobante'];

  while ((m = itemRegex.exec(text)) !== null) {
    const name = m[1].replace(/[\*\_:]/g, '').trim();
    const price = parseFloat(m[2]);
    const qty = m[3] ? parseInt(m[3]) : 1;
    const lower = name.toLowerCase();
    if (!IGNORE.some(w => lower.includes(w))) {
      items.push({ name, price, quantity: qty });
    }
  }

  const addrMatch = text.match(/(?:direcci[oó]n(?: de entrega)?):\*?\*?\s*([^\n\.\n]+)/i);
  let addr = null;
  if (addrMatch) {
    addr = addrMatch[1].replace(/[\*\_]/g, '').trim();
  }

  const totalMatch = text.match(/total(?: a pagar)?:\*?\*?\s*\$?([\d\.]+)/i);
  let total = null;
  if (totalMatch) {
    total = parseFloat(totalMatch[1]);
  }

  return { items, addr, total };
}

async function handleFoodDeliveryMessage({
  recipient,
  payload,
  context,
  pgPool,
  quickSend,
  sendToPhone,
  upsertCommerceSession,
  getInteractiveMenuPayload,
  analyzePaymentCapture,
  ablyKey,
  openRouterApiKey,
  aiModel,
  customerName,
  message_content,
  conversationId,
  wabaId,
  phoneNumberId,
  accessToken,
  deductAiTokens
}) {
  const { bizConfig, commerceSettings, activePaymentMovil } = context;
  const inbox_id = payload.inbox_id;

  var bizCatalogId = (bizConfig && bizConfig.catalog_id) ? bizConfig.catalog_id : (commerceSettings ? commerceSettings.catalog_id : null);
  var bizPaymentMovil = (bizConfig && bizConfig.payment_pago_movil) ? bizConfig.payment_pago_movil : activePaymentMovil;
  var bizAdminPhones = (bizConfig && bizConfig.admin_phones) ? bizConfig.admin_phones : (commerceSettings ? (commerceSettings.admin_phones || []) : []);
  var bizDeliveryFee = (bizConfig) ? parseFloat(bizConfig.delivery_fee || 0) : parseFloat((commerceSettings || {}).delivery_fee || 0);
  var bizIsDelivery = (bizConfig) ? bizConfig.is_delivery_enabled : false;
  let resolvedBusinessName = (bizConfig && bizConfig.business_name) ? bizConfig.business_name : null;
  let resolvedBusinessNature = (bizConfig && bizConfig.business_nature) ? bizConfig.business_nature : null;
  if (!resolvedBusinessName && pgPool) {
    try {
      const { rows: sc } = await pgPool.query('SELECT company_name, business_nature FROM meta_saas.saas_clients WHERE inbox_id=$1 LIMIT 1', [inbox_id]);
      if (sc[0] && sc[0].company_name) {
        resolvedBusinessName = sc[0].company_name;
        resolvedBusinessNature = sc[0].business_nature || resolvedBusinessNature;
      }
    } catch(e) {}
  }
  var bizBusinessName = resolvedBusinessName || 'Restaurante';
  var bizBusinessNature = resolvedBusinessNature || 'Gastronomía y Comida';
  var bizAddress = (bizConfig) ? { street: bizConfig.address_street, city: bizConfig.address_city } : {};
  var bizBusinessId = bizConfig ? bizConfig.id : null;
  const catalogId = bizCatalogId;

  // Cargar sesión
  let session = null;
  try {
    const { rows: sr } = await pgPool.query('SELECT * FROM botwaba.commerce_sessions WHERE inbox_id=$1 AND customer_phone=$2 LIMIT 1', [inbox_id, recipient]);
    session = sr[0] || null;
  } catch (e) {}

  // Cargar negocios
  let businesses = [];
  try {
    const { rows: bizRows } = await pgPool.query("SELECT id, business_name, business_nature, catalog_id, emoji, payment_pago_movil, admin_phones, delivery_fee, is_delivery_enabled, address_street, address_city FROM botwaba.commerce_businesses WHERE inbox_id=$1 AND is_active=true ORDER BY sort_order ASC", [inbox_id]);
    businesses = bizRows;
  } catch (e) {}

  // ── MÓDULO COMMERCE: Procesar pedido/carrito nativo de WhatsApp ──
  const isOrderMsg = (payload.messageType === 'order') || (payload.order_payload);
  if (isOrderMsg && payload.order_payload) {
    console.log('[FOOD_DELIVERY] Procesando carrito nativo enviado por el cliente...');
    const orderData = payload.order_payload;
    const catalogIdToUse = orderData.catalog_id || bizCatalogId;
    const productItems = orderData.product_items || [];
    
    let cartArr = [];
    for (const item of productItems) {
      const rId = item.product_retailer_id;
      const qty = parseInt(item.quantity || 1);
      const defaultPrice = parseFloat(item.item_price || 0);
      
      let title = rId;
      let price = defaultPrice;
      if (pgPool && catalogIdToUse) {
        try {
          const { rows: prodRows } = await pgPool.query('SELECT title, price FROM meta_saas.catalog_products WHERE retailer_id=$1 AND catalog_id=$2 LIMIT 1', [rId, catalogIdToUse]);
          if (prodRows[0]) {
            title = prodRows[0].title;
            price = parseFloat(prodRows[0].price);
          }
        } catch(e) {}
      }
      cartArr.push({ retailer_id: rId, title, price, qty });
    }
    
    const subtotal = cartArr.reduce((a, c) => a + c.price * c.qty, 0);
    await upsertCommerceSession(pgPool, inbox_id, recipient, { 
      cart: JSON.stringify(cartArr), 
      order_total_usd: subtotal, 
      state: 'SELECTING' 
    });
    
    const cartText = cartArr.map(c => '+ ' + c.qty + 'x ' + c.title + ' ($' + (c.price * c.qty).toFixed(2) + ')').join('\n');
    let deliveryText = '';
    let interactiveDeliveryPayload = null;
    if (bizIsDelivery) {
      deliveryText = '\n\n¿Cómo prefieres recibir tu pedido?\n1. 🛵 *Para Delivery* (+$' + parseFloat(bizDeliveryFee).toFixed(2) + ')\n2. 🏪 *Retiro en tienda* (Pickup)\n\nPor favor selecciona una opción:';
      interactiveDeliveryPayload = {
        type: 'list',
        header: { type: 'text', text: 'Tipo de Entrega' },
        body: { text: 'Selecciona cómo deseas recibir tu pedido:' },
        footer: { text: 'BotWaba' },
        action: {
          button: 'Elegir entrega 🛵🏪',
          sections: [
            {
              title: 'Opciones de Entrega',
              rows: [
                { id: 'delivery_option_delivery', title: 'Para Delivery', description: 'Envío a domicilio (+$' + parseFloat(bizDeliveryFee).toFixed(2) + ')' },
                { id: 'delivery_option_pickup', title: 'Retiro en tienda', description: 'Pasar a buscar por el local' }
              ]
            }
          ]
        }
      };
    } else {
      deliveryText = '\n\n🏪 Retiro en tienda disponible.\nEscribe *confirmar* para proceder al pago.';
      interactiveDeliveryPayload = {
        type: 'button',
        body: { text: '🏪 Solo retiro en tienda disponible. Presiona para continuar:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'delivery_option_pickup', title: 'Retiro en tienda' } }
          ]
        }
      };
    }
    
    await quickSend('🛒 *Pedido recibido:*\n\n' + cartText + '\n\n*Subtotal: $' + subtotal.toFixed(2) + '*' + deliveryText, null, interactiveDeliveryPayload);
    return;
  }

  // Procesar respuestas de la lista interactiva
  const listReplyId = payload.button_payload?.list_reply?.id || payload.button_payload?.interactive?.list_reply?.id || payload.match_key || null;
  if (listReplyId) {
    let cartArr = [];
    let cartSession = session;
    try {
      if (!cartSession && pgPool) { const { rows: cr } = await pgPool.query('SELECT * FROM botwaba.commerce_sessions WHERE inbox_id=$1 AND customer_phone=$2 LIMIT 1', [inbox_id, recipient]); cartSession = cr[0] || null; }
      if (cartSession) { cartArr = typeof cartSession.cart === 'string' ? JSON.parse(cartSession.cart || '[]') : (cartSession.cart || []); }
    } catch(e) {}

    if (listReplyId.startsWith('prod_')) {
      const retailerId = listReplyId.replace('prod_', '');
      let bizCatId = null;
      try { if (cartSession && cartSession.business_id && pgPool) { const { rows: bc } = await pgPool.query('SELECT catalog_id FROM botwaba.commerce_businesses WHERE id=$1 LIMIT 1', [cartSession.business_id]); if (bc[0]) bizCatId = bc[0].catalog_id; } } catch(e) {}
      if (bizCatId && pgPool) {
        try {
          const { rows: products } = await pgPool.query('SELECT title, price, retailer_id FROM meta_saas.catalog_products WHERE retailer_id=$1 AND catalog_id=$2 AND availability=$3 LIMIT 1', [retailerId, bizCatId, 'in stock']);
          if (products[0]) {
            const p = products[0];
            const exIdx = cartArr.findIndex(c => c.retailer_id === p.retailer_id);
            if (exIdx >= 0) cartArr[exIdx].qty += 1; else cartArr.push({ retailer_id: p.retailer_id, title: p.title, price: parseFloat(p.price), qty: 1 });
            const subtotal = cartArr.reduce((a, c) => a + c.price * c.qty, 0);
            await upsertCommerceSession(pgPool, inbox_id, recipient, { cart: JSON.stringify(cartArr), order_total_usd: subtotal, state: 'SELECTING' });
            const cartText = cartArr.map(c => '+ ' + c.qty + 'x ' + c.title + ' ($' + (c.price * c.qty).toFixed(2) + ')').join('\n');
            const newMenuPayload = {
              type: "catalog_message",
              body: { text: "Sigue explorando nuestro menú y agrega más productos a tu carrito:" },
              action: { name: "catalog_message", parameters: { thumbnail_product_retailer_id: p.retailer_id } }
            };
            await quickSend('✅ *' + p.title + '* agregada ($' + parseFloat(p.price).toFixed(2) + ')\n\n🛒 *Carrito:*\n' + cartText + '\n\n*Total: $' + subtotal.toFixed(2) + '*', null, newMenuPayload);
            return;
          }
        } catch(e) {}
      }
    }

    if (listReplyId === 'delivery_option_delivery') {
      await upsertCommerceSession(pgPool, inbox_id, recipient, { delivery_type: 'delivery' });
      await quickSend('🛵 Delivery seleccionado (+$' + parseFloat(bizDeliveryFee).toFixed(2) + ').\n¿Cuál es tu dirección?');
      return;
    }
    if (listReplyId === 'delivery_option_pickup') {
      await upsertCommerceSession(pgPool, inbox_id, recipient, { delivery_type: 'pickup' });
      await quickSend('🏪 Retiro en tienda.\nEscribe *confirmar* para finalizar tu pedido.');
      return;
    }
    if (listReplyId === 'action_finish_order') {
      if (cartArr.length === 0) {
        await quickSend('Tu carrito está vacío. 😅 Por favor, toca el botón *Elegir Producto 🛒* para seleccionar tus productos.');
        return;
      }
      const subtotal = cartArr.reduce((a, c) => a + c.price * c.qty, 0);
      const deliveryType = (cartSession && cartSession.delivery_type) || null;
      const deliveryFee = deliveryType === 'delivery' ? bizDeliveryFee : 0;
      const orderTotal = subtotal + deliveryFee;
      let tasa = 0; try { tasa = await getTasaBCV(); } catch(e) {}
      const totalBs = orderTotal * tasa;
      const pm = bizPaymentMovil || {};
      let payText = '';
      if (pm.cedula || pm.telefono || pm.bank_code) {
        payText = '\n\n💳 *Datos de Pago Móvil*\n Banco: ' + (pm.banco || pm.bank_code || 'Consultar') + '\n Cédula: ' + (pm.cedula || pm.rif || 'N/D') + '\n Teléfono: ' + (pm.telefono || pm.phone || 'N/D');
      }
      await quickSend('*Total: $' + orderTotal.toFixed(2) + '* (Bs. ' + totalBs.toFixed(2) + ')' + payText + '\n\nEnvía la foto de tu pago móvil con la palabra *pago* o *capture*.');
      await upsertCommerceSession(pgPool, inbox_id, recipient, { state: 'WAITING_PROOF', order_total_usd: orderTotal, bcv_rate: tasa });
      return;
    }
  }

  // Cargar historial de conversación temprano (necesario para CASO 1 y CASO 3)
  let historyMessages = [];
  try {
    if (pgPool && conversationId) {
      const { rows: hr } = await pgPool.query('SELECT direction, content FROM meta_saas.messages WHERE conversation_id = $1 ORDER BY timestamp ASC', [conversationId]);
      historyMessages = hr.slice(-30).map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }));
      if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].content === message_content) historyMessages.pop();
    }
  } catch (e) {}

  // CASO 1: Captura de comprobante
  const msgType = payload.messageType || 'text';
  const msgText = (payload.messageText || message_content || '').toLowerCase();
  const msgMedia = payload.mediaUrl || null;
  if (msgType === 'image' && msgMedia) {
    const extractedInfo = await analyzePaymentCapture(msgMedia, openRouterApiKey);
    if (extractedInfo && (extractedInfo.status === 'exitoso' || extractedInfo.status === 'fallido')) {
      if (extractedInfo.status === 'fallido') {
        await quickSend('❌ El comprobante enviado indica que la transacción fue *FALLIDA*.\n\nPor favor envía una captura exitosa.');
        return;
      }
      let orderRate = 0; try { orderRate = await getTasaBCV(); } catch(e) {}
      let orderNumber = 'ORD-000001-00';
      try {
        const { rows: sq } = await pgPool.query("SELECT nextval('botwaba.pedidos_order_seq') AS seq");
        const seqNum = String(sq[0].seq).padStart(6, '0');
        const month = String(new Date().getMonth() + 1).padStart(2, '0');
        orderNumber = 'ORD-' + seqNum + '-' + month;
      } catch(e) {}

      // Resolver items, dirección, tipo de entrega y total
      let cartForInsert = [];
      try {
        cartForInsert = (session && session.cart) ? (typeof session.cart === 'string' ? JSON.parse(session.cart) : session.cart) : [];
      } catch(e) {}

      let deliveryType = (session && session.delivery_type) || 'pickup';
      let deliveryAddress = (session && session.delivery_address) || null;
      let totalUsd = parseFloat((session && session.order_total_usd) || 0);

      // Si falta el carrito, total o dirección, extraer automáticamente de la conversación
      if (!cartForInsert || cartForInsert.length === 0 || totalUsd === 0 || !deliveryAddress) {
        console.log('[FOOD_DELIVERY] Extrayendo datos del pedido desde la conversación...');
        const extractedOrder = await extractOrderWithLLM(historyMessages, openRouterApiKey);
        if (extractedOrder) {
          if ((!cartForInsert || cartForInsert.length === 0) && Array.isArray(extractedOrder.items) && extractedOrder.items.length > 0) {
            cartForInsert = extractedOrder.items;
          }
          if (!deliveryAddress && extractedOrder.delivery_address) {
            deliveryAddress = extractedOrder.delivery_address;
          }
          if (extractedOrder.delivery_type) {
            deliveryType = extractedOrder.delivery_type;
          }
          if (totalUsd === 0 && extractedOrder.total_usd) {
            totalUsd = parseFloat(extractedOrder.total_usd);
          }
        }
      }

      if (deliveryAddress && deliveryAddress.trim() !== '') {
        deliveryType = 'delivery';
      }
      if (payload.location) {
        const loc = payload.location;
        deliveryAddress = (loc.name || loc.address || 'Sin referencia') + ' (lat:' + loc.latitude + ', lng:' + loc.longitude + ')';
        deliveryType = 'delivery';
      }

      const deliveryFee = deliveryType === 'delivery' ? bizDeliveryFee : 0;
      if (totalUsd === 0 && cartForInsert.length > 0) {
        totalUsd = cartForInsert.reduce((a, c) => a + (parseFloat(c.price) || 0) * (parseInt(c.quantity || c.qty) || 1), 0);
      }
      const finalTotalUsd = totalUsd > 0 ? totalUsd : (cartForInsert.reduce((a, c) => a + (parseFloat(c.price) || 0) * (parseInt(c.quantity || c.qty) || 1), 0) + deliveryFee);
      const totalBs = finalTotalUsd * orderRate;
      const paymentInfo = { ...(bizPaymentMovil || {}), extracted: extractedInfo };

      try {
        await pgPool.query(
          'INSERT INTO botwaba.pedidos (order_number, inbox_id, customer_phone, items, subtotal_usd, delivery_fee_usd, total_usd, total_bs, bcv_rate, delivery_type, delivery_address, payment_info, proof_media_url, status, business_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
          [orderNumber, inbox_id, recipient, JSON.stringify(cartForInsert), totalUsd > deliveryFee ? (totalUsd - deliveryFee) : totalUsd, deliveryFee, finalTotalUsd, totalBs, orderRate, deliveryType, deliveryAddress, JSON.stringify(paymentInfo), msgMedia, 'pending', bizBusinessId]
        );
      } catch(e) {
        console.error('[FOOD_DELIVERY] Error insert pedido:', e.message);
      }

      await upsertCommerceSession(pgPool, inbox_id, recipient, {
        state: 'IDLE',
        cart: '[]',
        order_total_usd: 0,
        current_item: 'null'
      });

      let detailsText = '';
      if (extractedInfo && (extractedInfo.referencia || extractedInfo.banco_destino)) {
        detailsText = '\n\n📊 *Detalles del Comprobante:*' +
          (extractedInfo.banco_destino ? '\n- *Banco:* ' + extractedInfo.banco_destino : '') +
          (extractedInfo.referencia ? '\n- *Referencia:* ' + extractedInfo.referencia : '') +
          (extractedInfo.monto_bs ? '\n- *Monto Extraído:* ' + parseFloat(extractedInfo.monto_bs).toFixed(2) + ' Bs' : '');
      }

      // 1. Mensaje de recepción al cliente
      const clientAck = '¡Comprobante de pago recibido! 🧾✨\n\n' +
        'Tu pedido *#' + orderNumber + '* por *$' + finalTotalUsd.toFixed(2) + '* (Bs. ' + totalBs.toFixed(2) + ') está registrado en estado pendiente.' +
        detailsText +
        '\n\nEl administrador verificará la acreditación del pago en la cuenta bancaria. En cuanto sea confirmado por administración, tu pedido pasará de inmediato a cocina para su preparación. Te avisaremos enseguida. 🙌';
      await quickSend(clientAck);

      // 2. Alerta Inmediata a los Teléfonos de Administración (bizAdminPhones)
      if (Array.isArray(bizAdminPhones) && bizAdminPhones.length > 0 && typeof sendToPhone === 'function') {
        const adminAlertText = `🔔 *Nuevo Pago Móvil por Verificar*\n\n` +
          `📋 *Pedido:* ${orderNumber}\n` +
          `👤 *Cliente:* ${customerName || recipient} (+${recipient})\n` +
          `💰 *Total:* $${finalTotalUsd.toFixed(2)} (Bs. ${totalBs.toFixed(2)})\n` +
          (extractedInfo && extractedInfo.referencia ? `🔢 *Ref:* ${extractedInfo.referencia}\n` : '') +
          (extractedInfo && extractedInfo.banco_destino ? `🏦 *Banco:* ${extractedInfo.banco_destino}\n` : '') +
          `📍 *Modalidad:* ${deliveryType === 'delivery' ? '🛵 Delivery' : '🛍️ Retiro en Local'}` +
          (deliveryAddress ? `\n📍 *Dirección:* ${deliveryAddress}` : '') + `\n\n` +
          `*Para aprobar y enviar a cocina:*` +
          `\n👉 Escribe: *confirmar ${orderNumber.replace('ORD-', '')}*` +
          `\n\n*Para rechazar el pago:*` +
          `\n👉 Escribe: *rechazar ${orderNumber.replace('ORD-', '')}*`;

        for (const adminPhone of bizAdminPhones) {
          try {
            await sendToPhone(adminPhone, adminAlertText, msgMedia);
          } catch(e) {
            console.error('[FOOD_DELIVERY] Error enviando alerta a admin:', adminPhone, e.message);
          }
        }
      }
      return;
    }
  }

  // CASO 2: Confirmación Si/No residual
  if (session && session.state === 'WAITING_CONFIRMATION' && message_content) {
    const answer = message_content.toLowerCase().trim();
    let pendingItem = null; try { pendingItem = typeof session.current_item === 'string' ? JSON.parse(session.current_item || '{}') : (session.current_item || {}); } catch(e) {}
    const orderNumber = pendingItem ? pendingItem.order_number : null;
    await upsertCommerceSession(pgPool, inbox_id, recipient, { state: 'IDLE', current_item: 'null', cart: '[]' });
    if (answer === 'si' || answer === 'sí' || answer === 's' || answer === 'yes') {
      await quickSend('Tu pedido *' + (orderNumber || '') + '* está en revisión por administración. En cuanto sea confirmado por el administrador, te avisaremos de inmediato.');
      return;
    } else if (answer === 'no' || answer === 'n') {
      if (orderNumber) try { await pgPool.query('UPDATE botwaba.pedidos SET status=$1, updated_at=NOW() WHERE order_number=$2 AND inbox_id=$3', ['cancelled', orderNumber, inbox_id]); } catch(e) {}
      await quickSend('No hay problema. Puedes enviar el comprobante correcto cuando quieras.');
      return;
    }
  }

  // CASO 3: LLM Flow
  let menuText = '';
  if (catalogId && pgPool) {
    try {
      const { rows: allProducts } = await pgPool.query("SELECT id, retailer_id, title, description, price, category FROM meta_saas.catalog_products WHERE catalog_id = $1 AND availability = 'in stock' ORDER BY category ASC, id ASC", [catalogId]);
      if (allProducts.length > 0) {
        const grouped = {};
        allProducts.forEach(p => {
          const cat = p.category || 'Especialidades';
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(p);
        });
        const sections = [];
        for (const [catName, prods] of Object.entries(grouped)) {
          sections.push(`🍗 *${catName}*:\n` + prods.map((p, i) => `${i+1}. ${p.title} - $${parseFloat(p.price).toFixed(2)}` + (p.description ? ` (${p.description})` : '')).join('\n'));
        }
        menuText = sections.join('\n\n');
      }
    } catch (e) {}
  }

  // Cargar conocimiento oficial y manual de la empresa
  let knowledgeSnippets = '';
  if (pgPool) {
    try {
      const { rows: qas } = await pgPool.query(
        "SELECT question, answer FROM botwaba.company_knowledge WHERE inbox_id = $1 AND status = 'approved' ORDER BY id ASC LIMIT 20",
        [inbox_id]
      );
      if (qas.length > 0) {
        knowledgeSnippets = 'Información oficial y preguntas frecuentes de la empresa:\n' + qas.map(q => `- Pregunta: ${q.question}\n  Respuesta: ${q.answer}`).join('\n');
      }
    } catch (e) {}
  }

  const savedAddressText = session && session.delivery_address 
    ? `Dirección de entrega registrada: "${session.delivery_address}". No la pidas de nuevo.`
    : 'Solicita la dirección si eligen Delivery.';

  let tasaBCV = null; try { tasaBCV = await getTasaBCV(); } catch (e) {}

  const prompt = [
    `Eres el asistente virtual oficial de "${bizBusinessName}". Eres amable, atento, respetuoso y profesional.`,
    bizBusinessNature ? `Naturaleza del negocio: ${bizBusinessNature}.` : '',
    menuText ? `Menú oficial disponible:\n${menuText}` : '',
    knowledgeSnippets ? `Base de Conocimiento de la Empresa:\n${knowledgeSnippets}` : '',
    savedAddressText,
    'Tasa BCV oficial: ' + (tasaBCV ? tasaBCV.toFixed(2) : 'N/D') + ' Bs/$.',
    bizIsDelivery ? ('Costo de delivery: $' + bizDeliveryFee.toFixed(2) + '.') : 'Solo retiro en tienda disponible.',
    'El carrito de compras es acumulativo. Si el cliente solicita añadir o pedir un producto del menú, confirma el pedido y su total.',
    'REGLAS CRÍTICAS ESTRICTAS:',
    '1. Vendes ÚNICAMENTE los productos que aparecen en el menú o en la información oficial. Queda ESTRICTAMENTE PROHIBIDO inventar platos, hamburguesas, pizzas, papas fritas o cualquier producto que no esté explícitamente en la lista.',
    '2. Si el cliente pregunta por un producto que no vendes (como hamburguesas o papas fritas), indícale con amabilidad que no lo ofreces y sugiérele las especialidades reales de la casa (como pollo asado, cochino al barril, etc.).',
    '3. Si el cliente pregunta por la ubicación o sedes, métodos de pago, horarios o eventos, responde exactamente con la información oficial de la empresa.',
    '4. Agrega [DIRECCION: dirección_completa] si te dan la dirección.',
    '5. Agrega [HANDOFF] al final de tu respuesta ÚNICAMENTE si el cliente ha solicitado de manera EXPLICITA hablar con un agente humano.'
  ].filter(Boolean).join('\n\n');

  const messagesPayload = [{ role: 'system', content: prompt }, ...historyMessages, { role: 'user', content: message_content }];
  
  const llmStart = Date.now();
  let botReply = 'No pude procesar tu mensaje.';
  try {
    const { callLlmChat } = require('../llmClient');
    const llmRes = await callLlmChat({ messages: messagesPayload });
    const latencyMs = Date.now() - llmStart;

    if (llmRes.usage && typeof deductAiTokens === 'function') {
      await deductAiTokens(llmRes.usage, latencyMs, bizAdminPhones);
    }
    botReply = llmRes.content || 'No pude procesar tu mensaje.';
  } catch (err) {
    console.error('[FOOD_DELIVERY] Error en llamada LLM:', err.message);
    return;
  }
  
  const hasHandoff = botReply.includes('[HANDOFF]');
  if (hasHandoff) botReply = botReply.replace('[HANDOFF]', '').trim();

  // Extraer dirección explícita vía tag si la emitió el LLM
  let extractedAddress = null;
  const dirMatch = botReply.match(/\[DIRECCION:(.+?)\]/);
  if (dirMatch) {
    extractedAddress = dirMatch[1].trim();
    botReply = botReply.replace(/\[DIRECCION:.+?\]/g, '').trim();
  }

  // Extraer pedido estructurado si el bot emitió resumen en su respuesta
  const parsedFromBot = parseOrderFromText(botReply);
  const sessionUpdate = {};
  if (parsedFromBot) {
    if (parsedFromBot.items && parsedFromBot.items.length > 0) {
      sessionUpdate.cart = JSON.stringify(parsedFromBot.items);
      if (session) session.cart = parsedFromBot.items;
    }
    if (parsedFromBot.addr) {
      extractedAddress = parsedFromBot.addr;
    }
    if (parsedFromBot.total && parsedFromBot.total > 0) {
      sessionUpdate.order_total_usd = parsedFromBot.total;
      if (session) session.order_total_usd = parsedFromBot.total;
    }
  }

  if (extractedAddress) {
    sessionUpdate.delivery_address = extractedAddress;
    sessionUpdate.delivery_type = 'delivery';
    if (session) { session.delivery_address = extractedAddress; session.delivery_type = 'delivery'; }
  }

  if (Object.keys(sessionUpdate).length > 0) {
    try { await upsertCommerceSession(pgPool, inbox_id, recipient, sessionUpdate); } catch(e) {}
  }

  await quickSend(botReply);

  if (hasHandoff) {
    try {
      await pgPool.query('UPDATE meta_saas.conversations SET bot_enabled = false WHERE id = $1', [conversationId]);
      const msgId = `msg_bot_${Date.now()}`;
      await pgPool.query(
        `INSERT INTO messages (conversation_id, direction, content, message_id, sender_name, timestamp) VALUES ($1, $2, $3, $4, $5, $6)`,
        [conversationId, 'outbound', '⚠️ El cliente solicita atención humana. Bot desactivado.', msgId, 'BotWaba (Nota)', Math.floor(Date.now() / 1000)]
      );
    } catch (e) {}
  }
}

module.exports = { handleFoodDeliveryMessage };
