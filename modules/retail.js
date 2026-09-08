// modules/retail.js
'use strict';
const crypto = require('crypto');
const { getTasaBCV } = require('../bcvScraper');

async function handleRetailMessage({
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
  var bizBusinessName = (bizConfig) ? bizConfig.business_name : 'Negocio Retail';
  var bizBusinessNature = (bizConfig) ? bizConfig.business_nature : 'Tienda y Comercio';
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

  // ── MÓDULO COMMERCE: Procesar pedido/carrito nativo ──
  const isOrderMsg = (payload.messageType === 'order') || (payload.order_payload);
  if (isOrderMsg && payload.order_payload) {
    console.log('[RETAIL] Procesando carrito nativo enviado por el cliente...');
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

  // List replies
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
              body: { text: "Explora y agrega más productos al carrito:" },
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
        await quickSend('Tu carrito está vacío. 😅 Selecciona tus productos.');
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

  // CASO 1: Captura de comprobante
  const msgType = payload.messageType || 'text';
  const msgText = (payload.messageText || message_content || '').toLowerCase();
  const msgMedia = payload.mediaUrl || null;
  if (msgType === 'image' && msgMedia && session) {
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
      
      let deliveryType = session.delivery_type || 'pickup';
      let deliveryAddress = session.delivery_address || null;
      if (payload.location) {
        const loc = payload.location;
        deliveryAddress = (loc.name || loc.address || 'Sin referencia') + ' (lat:' + loc.latitude + ', lng:' + loc.longitude + ')';
        deliveryType = 'delivery';
      }
      const deliveryFee = deliveryType === 'delivery' ? bizDeliveryFee : 0;
      let totalUsd = parseFloat(session.order_total_usd || 0);
      const totalBs = (totalUsd + deliveryFee) * orderRate;
      const paymentInfo = { ...(bizPaymentMovil || {}), extracted: extractedInfo };
      
      try {
        await pgPool.query('INSERT INTO botwaba.pedidos (order_number, inbox_id, customer_phone, items, subtotal_usd, delivery_fee_usd, total_usd, total_bs, bcv_rate, delivery_type, delivery_address, payment_info, proof_media_url, status, business_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [orderNumber, inbox_id, recipient, JSON.stringify(session.cart || '[]'), totalUsd, deliveryFee, totalUsd + deliveryFee, totalBs, orderRate, deliveryType, deliveryAddress, JSON.stringify(paymentInfo), msgMedia, 'pending', bizBusinessId]);
      } catch(e) {}
      await upsertCommerceSession(pgPool, inbox_id, recipient, { state: 'IDLE', cart: '[]', order_total_usd: 0, current_item: 'null' });
      
      let detailsText = '';
      if (extractedInfo && (extractedInfo.referencia || extractedInfo.banco_destino)) {
        detailsText = '\n\n📊 *Detalles del Comprobante:*' +
          (extractedInfo.banco_destino ? '\n- *Banco:* ' + extractedInfo.banco_destino : '') +
          (extractedInfo.referencia ? '\n- *Referencia:* ' + extractedInfo.referencia : '') +
          (extractedInfo.monto_bs ? '\n- *Monto Extraído:* ' + parseFloat(extractedInfo.monto_bs).toFixed(2) + ' Bs' : '');
      }

      // 1. Mensaje al Cliente
      const clientAck = '¡Comprobante de pago recibido! 🧾✨\n\n' +
        'Tu pedido *#' + orderNumber + '* por *$' + (totalUsd + deliveryFee).toFixed(2) + '* (Bs. ' + totalBs.toFixed(2) + ') está registrado en estado pendiente.' +
        detailsText +
        '\n\nEl administrador verificará la acreditación del pago en la cuenta bancaria. En cuanto sea confirmado por administración, procederemos con el despacho. Te avisaremos enseguida. 🙌';
      await quickSend(clientAck);

      // 2. Alerta Inmediata a los Administradores
      if (Array.isArray(bizAdminPhones) && bizAdminPhones.length > 0 && typeof sendToPhone === 'function') {
        const adminAlertText = `🔔 *Nuevo Pago Móvil por Verificar*\n\n` +
          `📋 *Pedido:* ${orderNumber}\n` +
          `👤 *Cliente:* ${customerName || recipient} (+${recipient})\n` +
          `💰 *Total:* $${(totalUsd + deliveryFee).toFixed(2)} (Bs. ${totalBs.toFixed(2)})\n` +
          (extractedInfo && extractedInfo.referencia ? `🔢 *Ref:* ${extractedInfo.referencia}\n` : '') +
          (extractedInfo && extractedInfo.banco_destino ? `🏦 *Banco:* ${extractedInfo.banco_destino}\n` : '') +
          `📍 *Modalidad:* ${deliveryType === 'delivery' ? '🛵 Delivery' : '🛍️ Retiro en Tienda'}` +
          (deliveryAddress ? `\n📍 *Dirección:* ${deliveryAddress}` : '') + `\n\n` +
          `*Para aprobar:*` +
          `\n👉 Escribe: *confirmar ${orderNumber.replace('ORD-', '')}*` +
          `\n\n*Para rechazar el pago:*` +
          `\n👉 Escribe: *rechazar ${orderNumber.replace('ORD-', '')}*`;

        for (const adminPhone of bizAdminPhones) {
          try {
            await sendToPhone(adminPhone, adminAlertText, msgMedia);
          } catch(e) {
            console.error('[RETAIL] Error enviando alerta a admin:', adminPhone, e.message);
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

  // Búsqueda Semántica Vectorial con pgvector (RAG sobre Catálogo)
  let vectorSearchContext = '';
  if (msgText && msgText.trim().length > 3) {
    try {
      const embRes = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: msgText })
      });
      const embJson = await embRes.json();
      if (embJson.data?.[0]?.embedding) {
        const queryVec = `[${embJson.data[0].embedding.join(',')}]`;
        const { rows: matches } = await pgPool.query(`
          SELECT title, price, description, category, (1 - (embedding <=> $1::vector)) AS similarity
          FROM meta_saas.catalog_products
          WHERE catalog_id = $2 AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT 3;
        `, [queryVec, catalogId]);
        if (matches && matches.length > 0) {
          vectorSearchContext = '\n--- BÚSQUEDA SEMÁNTICA PGVECTOR (Productos sugeridos por inteligencia vectorial) ---\n' +
            matches.map(m => `- ${m.title} ($${parseFloat(m.price).toFixed(2)}) - ${m.description || ''}`).join('\n') + '\n';
        }
      }
    } catch (vErr) {}
  }

  // Cargar catálogo completo para asegurar acceso a todos los servicios/productos en el prompt
  let catalogText = '';
  if (catalogId && pgPool) {
    try {
      const { rows: allProducts } = await pgPool.query(
        "SELECT title, description, price, category FROM meta_saas.catalog_products WHERE catalog_id = $1 AND availability = 'in stock' ORDER BY category ASC, id ASC",
        [catalogId]
      );
      if (allProducts.length > 0) {
        catalogText = '\n--- CATÁLOGO DE PRODUCTOS / SERVICIOS DISPONIBLES ---\n' +
          allProducts.map(p => `- ${p.title} ($${parseFloat(p.price).toFixed(2)}) - ${p.description || ''}`).join('\n') + '\n';
      }
    } catch(e) {}
  }

  let historyMessages = [];
  try {
    const { rows: hr } = await pgPool.query('SELECT direction, content FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC', [conversationId]);
    historyMessages = hr.slice(-30).map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }));
    if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].content === message_content) historyMessages.pop();
  } catch (e) {}

  const savedAddressText = session && session.delivery_address 
    ? `Dirección de entrega: "${session.delivery_address}". No la pidas de nuevo.`
    : 'Solicita la dirección si eligen Delivery.';

  let tasaBCV = null; try { tasaBCV = await getTasaBCV(); } catch (e) {}

  const prompt = [
    'Eres un asesor de ventas de "' + bizBusinessName + '" (Ferretería/Repuestos/Farmacia).',
    catalogText,
    vectorSearchContext,
    savedAddressText,
    'Tasa BCV: ' + (tasaBCV ? tasaBCV.toFixed(2) : 'N/D') + ' Bs/$.',
    'Si eligen delivery cobra $' + bizDeliveryFee.toFixed(2) + '.',
    'El carrito de compras es acumulativo. Confirma el carrito en cada respuesta al cliente.',
    'Agrega [DIRECCION: dirección_completa] si te dan la dirección.',
    'Agrega [HANDOFF] al final de tu respuesta ÚNICAMENTE si el cliente ha solicitado de manera EXPLICITA hablar con un agente humano o soporte físico. NUNCA agregues [HANDOFF] si eres tú quien ofrece o sugiere la opción.'
  ].join('\n');

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
    console.error('[RETAIL] Error en llamada LLM:', err.message);
    return;
  }
  
  const hasHandoff = botReply.includes('[HANDOFF]');
  if (hasHandoff) botReply = botReply.replace('[HANDOFF]', '').trim();

  const dirMatch = botReply.match(/\[DIRECCION:(.+?)\]/);
  if (dirMatch) {
    const extractedAddress = dirMatch[1].trim();
    botReply = botReply.replace(/\[DIRECCION:.+?\]/g, '').trim();
    try { await upsertCommerceSession(pgPool, inbox_id, recipient, { delivery_address: extractedAddress }); } catch(e) {}
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

module.exports = { handleRetailMessage };
