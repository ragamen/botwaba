require('dotenv').config();
const { handleCommerceMessage } = require('./commerceBot');
const { setRedisClient: setBCVRedis, getTasaBCV, setPgPool: setBCVPgPool } = require('./bcvScraper');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const Ably = require('ably');
const { Pool } = require('pg');
const redis = require('redis');

// Configuraci??n de Redis
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = redis.createClient({ url: redisUrl });

redisClient.on('error', (err) => console.error('[Redis] ??? Error:', err));
redisClient.connect().then(() => {
  console.log('[Redis] ???? Conectado exitosamente en aiService');
  setBCVRedis(redisClient); // Pasar Redis al scraper BCV para cache de tasa
}).catch((err) => {
  console.error('[Redis] ??? Error de conexi??n en aiService:', err.message);
});



// Configuraci??n de Supabase y Globales
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // Nota: Actualizado a SUPABASE_KEY seg??n tu requerimiento
const openRouterApiKey = process.env.OPENROUTER_API_KEY;
const modeloPorDefecto = process.env.MODELO_POR_DEFECTO || 'glm-5.3-flash:cloud';
const { callLlmChat } = require('./llmClient');
const ablyKey = process.env.ABLY_API_KEY;
const postgresUrl = process.env.POSTGRES_URL;

let supabase = null;
let supabaseMeta = null;
let pgPool = null;

if (postgresUrl) {
  pgPool = new Pool({
    connectionString: postgresUrl,
    options: '-c search_path=meta_saas,public'
  });
setBCVPgPool(pgPool);
}

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket },
    db: { schema: 'botwaba' }
  });
  
  supabaseMeta = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket },
    db: { schema: 'meta_saas' }
  });
} else {
  console.warn('[BOT] ?????? Advertencia: Falta configurar SUPABASE_URL o SUPABASE_KEY en .env');
}

/**
 * Verifica si la ventana de 24 horas est?? abierta para un cliente.
 * Usa Redis como cach?? r??pida y la Base de Datos como respaldo.
 */
async function checkAndRefreshWindow(inbox_id, recipient, conversationId) {
  const windowCacheKey = `inbox:${inbox_id}:window:${recipient}`;

  try {
    const isCached = await redisClient.get(windowCacheKey);
    if (isCached === 'true') {
      return true;
    }
  } catch (err) {
    console.warn('[Redis] Error al consultar ventana de 24 horas:', err.message);
  }

  console.log(`[BOT] ???? Ventana no encontrada en Redis. Consultando base de datos para cliente: ${recipient}...`);
  let lastInboundTime = null;

  try {
    if (pgPool) {
      const { rows } = await pgPool.query(
        `SELECT timestamp FROM messages 
         WHERE conversation_id = $1 AND direction = 'inbound' 
         ORDER BY timestamp DESC LIMIT 1`,
        [conversationId]
      );
      if (rows && rows.length > 0) {
        lastInboundTime = parseInt(rows[0].timestamp);
      }
    } else {
      const { data, error } = await supabaseMeta
        .from('messages')
        .select('timestamp')
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .order('timestamp', { ascending: false })
        .limit(1);
      if (!error && data && data.length > 0) {
        lastInboundTime = parseInt(data[0].timestamp);
      }
    }
  } catch (err) {
    console.error('[BOT] Error consultando ??ltimo timestamp en BD:', err.message);
  }

  const now = Math.floor(Date.now() / 1000);
  let isOpen = false;

  if (lastInboundTime) {
    const elapsedSeconds = now - lastInboundTime;
    isOpen = elapsedSeconds < 86400;
    
    if (isOpen) {
      const remainingTTL = Math.max(1, 86400 - elapsedSeconds);
      try {
        await redisClient.set(windowCacheKey, 'true', { EX: remainingTTL });
      } catch (err) {
        console.warn('[Redis] Error guardando ventana en cach??:', err.message);
      }
    }
  } else {
    // Si no hay mensajes previos en BD, asumimos que este mensaje entrante abre la ventana.
    isOpen = true;
    try {
      await redisClient.set(windowCacheKey, 'true', { EX: 86400 });
    } catch (err) {
      console.warn('[Redis] Error guardando ventana inicial en cach??:', err.message);
    }
  }

  return isOpen;
}

// ====== SISTEMA DE DEBOUNCE (ANTI-SPAM / DOBLE RESPUESTA) ======
const messageQueues = new Map();

/**
 * Envoltorio para encolar mensajes que llegan muy rápido y evitar que el bot responda doble.
 */
async function processMessage(payload) {
  const { recipient, phoneNumberId, message, button_text, button, location } = payload;
  
  // Extraer texto
  let text = '';
  if (message) {
    if (typeof message === 'string') text = message;
    else if (typeof message === 'object') text = message.body || message.text || message.button?.text || '';
  } else if (button_text) {
    text = button_text;
  } else if (button?.text) {
    text = button.text;
  }

  // Clave única por WABA y Cliente
  const queueKey = `${phoneNumberId}_${recipient}`;

  if (!messageQueues.has(queueKey)) {
    messageQueues.set(queueKey, {
      timer: null,
      messages: [],
      payloads: []
    });
  }

  const queue = messageQueues.get(queueKey);
  
  // Agregar texto o una marca de (Ubicación)
  if (text.trim() !== '') {
    queue.messages.push(text.trim());
  } else if (location) {
    queue.messages.push('(Ubicación recibida)');
  }
  
  queue.payloads.push(payload);

  if (queue.timer) clearTimeout(queue.timer);

  queue.timer = setTimeout(async () => {
    messageQueues.delete(queueKey);
    
    // Unir todos los textos recibidos en este lapso
    const mergedText = queue.messages.join('\n');
    // Tomar el último payload como base
    const finalPayload = queue.payloads[queue.payloads.length - 1];
    
    // Sobrescribir el mensaje con el texto unificado (si hubo texto)
    if (mergedText) {
      if (typeof finalPayload.message === 'object') {
        if (finalPayload.message.text) finalPayload.message.text = mergedText;
        else if (finalPayload.message.body) finalPayload.message.body = mergedText;
      } else {
        finalPayload.message = mergedText;
      }
      finalPayload.messageText = mergedText;
    }
    
    console.log(`[DEBOUNCE] Procesando lote de ${queue.messages.length} mensajes para ${recipient}.`);
    await doProcessMessage(finalPayload);
  }, 300); // 300ms de agrupación para máxima velocidad de respuesta ultrarrápida
}
// ===============================================================

/**
 * Procesa as??ncronamente el mensaje entrante desde el SaaS CRM.
 */
async function doProcessMessage(payload) {
  if (!pgPool && (!supabase || !supabaseMeta)) {
    console.error('[BOT] ❌ No hay cliente de base de datos configurado. Ignorando mensaje.');
    return;
  }

  if (!openRouterApiKey) {
    console.error('[BOT] ??? Falta OPENROUTER_API_KEY en el entorno global.');
    return;
  }

  const { recipient, message, phoneNumberId, wabaId, accessToken, userId, conversationId, platform = 'whatsapp' } = payload;

  // --- PARCHE PARA SOPORTE DE BOTONES (PLANTILLAS INTERACTIVAS) ---
  let message_content = '';
  if (message) {
    if (typeof message === 'string') {
      message_content = message;
    } else if (typeof message === 'object') {
      // Si el SaaS te mapea el bot??n dentro del objeto message
      message_content = message.body || message.text || message.button?.text || '';
    }
  } else if (payload.button_text) {
    // Por si el SaaS extrae el bot??n directamente en la ra??z del payload
    message_content = payload.button_text;
  } else if (payload.button?.text) {
    message_content = payload.button.text;
  }
  // -----------------------------------------------------------------

  const realPhoneNumberId = phoneNumberId;
  let inbox_id = phoneNumberId; // Usamos phoneNumberId para que CADA NÚMERO tenga su propio bot independiente

  // === DEMO SWITCH: Resolver inbox_id efectivo ===
  let effectiveInboxId = inbox_id;
  if (pgPool) {
    try {
      const { rows: demoRows } = await pgPool.query(
        `SELECT sc_active.inbox_id 
         FROM meta_saas.saas_clients sc_active
         WHERE sc_active.is_active_demo = true
         AND sc_active.whatsapp_number = (
           SELECT whatsapp_number FROM meta_saas.saas_clients 
           WHERE inbox_id = $1 LIMIT 1
         ) LIMIT 1`,
        [inbox_id]
      );
      if (demoRows.length > 0 && demoRows[0].inbox_id !== inbox_id) {
        effectiveInboxId = demoRows[0].inbox_id;
        console.log(`[BOT] 🔄 DEMO SWITCH: Redirigiendo inbox_id ${inbox_id} → ${effectiveInboxId}`);
      }
    } catch (err) {
      console.warn('[BOT] ⚠️ Error en demo switch lookup:', err.message);
    }
  }

  // --- APLICAR DEMO SWITCH AL CONTEXTO ---
  inbox_id = effectiveInboxId;
  payload.inbox_id = effectiveInboxId;
  
  if (!phoneNumberId || !conversationId) {
    console.warn('[BOT] ⚠️ Faltan datos (phoneNumberId, conversationId). Ignorando.');
    return;
  }
  console.log(`[BOT] 📱 Número: ${phoneNumberId} | Conversación CRM: ${conversationId} | Effective inbox: ${effectiveInboxId}`);

  const sendAlertToPhone = async (phone, text) => {
    const p = String(phone).replace(/^\+/, '');
    const msgId = 'msg_bot_' + Date.now();
    const msgBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: p,
      type: 'text',
      text: { preview_url: false, body: text }
    };
    try {
      await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgBody)
      });
      if (pgPool) {
        await pgPool.query(
          `INSERT INTO messages (conversation_id, direction, content, message_id, sender_name, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [conversationId, 'outbound', text, msgId, 'Sistema (Alerta)', Math.floor(Date.now() / 1000)]
        );
      }
    } catch (e) {
      console.error('[BALANCE] Error enviando alerta al teléfono:', e.message);
    }
  };

  const sendTypingIndicator = async (phone) => {
    const p = String(phone).replace(/^\+/, '');
    const msgBody = {
      messaging_product: 'whatsapp',
      to: p,
      type: 'typing_indicator',
      typing_indicator: { type: 'text' }
    };
    try {
      await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgBody)
      });
    } catch (e) {
      console.warn('[BOT] Error enviando typing indicator:', e.message);
    }
  };

  // 1. Mostrar estado de "escribiendo..." al cliente inmediatamente
  sendTypingIndicator(recipient).catch(() => {});

  const deductAiTokens = async (usage, latencyMs, bizAdminPhones = []) => {
    if (!pgPool) return;
    try {
      const inputTokens = usage?.prompt_tokens || 0;
      const outputTokens = usage?.completion_tokens || 0;
      const totalTokens = usage?.total_tokens || (inputTokens + outputTokens);
      const costUsd = (inputTokens * 0.0000001) + (outputTokens * 0.0000003);

      await pgPool.query(
        `INSERT INTO botwaba.token_usage_log 
         (inbox_id, customer_phone, conversation_id, module, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms) 
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [inbox_id, recipient, conversationId, botModuleType, aiModel, inputTokens, outputTokens, totalTokens, costUsd, latencyMs]
      );
      console.log(`[BALANCE] Deduciendo ${totalTokens} tokens para inbox_id: ${inbox_id}`);

      const { rows } = await pgPool.query('SELECT * FROM botwaba.user_ai_balance WHERE inbox_id = $1 LIMIT 1', [inbox_id]);
      if (rows.length > 0) {
        const balance = rows[0];
        const newConsumed = parseInt(balance.tokens_consumed) + totalTokens;
        let isPaused = balance.is_paused;
        if (newConsumed >= balance.total_tokens_purchased) {
          isPaused = true;
        }

        await pgPool.query(
          'UPDATE botwaba.user_ai_balance SET tokens_consumed = $1, is_paused = $2 WHERE inbox_id = $3',
          [newConsumed, isPaused, inbox_id]
        );

        const percentage = (newConsumed / balance.total_tokens_purchased) * 100;
        if (percentage >= 80 && !balance.alert_80_sent && !isPaused) {
          const adminPhone = bizAdminPhones[0] || null;
          if (adminPhone) {
            const remainingTokens = Math.max(0, parseInt(balance.total_tokens_purchased) - newConsumed);
            const warningMsg = `⚠️ *Alerta de Saldo IA:* Has consumido el ${percentage.toFixed(1)}% de tus créditos de IA. Te quedan menos de ${remainingTokens} tokens. Por favor, recarga saldo en tu panel para evitar interrupciones de servicio.`;
            await sendAlertToPhone(adminPhone, warningMsg);
            await pgPool.query('UPDATE botwaba.user_ai_balance SET alert_80_sent = true WHERE inbox_id = $1', [inbox_id]);
            console.log(`[BALANCE] Alerta de saldo enviada al administrador: ${adminPhone}`);
          }
        }
      }
    } catch (e) {
      console.error('[BALANCE] Error deduciendo tokens:', e.message);
    }
  };

  // 1. Establecer/Refrescar la ventana de 24 horas en Redis (Mensaje entrante)
  const windowCacheKey = `inbox:${inbox_id}:window:${recipient}`;
  try {
    await redisClient.set(windowCacheKey, 'true', { EX: 86400 });
    console.log(`[BOT] ???? Ventana de 24 horas actualizada en Redis para cliente: ${recipient}`);
  } catch (err) {
    console.warn(`[BOT] ?????? Error al establecer ventana de 24 horas en Redis:`, err.message);
  }

  // 2. Obtener datos din??micos (Cach?? de Configuraci??n o Supabase)
  let botConfig = null;
  const configCacheKey = `inbox:${effectiveInboxId}:config`;
  
  try {
    const cachedConfig = await redisClient.get(configCacheKey);
    if (cachedConfig) {
      botConfig = JSON.parse(cachedConfig);
      console.log(`[BOT] ✅ Configuración cargada desde caché de Redis para inbox_id: ${effectiveInboxId}`);
    }
  } catch (err) {
    console.warn(`[BOT] ?????? Error al leer cach?? de configuraci??n:`, err.message);
  }

  if (!botConfig) {
    console.log(`[BOT] 📡 Consultando base de datos para obtener configuración de inbox_id: ${effectiveInboxId}...`);
    let cliente = null;
    let saasClient = null;

    if (pgPool) {
      try {
        const { rows: cbRows } = await pgPool.query(
          'SELECT ai_model, system_prompt, bot_module_type, is_delivery_enabled, address_details, payment_pago_movil, commerce_settings FROM botwaba.clientes_bot WHERE inbox_id = $1 LIMIT 1',
          [effectiveInboxId]
        );
        if (cbRows.length > 0) cliente = cbRows[0];

        const { rows: scRows } = await pgPool.query(
          'SELECT company_name, business_nature, status, created_at, subscription_expires_at FROM meta_saas.saas_clients WHERE inbox_id = $1 LIMIT 1',
          [effectiveInboxId]
        );
        if (scRows.length > 0) saasClient = scRows[0];
      } catch (pgErr) {
        console.error('[BOT] Error consultando PostgreSQL para botConfig:', pgErr.message);
      }
    }

    if (!cliente && supabase) {
      try {
        const { data: c } = await supabase
          .from('clientes_bot')
          .select('ai_model, system_prompt, bot_module_type, is_delivery_enabled, address_details, payment_pago_movil, commerce_settings')
          .eq('inbox_id', effectiveInboxId)
          .single();
        cliente = c;
      } catch (e) {}
    }

    if (!saasClient && supabaseMeta) {
      try {
        const { data: sc } = await supabaseMeta
          .from('saas_clients')
          .select('company_name, business_nature, status, created_at, subscription_expires_at')
          .eq('inbox_id', effectiveInboxId)
          .single();
        saasClient = sc;
      } catch (e) {}
    }

    if (!cliente) {
      console.error(`[BOT] ❌ No se encontró cliente para inbox_id ${effectiveInboxId}`);
      return;
    }

    botConfig = {
      aiModel: cliente.ai_model || modeloPorDefecto,
      system_prompt: cliente.system_prompt || '',
      activeBusinessName: saasClient?.company_name || 'Nuestra Empresa',
      activeBusinessNature: saasClient?.business_nature || 'Empresa Comercial',
      botModuleType: cliente.bot_module_type || 'basic_qa',
      activeIsDelivery: cliente.is_delivery_enabled === true,
      activeAddress: cliente.address_details || {},
      activePaymentMovil: cliente.payment_pago_movil || {},
      commerceSettings: cliente.commerce_settings || {},
      status: saasClient?.status || 'Active',
      created_at: saasClient?.created_at || null,
      subscription_expires_at: saasClient?.subscription_expires_at || null
    };

    // Guardar en cach?? Redis por 10 minutos (600 segundos)
    try {
      await redisClient.set(configCacheKey, JSON.stringify(botConfig), { EX: 600 });
      console.log(`[BOT] 💾 Configuración guardada en caché de Redis para inbox_id: ${effectiveInboxId}`);
    } catch (err) {
      console.warn(`[BOT] ?????? Error al guardar configuraci??n en cach??:`, err.message);
    }
  }

  const { aiModel, system_prompt, activeBusinessName, activeBusinessNature, botModuleType, activeIsDelivery, activeAddress, activePaymentMovil, commerceSettings, status, created_at, subscription_expires_at } = botConfig;

  // 1. Guardarropa de Seguridad: Si el cliente está suspendido o inactivo en el CRM
  if (status && status.toLowerCase() !== 'active') {
    console.log(`[BOT] ⚠️ El cliente con inbox_id ${inbox_id} no está activo (Estado: ${status}). El bot no responderá.`);
    return;
  }

  // 1.3. Control Temporal de Suscripción (Prueba 3 días, Corte al día 5, Mensualidad recurrente)
  const now = new Date();
  const createdDate = created_at ? new Date(created_at) : now;
  const subExpiresDate = subscription_expires_at ? new Date(subscription_expires_at) : null;

  let isExpired = false;
  let isGracePeriod = false;

  // El inbox de administración principal jamás expira
  const isAdminInbox = inbox_id === '1213848621804009';

  if (!isAdminInbox) {
    if (!subExpiresDate) {
      // Si no ha pagado, evaluamos los límites desde el registro (created_at)
      const diffMs = now.getTime() - createdDate.getTime();
      const trialMs = 3 * 24 * 60 * 60 * 1000; // 3 días gratis
      const graceMs = 5 * 24 * 60 * 60 * 1000; // Corte al día 5

      if (diffMs > graceMs) {
        isExpired = true;
      } else if (diffMs > trialMs) {
        isGracePeriod = true;
      }
    } else {
      // Si tiene suscripción paga, expira al término del plazo
      if (now.getTime() > subExpiresDate.getTime()) {
        isExpired = true;
      }
    }
  }

  if (isExpired && botModuleType !== 'disabled' && botModuleType !== 'taxi') {
    console.log(`[BOT] ⚠️ Suscripción vencida o período de gracia de 5 días agotado para inbox_id: ${inbox_id}. Bloqueando.`);
    
    // Auto-suspender en la base de datos de forma asíncrona
    try {
      if (pgPool) {
        await pgPool.query("UPDATE meta_saas.saas_clients SET status = 'Suspended' WHERE inbox_id = $1", [inbox_id]);
      }
    } catch (e) {}

    const alertMsg = "⚠️ Este asistente virtual se encuentra suspendido por vencimiento de suscripción. Por favor contacta al administrador.";
    try {
      await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "text",
          text: { preview_url: false, body: alertMsg }
        })
      });
    } catch (sendErr) {
      console.error('[BOT] Error enviando alerta de suspensión temporal:', sendErr.message);
    }
    return;
  }

  // 1.5. Control de Saldo Prepago de IA
  let isAiBalanceOk = true;
  let aiBalance = null;
  if (pgPool) {
    try {
      const { rows: balRows } = await pgPool.query('SELECT * FROM botwaba.user_ai_balance WHERE inbox_id = $1 LIMIT 1', [inbox_id]);
      if (balRows.length > 0) {
        aiBalance = balRows[0];
        if (aiBalance.is_paused || parseInt(aiBalance.tokens_consumed) >= parseInt(aiBalance.total_tokens_purchased)) {
          isAiBalanceOk = false;
        }
      }
    } catch (balErr) {
      console.error('[BALANCE] Error consultando saldo:', balErr.message);
    }
  }

  // Si el saldo est?? agotado, bloquear respuesta del bot de IA
  if (!isAiBalanceOk && botModuleType !== 'disabled' && botModuleType !== 'taxi') {
    console.log(`[BALANCE] ⚠️ Saldo agotado o bot pausado para inbox_id: ${inbox_id}. Bloqueando respuesta.`);
    const msgId = `msg_bot_${Date.now()}`;
    const alertMsg = "⚠️ El asistente virtual de este negocio está de manera temporal fuera de servicio por límite de saldo de IA.";
    try {
      const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: false, body: alertMsg }
      };
      await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (pgPool) {
        await pgPool.query(
          `INSERT INTO messages (conversation_id, direction, content, message_id, sender_name, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [conversationId, 'outbound', alertMsg, msgId, 'Sistema (Saldo)', Math.floor(Date.now() / 1000)]
        );
        await pgPool.query('UPDATE botwaba.user_ai_balance SET is_paused = true WHERE inbox_id = $1', [inbox_id]);
      }
    } catch (sendErr) {
      console.error('[BALANCE] Error enviando alerta de saldo agotado:', sendErr.message);
    }
    return;
  }

  // 2. Guardarropa de Seguridad: Si el administrador desactiv?? el m??dulo de bot para este cliente
  if (botModuleType === 'disabled') {
    console.log(`[BOT] ???? M??dulo de bot desactivado ("disabled") para el cliente inbox_id ${inbox_id}. El bot no responder??.`);
    return;
  }

  // 3. Ruteo de Microservicio de Taxi: Si es bot de taxi, reenviamos a la URL oficial
  if (botModuleType === 'taxi') {
    console.log(`[BOT] ???? Ruteando mensaje al microservicio de Taxi Bot en https://taxibot.mbtech.work/webhook para inbox_id ${inbox_id}...`);
    try {
      if (payload.rawPayload) {
        const response = await fetch('https://taxibot.mbtech.work/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.rawPayload)
        });
        console.log(`[BOT] ???? Respuesta del microservicio Taxi Bot: ${response.status}`);
      } else {
        console.warn(`[BOT] ?????? No se recibi?? rawPayload para reenviar al Taxi Bot.`);
      }
    } catch (err) {
      console.error('[BOT] ??? Error enviando mensaje al microservicio de Taxi Bot:', err.message);
    }
    return;
  }

  // Helper: extraer numero de texto natural
  function extractNumber(text) {
    if (!text) return NaN;
    const m = String(text).match(/\d+/);
    return m ? parseInt(m[0]) : NaN;
  }
  // Helper: emoji por categoria
  function getCategoryEmoji(category) {
    const c = (category || '').toLowerCase().trim();
    if (c.includes('pizza')) return String.fromCodePoint(0x1F355);
    if (c.includes('hamburg') || c.includes('burger')) return String.fromCodePoint(0x1F354);
    if (c.includes('refresco') || c.includes('bebida') || c.includes('drink') || c.includes('soda')) return String.fromCodePoint(0x1F379);
    if (c.includes('postre') || c.includes('dessert')) return String.fromCodePoint(0x1F370);
    if (c.includes('franela') || c.includes('camisa') || c.includes('ropa')) return String.fromCodePoint(0x1F455);
    if (c.includes('zapato') || c.includes('calzado')) return String.fromCodePoint(0x1F45F);
    if (c.includes('pantal') || c.includes('jean')) return String.fromCodePoint(0x1F456);
    if (c.includes('ferreter') || c.includes('hardware')) return String.fromCodePoint(0x1F527);
    if (c.includes('perro') || c.includes('hot dog')) return String.fromCodePoint(0x1F32D);
    if (c.includes('arepa')) return String.fromCodePoint(0x1F950);
    if (c.includes('pollo') || c.includes('chicken')) return String.fromCodePoint(0x1F414);
    if (c.includes('ensalada') || c.includes('salad')) return String.fromCodePoint(0x1F957);
    if (c.includes('taco')) return String.fromCodePoint(0x1F32E);
    if (c.includes('cerveza') || c.includes('beer')) return String.fromCodePoint(0x1F37A);
    if (c.includes('caf')) return String.fromCodePoint(0x2615);
    return String.fromCodePoint(0x1F4CB);
  }

  // Helper: upsert sesion de commerce
  async function upsertCommerceSession(pool, inboxId, phone, updates) {
    try {
      const keys = Object.keys(updates);
      const sets = keys.map((k, i) => k + '=$' + (i + 3)).join(', ');
      const vals = Object.values(updates);
      await pool.query(
        'INSERT INTO botwaba.commerce_sessions (inbox_id, customer_phone, ' + keys.join(', ') + ') ' +
        'VALUES ($1, $2, ' + vals.map((_, i) => '$' + (i + 3)).join(', ') + ') ' +
        'ON CONFLICT (inbox_id, customer_phone) DO UPDATE SET ' + sets + ', updated_at=NOW()',
        [inboxId, phone, ...vals]
      );
    } catch (e) { console.warn('[COMMERCE] upsertSession error:', e.message); }
  }

  // 3.5. Modulo Commerce: Comandos de admin (vendedor) por WhatsApp
  if (botModuleType === 'commerce') {
    // Cargar admin_phones de commerce_businesses + commerce_settings
    let adminPhones = [];
    let adminBusinesses = [];
    try {
      if (pgPool) {
        const { rows: ab } = await pgPool.query("SELECT id, business_name, admin_phones FROM botwaba.commerce_businesses WHERE inbox_id=$1 AND is_active=true", [effectiveInboxId]);
        for (const b of ab) {
          if (Array.isArray(b.admin_phones) && b.admin_phones.length > 0) {
            adminBusinesses.push(b);
            adminPhones = adminPhones.concat(b.admin_phones);
          }
        }
      }
    } catch(e) {}
    // Tambien incluir admin_phones de clientes_bot (backward compatible)
    if (commerceSettings && Array.isArray(commerceSettings.admin_phones)) {
      adminPhones = adminPhones.concat(commerceSettings.admin_phones);
    }
    adminPhones = [...new Set(adminPhones.map(p => String(p).replace(/^\+/, '')))];
    const senderPhone = String(recipient).replace(/^\+/, '');
    const isAdmin = adminPhones.some(p => String(p).replace(/^\+/, '') === senderPhone);

    // Cargar driver_phones y verificar si el remitente es motorizado
    let isDriver = false;
    let driverBusinessId = null;
    let driverBusinessName = '';
    try {
      if (pgPool) {
        const { rows: dbDrivers } = await pgPool.query(
          "SELECT id, business_name FROM botwaba.commerce_businesses WHERE inbox_id=$1 AND is_active=true AND driver_phones @> $2::jsonb LIMIT 1",
          [effectiveInboxId, JSON.stringify([senderPhone])]
        );
        if (dbDrivers.length > 0) {
          isDriver = true;
          driverBusinessId = dbDrivers[0].id;
          driverBusinessName = dbDrivers[0].business_name;
        } else {
          // Fallback a clientes_bot para modo single-business (cargado en commerce_settings)
          const { rows: cb } = await pgPool.query(
            "SELECT commerce_settings FROM botwaba.clientes_bot WHERE inbox_id=$1 LIMIT 1",
            [effectiveInboxId]
          );
          if (cb.length > 0 && cb[0].commerce_settings) {
            const cs = cb[0].commerce_settings;
            if (Array.isArray(cs.driver_phones)) {
              const matches = cs.driver_phones.map(p => String(p).replace(/^\+/, '')).includes(senderPhone);
              if (matches) {
                isDriver = true;
                driverBusinessId = null;
                // Intentar obtener el nombre de la empresa
                const { rows: sc } = await pgPool.query(
                  "SELECT company_name FROM meta_saas.saas_clients WHERE inbox_id=$1 LIMIT 1",
                  [effectiveInboxId]
                );
                driverBusinessName = sc.length > 0 ? sc[0].company_name : 'Negocio General';
              }
            }
          }
        }
      }
    } catch(e) {}

    // Helper general: enviar a un numero especifico + persistir en BD + Ably
    const sendToPhone = async (phone, text, imageUrl) => {
      const p = String(phone).replace(/^\+/, '');
      const msgId = 'msg_bot_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
      const msgBody = imageUrl
        ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: p, type: 'image', image: { link: imageUrl, caption: text } }
        : { messaging_product: 'whatsapp', recipient_type: 'individual', to: p, type: 'text', text: { preview_url: false, body: text } };
      try {
        const res = await fetch('https://graph.facebook.com/v20.0/' + phoneNumberId + '/messages', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(msgBody) });
        if (!res.ok) {
          const errText = await res.text();
          console.error(`[COMMERCE] sendToPhone fallo a ${p} (${res.status}): ${errText}`);
        } else {
          console.log(`[COMMERCE] sendToPhone enviado con éxito a ${p}`);
        }
      } catch (e) { console.error('[COMMERCE] sendToPhone error:', e.message); }
      // Persistir en messages
      let targetConvId = conversationId;
      if (p !== senderPhone && pgPool) {
        try {
          const { rows: cr } = await pgPool.query('SELECT id FROM meta_saas.conversations WHERE phone_number_id=$1 AND customer_phone=$2 LIMIT 1', [realPhoneNumberId, p]);
          if (cr[0]) targetConvId = cr[0].id;
        } catch(e) {}
      }
      try {
        if (pgPool) await pgPool.query('INSERT INTO messages (conversation_id, direction, content, message_id, sender_name, timestamp) VALUES ($1,$2,$3,$4,$5,$6)', [targetConvId, 'outbound', text, msgId, 'BotWaba Commerce', Math.floor(Date.now()/1000)]);
        if (ablyKey) {
          try {
            const ai = new Ably.Realtime({ key: ablyKey, clientId: 'botwaba_commerce' });
            await ai.connection.once('connected');
            const ch = ai.channels.get('get-started');
            await ch.publish('first', { object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [{ value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, messages: [imageUrl ? { id: msgId, from: '_ackbot_', type: 'image', image: { link: imageUrl, caption: text }, timestamp: Math.floor(Date.now()/1000), _ackbot_recipient: p } : { id: msgId, from: '_ackbot_', type: 'text', text: { body: text }, timestamp: Math.floor(Date.now()/1000), _ackbot_recipient: p }] }, field: 'messages' }] }] });
            ai.close();
          } catch(e) { console.error('[COMMERCE] Ably:', e.message); }
        }
      } catch(e) { console.warn('[COMMERCE] Persist:', e.message); }
    };

    // Si es motorizado registrado y NO es admin, gestionar comandos de repartidor
    if (isDriver && !isAdmin) {
      const cmd = (message_content || '').toLowerCase().trim();

      if (/^(pedidos|repartos|repartidor|motorizado|panel|activo|activar|disponible|conectado)/i.test(cmd)) {
        const crypto = require('crypto');
        const driverToken = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas

        try {
          if (pgPool) {
            await pgPool.query(
              'INSERT INTO botwaba.pwa_tokens (token, inbox_id, business_id, role, expires_at) VALUES ($1, $2, $3, $4, $5)',
              [driverToken, inbox_id, driverBusinessId, 'delivery', expiresAt]
            );
            const driverLink = 'https://mbtechpanel.mbtech.work/orders-dashboard?t=' + driverToken;
            const greeting = /^(activo|activar|disponible|conectado)/i.test(cmd)
              ? `🛵 *¡Te has activado con éxito en ${driverBusinessName}!* Tu turno está registrado y tu canal de WhatsApp activo para recibir pedidos.\n\nAquí tienes tu Enlace de Despacho PWA para hoy:\n${driverLink}\n\nÁbrelo para ver tus entregas activas en tiempo real. Te avisaremos por aquí tan pronto haya un despacho listo.`
              : `🛵 *¡Hola Repartidor de ${driverBusinessName}!* Aquí tienes tu Enlace de Despacho PWA:\n\n${driverLink}\n\nÁbrelo para ver tus entregas activas en tiempo real.`;
            await sendToPhone(
              senderPhone,
              greeting
            );
          }
        } catch(e) {
          console.error('[COMMERCE-DRIVER] Error generando token motorizado:', e.message);
        }
        return;
      }

      if (cmd === 'comandos' || cmd === 'ayuda' || cmd === 'help') {
        const helpText = '🛵 *Comandos disponibles para Motorizado:*\n\n*pedidos* - Ver enlace a tu panel de entregas PWA\n*encamino 14* - Marcar que vas en camino a entregar el pedido\n*entregado 14* - Marcar pedido entregado al cliente';
        await sendToPhone(senderPhone, helpText);
        return;
      }

      const driverActionMatch = cmd.match(/^(encamino|en-camino|tomar|entregado|completado)\s+([\w\s-]+)/i);
      if (driverActionMatch) {
        let action = driverActionMatch[1].toLowerCase();
        let rawNum = driverActionMatch[2].trim().toUpperCase().replace(/\s+/g, '-');
        let digits = rawNum.replace(/\D/g, '');
        let padded = digits.padStart(6, '0');

        try {
          if (pgPool) {
            const { rows: r } = await pgPool.query(
              `SELECT p.*, b.business_name 
               FROM botwaba.pedidos p 
               LEFT JOIN botwaba.commerce_businesses b ON p.business_id = b.id 
               WHERE (p.inbox_id=$1 OR p.inbox_id=$2) AND (p.order_number ILIKE $3 OR p.order_number ILIKE $4)
               ORDER BY p.created_at DESC LIMIT 1`,
              [inbox_id, effectiveInboxId, `%${padded}%`, `%${digits}%`]
            );

            if (r.length === 0) {
              await sendToPhone(senderPhone, `No encontré el pedido ${rawNum}. Escribe *pedidos* para ver tu panel.`);
              return;
            }

            const ord = r[0];
            const bizTitle = ord.business_name || driverBusinessName || 'el restaurante';

            if (action === 'encamino' || action === 'en-camino' || action === 'tomar') {
              await pgPool.query("UPDATE botwaba.pedidos SET status = 'shipped', updated_at = NOW() WHERE id = $1", [ord.id]);
              // Notificar cliente
              await sendToPhone(
                ord.customer_phone,
                `🛵 *¡Tu pedido #${ord.order_number} va en camino!* Nuestro repartidor ya lo retiró de ${bizTitle} y se dirige a tu dirección. 📍\n\n¡Prepárate para recibirlo!`
              );
              // Confirmar a motorizado
              await sendToPhone(
                senderPhone,
                `✅ *Tomaste el pedido #${ord.order_number}.*\n📍 Dirección: ${ord.delivery_address || 'No especificada'}\nCliente notificado que vas en camino.`
              );
            } else if (action === 'entregado' || action === 'completado') {
              await pgPool.query("UPDATE botwaba.pedidos SET status = 'completed', updated_at = NOW() WHERE id = $1", [ord.id]);
              // Notificar cliente
              await sendToPhone(
                ord.customer_phone,
                `✅ *¡Pedido #${ord.order_number} Entregado!* Muchas gracias por tu compra en ${bizTitle}. ¡Esperamos que lo disfrutes mucho! 😊🍽️`
              );
              // Confirmar a motorizado
              await sendToPhone(
                senderPhone,
                `✅ *Pedido #${ord.order_number} marcado como entregado exitosamente.* ¡Buen trabajo! 🌟`
              );
            }
          }
        } catch(e) {
          console.error('[COMMERCE-DRIVER-ACTION] Error:', e.message);
        }
        return;
      }
    }

    if (isAdmin) {
      console.log('[COMMERCE-ADMIN] Comando de admin ' + senderPhone + ': ' + (message_content || '(imagen)'));

      const cmd = (message_content || '').toLowerCase().trim();
      if (cmd === 'comandos' || cmd === 'ayuda' || cmd === 'help') {
        const helpText = '🤖 *Comandos disponibles de Administración:*\n\n*pendientes* - Ver pedidos sin validar\n*confirmar 0001* - Validar pago\n*listo 0001* - Marcar como listo\n*rechazar 0001* - Rechazar pago\n*panel* - Ver enlaces del panel PWA';
        const helpBody = { messaging_product: 'whatsapp', recipient_type: 'individual', to: senderPhone, type: 'text', text: { preview_url: false, body: helpText } };
        try {
          await fetch('https://graph.facebook.com/v20.0/' + phoneNumberId + '/messages', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(helpBody) });
        } catch(e) { console.error('[COMMERCE-ADMIN] Error ayuda:', e.message); }
        return;
      }

      // Comando: negocio / admin / panel / activo (Generar enlaces PWA)
      if (cmd === 'negocio' || cmd === 'admin' || cmd === 'panel' || cmd === 'activo' || cmd === 'activar') {
        const crypto = require('crypto');
        const kitchenToken = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
        
        try {
          if (pgPool) {
            // Guardar token cocina
            await pgPool.query(
              'INSERT INTO botwaba.pwa_tokens (token, inbox_id, business_id, role, expires_at) VALUES ($1, $2, $3, $4, $5)',
              [kitchenToken, inbox_id, bizBusinessId, 'kitchen', expiresAt]
            );
            
            // Generar token admin
            const adminToken = crypto.randomBytes(16).toString('hex');
            await pgPool.query(
              'INSERT INTO botwaba.pwa_tokens (token, inbox_id, business_id, role, expires_at) VALUES ($1, $2, $3, $4, $5)',
              [adminToken, inbox_id, bizBusinessId, 'admin', expiresAt]
            );

            const kitchenLink = 'https://mbtechpanel.mbtech.work/orders-dashboard?t=' + kitchenToken;
            const adminLink = 'https://mbtechpanel.mbtech.work/orders-dashboard?t=' + adminToken;
            
            await sendToPhone(senderPhone, '🔑 *Tus Enlaces de Acceso Seguro (PWA)*\n\n🍳 *Pantalla de Cocina (Pizzero):*\n' + kitchenLink + '\n\n📊 *Panel de Control Completo (Administrador):*\n' + adminLink + '\n\n*Nota:* Estos enlaces expiran en 24 horas. Puedes guardarlos en la pantalla de inicio de tu celular.');
          }
        } catch(e) {
          console.error('[COMMERCE-ADMIN] Error generando tokens PWA:', e.message);
          await sendToPhone(senderPhone, 'Error generando los enlaces del panel. Inténtalo de nuevo.');
        }
        return;
      }

      // Comando: motorizado / repartidor (Generar enlace motorizado)
      if (cmd === 'motorizado' || cmd === 'driver' || cmd === 'repartidor') {
        const crypto = require('crypto');
        const driverToken = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
        
        try {
          if (pgPool) {
            await pgPool.query(
              'INSERT INTO botwaba.pwa_tokens (token, inbox_id, business_id, role, expires_at) VALUES ($1, $2, $3, $4, $5)',
              [driverToken, inbox_id, bizBusinessId, 'delivery', expiresAt]
            );
            const driverLink = 'https://mbtechpanel.mbtech.work/orders-dashboard?t=' + driverToken;
            await sendToPhone(senderPhone, '🛵 *Enlace de Despacho para Motorizado:*\n\n' + driverLink + '\n\nEnvíaselo a tu repartidor para que pueda gestionar y entregar los pedidos en tiempo real.');
          }
        } catch(e) {
          console.error('[COMMERCE-ADMIN] Error generando token motorizado:', e.message);
        }
        return;
      }

      // Comando: pendientes
      if (cmd === 'pendientes' || cmd === 'pedidos') {
        try {
          if (!pgPool) { await sendToPhone(senderPhone, 'Error: BD no disponible'); return; }
          const { rows: pending } = await pgPool.query('SELECT p.order_number, p.customer_phone, p.total_usd, p.total_bs, p.proof_media_url, p.delivery_type, p.delivery_address, b.business_name FROM botwaba.pedidos p LEFT JOIN botwaba.commerce_businesses b ON p.business_id = b.id WHERE (p.inbox_id=$1 OR p.inbox_id=$2) AND p.status=$3 ORDER BY p.created_at DESC LIMIT 10', [inbox_id, effectiveInboxId, 'pending']);
          if (pending.length === 0) { await sendToPhone(senderPhone, 'No tienes pedidos pendientes'); return; }
          await sendToPhone(senderPhone, pending.length + ' pedido(s) pendiente(s):');
          for (const ord of pending) {
            const bizName = ord.business_name ? ' (' + ord.business_name + ')' : '';
            const cap = ord.order_number + bizName + '\n' + parseFloat(ord.total_usd).toFixed(2) + ' / Bs. ' + parseFloat(ord.total_bs||0).toFixed(2) + '\nCliente: ' + ord.customer_phone + '\n' + (ord.delivery_type==='delivery'?'Delivery':'Pickup') + (ord.delivery_address ? '\n📍 ' + ord.delivery_address : '') + '\n\nEscribe *confirmar ' + ord.order_number.replace('ORD-','') + '* o *rechazar ' + ord.order_number.replace('ORD-','') + '*';
            if (ord.proof_media_url) await sendToPhone(senderPhone, cap, ord.proof_media_url);
            else await sendToPhone(senderPhone, cap + '\n(sin comprobante)');
          }
        } catch (e) { console.error('[COMMERCE-ADMIN] pendientes:', e.message); }
        return;
      }

      // Comando: confirmar / listo / rechazar
      const actionMatch = cmd.match(/^(confirmar|confirmado|aprobar|aprobado|listo|rechazar|rechazado|enviado|encamino)\s+([\w\s-]+)/i);
      if (actionMatch) {
        let action = actionMatch[1].toLowerCase();
        if (action === 'confirmado' || action === 'aprobar' || action === 'aprobado') action = 'confirmar';
        if (action === 'rechazado') action = 'rechazar';
        let rawNum = actionMatch[2].trim().toUpperCase().replace(/\s+/g, '-');
        let orderNum = rawNum;
        if (!orderNum.startsWith('ORD-')) orderNum = 'ORD-' + orderNum;
        // Normalizar: si el mes no tiene cero (ORD-000001-7 -> ORD-000001-07), intentar ambas
        const orderNumParts = orderNum.match(/^(ORD-)(\d+)-(\d+)$/);
        let orderNums = [orderNum, rawNum];
        if (orderNumParts) {
          const seq = orderNumParts[2];
          const month = orderNumParts[3];
          const seqInt = String(parseInt(seq));
          const monthPadded = month.padStart(2, '0');
          const monthInt = String(parseInt(month));
          // Generar todas las variantes posibles de seq x month
          const seqVariants = [seq, seq.padStart(6, '0'), seq.padStart(4, '0'), seqInt, seqInt.padStart(6, '0'), seqInt.padStart(4, '0')];
          const monthVariants = [month, monthPadded, monthInt];
          for (const sv of seqVariants) {
            for (const mv of monthVariants) {
              orderNums.push('ORD-' + sv + '-' + mv);
            }
          }
        }
        orderNums = [...new Set(orderNums)];
        try {
          if (!pgPool) { await sendToPhone(senderPhone, 'Error: BD no disponible'); return; }
          let orders = [];
          for (const onum of orderNums) {
            const { rows: r } = await pgPool.query('SELECT * FROM botwaba.pedidos WHERE inbox_id=$1 AND order_number=$2 LIMIT 1', [inbox_id, onum]);
            if (r.length > 0) { orders = r; break; }
          }
          if (orders.length === 0) {
            const digits = rawNum.replace(/\D/g, '');
            if (digits) {
              const padded = digits.padStart(6, '0');
              const { rows: r } = await pgPool.query(
                `SELECT * FROM botwaba.pedidos 
                 WHERE inbox_id=$1 AND (order_number ILIKE $2 OR order_number ILIKE $3)
                 ORDER BY created_at DESC LIMIT 1`,
                [inbox_id, `%${padded}%`, `%${digits}%`]
              );
              if (r.length > 0) orders = r;
            }
          }
          if (orders.length === 0) { await sendToPhone(senderPhone, 'No encontre el pedido ' + orderNum + '. Escribe *pendientes* para ver los pedidos.'); return; }
          const ord = orders[0];
          let newStatus = ord.status, clientMsg = '', adminMsg = '';
          if (action === 'confirmar') {
            newStatus = 'paid';
            clientMsg = '✅ *¡Pago verificado y confirmado!* #' + ord.order_number + '\n\nTu pedido ha sido aprobado por administración y ya está en cocina para su preparación. 👨‍🍳🔥 Te avisaremos tan pronto esté listo.';
            adminMsg = '✅ Pedido ' + ord.order_number + ' confirmado con éxito. Ya ha sido enviado a la pantalla de cocina (KDS).';
          }
           else if (action === 'listo') {
             newStatus='ready';
             const isDelivery = ord.delivery_type === 'delivery';
             if (isDelivery) {
               clientMsg = 'Tu pedido #' + ord.order_number + ' esta listo! En breve nuestro motorizado lo retirara del local para llevartelo.';

               // --- Notificar a los motorizados registrados ---
               try {
                 let drivers = [];
                 // A. De commerce_businesses
                 if (ord.business_id) {
                   const { rows: bizDrivers } = await pgPool.query(
                     "SELECT driver_phones FROM botwaba.commerce_businesses WHERE id = $1 AND is_active = true LIMIT 1",
                     [ord.business_id]
                   );
                   if (bizDrivers.length > 0 && Array.isArray(bizDrivers[0].driver_phones)) {
                     drivers = bizDrivers[0].driver_phones;
                   }
                 }

                 // B. Fallback a clientes_bot
                 if (drivers.length === 0) {
                   const { rows: cbDrivers } = await pgPool.query(
                     "SELECT commerce_settings FROM botwaba.clientes_bot WHERE inbox_id = $1 LIMIT 1",
                     [inbox_id]
                   );
                   if (cbDrivers.length > 0 && cbDrivers[0].commerce_settings?.driver_phones) {
                     drivers = cbDrivers[0].commerce_settings.driver_phones;
                   }
                 }

                 // C. Enviar mensaje de alerta a cada motorizado
                 if (drivers.length > 0) {
                   const crypto = require('crypto');
                   const bizName = ord.business_name || 'El Local';
                   const destAddress = ord.delivery_address || 'Dirección no especificada';

                   for (const dPhone of drivers) {
                     const cleanDPhone = String(dPhone).replace(/^\+/, '');

                     // Generar token temporal de 24h para el motorizado
                     const driverToken = crypto.randomBytes(16).toString('hex');
                     const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

                     await pgPool.query(
                       "INSERT INTO botwaba.pwa_tokens (token, inbox_id, business_id, role, expires_at) VALUES ($1, $2, $3, $4, $5)",
                       [driverToken, inbox_id, ord.business_id, 'delivery', expiresAt]
                     );

                     const driverLink = 'https://mbtechpanel.mbtech.work/orders-dashboard?t=' + driverToken;
                     const driverAlert = `🛵 *¡Nuevo Despacho Listo!* \nEl pedido *${ord.order_number}* de *${bizName}* está listo para ser entregado.\n\n📍 *Dirección:* ${destAddress}\n💵 *Monto:* $${parseFloat(ord.total_usd).toFixed(2)} (${parseFloat(ord.total_bs || 0).toFixed(0)} Bs)\n\n👉 *Para tomar esta entrega responde:*\n*encamino ${ord.order_number.replace('ORD-', '')}*\n\nO abre tu panel web:\n${driverLink}`;

                     await sendToPhone(cleanDPhone, driverAlert);
                   }
                 }
               } catch (driverErr) {
                 console.error('[COMMERCE-ADMIN-LISTO] Error al alertar motorizados:', driverErr.message);
               }
             } else {
               clientMsg = 'Tu pedido #' + ord.order_number + ' esta listo! Puedes pasarte a buscarlo.';
             }
             adminMsg = ord.order_number + ' marcado como listo.';
           }
          else if (action === 'enviado' || action === 'encamino') {
            newStatus='shipped';
            const adminPhone = adminPhones[0] || senderPhone;
            const adminDisplay = adminPhone.startsWith('+') ? adminPhone : '+' + adminPhone;
            clientMsg = 'Tu pedido *' + ord.order_number + '* va en camino! 🛵\n\nEn breve llega a tu dirección. 📍\n\nSi tienes algún problema, escríbenos directo al WhatsApp del negocio:\n📱 ' + adminDisplay + '\n\n¡Gracias por tu compra! 🙏';
            adminMsg = ord.order_number + ' marcado como enviado. Cliente notificado con tu teléfono: ' + adminDisplay;
          }
          else if (action === 'rechazar') {
            newStatus = 'cancelled';
            clientMsg = '⚠️ *Comprobante no verificado* #' + ord.order_number + '\n\nNo pudimos validar tu pago móvil en la cuenta bancaria. Por favor verifica los datos o comunícate con nosotros para revisar la transacción.';
            adminMsg = '❌ Pedido ' + ord.order_number + ' marcado como rechazado.';
          }
          await pgPool.query('UPDATE botwaba.pedidos SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, ord.id]);
          if (clientMsg) await sendToPhone(ord.customer_phone, clientMsg);
          if (adminMsg) await sendToPhone(senderPhone, adminMsg);
          console.log('[COMMERCE-ADMIN] ' + action + ' ' + orderNum + ' -> ' + newStatus);
        } catch (e) { console.error('[COMMERCE-ADMIN] accion:', e.message); }
        return;
      }

      // Si no es un comando de admin específico, permitir que continúe el flujo regular del bot
      console.log('[COMMERCE-ADMIN] Mensaje no es comando operativo. Continuando como cliente regular para ' + senderPhone);
    }
  }

  // 4. Modulo de comercio: LLM conversacional con catalogo + token logging
  if (botModuleType === 'commerce') {
    console.log('[BOT] Commerce LLM para inbox_id ' + inbox_id + '...');
    let catalogId = null;

    // quickSend: envia a WhatsApp + persiste en BD + notifica Ably
    // Fallback automatico: si un catalog_message falla (Meta no tiene productos cargados nativamente),
    // reintenta con una lista interactiva (list) construida desde la BD local.
    const quickSend = async (text, imageUrl, interactivePayload = null) => {
      const msgId = 'msg_bot_' + Date.now();
      let payloadsToSend = [interactivePayload];

      // Si el payload es catalog_message, pre-armar el fallback a lista interactiva
      if (interactivePayload && interactivePayload.type === 'catalog_message') {
        let fallbackList = null;
        try {
          fallbackList = await getInteractiveMenuPayload(pgPool, catalogId, bizBusinessName, bizIsDelivery, bizDeliveryFee);
        } catch (e) { console.warn('[COMMERCE] Fallback list build error:', e.message); }
        if (fallbackList) {
          payloadsToSend = [interactivePayload, fallbackList];
          console.log('[COMMERCE] catalog_message armado con fallback a lista interactiva (en caso de rechazo de Meta)');
        } else {
          // Si ni siquiera podemos construir la lista, ir directo a texto
          payloadsToSend = [null];
          console.warn('[COMMERCE] No se pudo construir fallback list. Se enviara solo texto.');
        }
      }

      let success = false;
      let lastPayloadSent = null;
      for (const payload of payloadsToSend) {
        let body;
        if (payload) {
          body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'interactive', interactive: payload };
        } else if (imageUrl) {
          body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'image', image: { link: imageUrl, caption: text } };
        } else {
          body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'text', text: { preview_url: false, body: text } };
        }
        if (payload) console.log('[DEBUG SENDING INTERACTIVE PAYLOAD]', JSON.stringify(payload).substring(0, 300));
        try {
          const metaRes = await fetch('https://graph.facebook.com/v20.0/' + phoneNumberId + '/messages', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!metaRes.ok) {
            const textErr = await metaRes.text();
            console.error('[META ERROR]', textErr.substring(0, 500));
            // Si es catalog_message fallido y hay fallback, continuar al siguiente payload
            const isCatalogError = payload && payload.type === 'catalog_message';
            const hasMoreFallbacks = payloadsToSend.indexOf(payload) < payloadsToSend.length - 1;
            if (isCatalogError && hasMoreFallbacks) {
              console.log('[COMMERCE] catalog_message rechazado. Cayendo en fallback (lista interactiva o texto)...');
              continue;
            }
            // Si era el ultimo intento y fallo, salir del loop
            break;
          } else {
            await metaRes.text();
            console.log('[META SUCCESS]');
            success = true;
            lastPayloadSent = payload;
            break;
          }
        } catch (e) {
          console.error('[COMMERCE] sendReply error:', e.message);
          const hasMoreFallbacks = payloadsToSend.indexOf(payload) < payloadsToSend.length - 1;
          if (hasMoreFallbacks) { continue; }
          break;
        }
      }

      try {
        if (pgPool) await pgPool.query('INSERT INTO messages (conversation_id, direction, content, message_id, sender_name, timestamp) VALUES ($1,$2,$3,$4,$5,$6)', [conversationId, 'outbound', text, msgId, 'BotWaba Commerce', Math.floor(Date.now()/1000)]);
        if (ablyKey) { try { const ai = new Ably.Realtime({ key: ablyKey, clientId: 'botwaba_commerce' }); await ai.connection.once('connected'); const ch = ai.channels.get('get-started'); await ch.publish('first', { object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [{ value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, messages: [lastPayloadSent ? { id: msgId, from: '_ackbot_', type: 'interactive', interactive: lastPayloadSent, timestamp: Math.floor(Date.now()/1000), _ackbot_recipient: recipient } : (imageUrl ? { id: msgId, from: '_ackbot_', type: 'image', image: { link: imageUrl, caption: text }, timestamp: Math.floor(Date.now()/1000), _ackbot_recipient: recipient } : { id: msgId, from: '_ackbot_', type: 'text', text: { body: text }, timestamp: Math.floor(Date.now()/1000), _ackbot_recipient: recipient })] }, field: 'messages' }] }] }); ai.close(); } catch(e) { console.error('[COMMERCE] Ably:', e.message); } }
      } catch (e) { console.warn('[COMMERCE] Persist:', e.message); }
      return success;
    };

    // Logging de tokens/costo
    const logTokenUsage = async (usage, latencyMs) => {
      try {
        const inputTokens = usage?.prompt_tokens || 0;
        const outputTokens = usage?.completion_tokens || 0;
        const totalTokens = usage?.total_tokens || (inputTokens + outputTokens);
        const costUsd = (inputTokens * 0.0000001) + (outputTokens * 0.0000003);
        if (pgPool) { await pgPool.query('INSERT INTO botwaba.token_usage_log (inbox_id, customer_phone, conversation_id, module, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [inbox_id, recipient, conversationId, botModuleType, aiModel, inputTokens, outputTokens, totalTokens, costUsd, latencyMs]); console.log('[COMMERCE] Tokens: ' + totalTokens + ' | Costo: $' + costUsd.toFixed(6) + ' | ' + latencyMs + 'ms'); }
      } catch (e) { console.warn('[COMMERCE] Token log:', e.message); }
    };

    try {
      const t0 = Date.now();

      let customerName = 'Cliente';
      try {
        const { rows: contactRows } = await pgPool.query(
          "SELECT name FROM meta_saas.contacts WHERE phone_number = $1 OR phone_number = $2 LIMIT 1",
          [recipient, '+' + recipient]
        );
        if (contactRows[0] && contactRows[0].name) {
          customerName = contactRows[0].name;
        }
      } catch (e) {}

      // Cargar sesion del cliente
      let session = null;
      try { const { rows: sr } = await pgPool.query('SELECT * FROM botwaba.commerce_sessions WHERE inbox_id=$1 AND customer_phone=$2 LIMIT 1', [inbox_id, recipient]); session = sr[0] || null; } catch (e) {}

      // ── Cargar negocios disponibles para este inbox_id ────────────────
      let businesses = [];
      try {
        const { rows: bizRows } = await pgPool.query("SELECT id, business_name, business_nature, catalog_id, emoji, payment_pago_movil, admin_phones, delivery_fee, is_delivery_enabled, address_street, address_city FROM botwaba.commerce_businesses WHERE inbox_id=$1 AND is_active=true ORDER BY sort_order ASC", [inbox_id]);
        businesses = bizRows;
      } catch (e) { console.warn('[COMMERCE] Error cargando businesses:', e.message); }

      // Auto-seleccionar el unico negocio si no está seleccionado y solo hay 1
      if (businesses.length === 1 && (!session || !session.business_id)) {
        try {
          await upsertCommerceSession(pgPool, inbox_id, recipient, { business_id: businesses[0].id, state: 'IDLE' });
          session = { ...(session || {}), business_id: businesses[0].id, state: 'IDLE' };
        } catch(e) {}
      }

      // ── Comando 'negocios' / 'menu principal' / 'otro negocio' ────────
      if (message_content && /^(negocios|menu principal|otro negocio|centro)/i.test(message_content.trim())) {
        await upsertCommerceSession(pgPool, inbox_id, recipient, { business_id: null, state: 'BUSINESS_SELECT', current_item: 'null' });
        session = null;
      }

      // ── Cargar config del negocio seleccionado (o fallback a clientes_bot) ──
      let bizConfig = null;
      if (session && session.business_id) {
        try { const { rows: bc } = await pgPool.query('SELECT * FROM botwaba.commerce_businesses WHERE id=$1 LIMIT 1', [session.business_id]); bizConfig = bc[0]; } catch(e) {}
      }

      // Enrutador de Macro-Modelos de Flujo
      const botModelType = (bizConfig && bizConfig.bot_model_type) ? bizConfig.bot_model_type : 'FOOD_DELIVERY';
      console.log(`[COMMERCE] Ejecutando Macro-Modelo: ${botModelType} para el negocio: ${bizConfig ? bizConfig.business_name : 'Default'}`);

      if (botModelType === 'LOGISTICS') {
        const { handleLogisticsMessage } = require('./modules/logistics');
        await handleLogisticsMessage({
          recipient,
          message: payload,
          context: { bizConfig, commerceSettings, activePaymentMovil },
          pgPool,
          sendReply: quickSend
        });
        return;
      }

      if (botModelType === 'FOOD_DELIVERY') {
        const { handleFoodDeliveryMessage } = require('./modules/food_delivery');
        await handleFoodDeliveryMessage({
          recipient,
          payload,
          context: { bizConfig, commerceSettings, activePaymentMovil },
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
        });
        return;
      }

      if (botModelType === 'RETAIL') {
        const { handleRetailMessage } = require('./modules/retail');
        await handleRetailMessage({
          recipient,
          payload,
          context: { bizConfig, commerceSettings, activePaymentMovil },
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
        });
        return;
      }
    } catch (err) {
      console.error('[BOT] Error en commerce (Router):', err.message);
      try { await quickSend('Lo siento, tuve un problema tecnico. Puedes escribir nuevamente?'); } catch(e) {}
    }
    return;
  }

  // Helper para responder a WhatsApp de inmediato (y guardar en BD)
  const sendReply = async (text, isPrivate = false) => {
    // Generamos el ID ??nico arriba para que sirva tanto para mensajes como para notas privadas
    const msgId = `msg_bot_${Date.now()}`;

    if (isPrivate) {
      // Las notas privadas solo van al CRM, no a Meta
      try {
        if (pgPool) {
          await pgPool.query(
            `INSERT INTO messages (conversation_id, direction, content, message_id, sender_name, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [conversationId, 'outbound', text, msgId, 'BotWaba (Nota)', Math.floor(Date.now() / 1000)]
          );
        } else {
          await supabaseMeta.from('messages').insert({
            conversation_id: conversationId,
            direction: 'outbound',
            content: text,
            message_id: msgId,
            sender_name: 'BotWaba (Nota)',
            timestamp: Math.floor(Date.now() / 1000)
          });
        }
      } catch (e) {
        console.error('[BOT] Error al guardar nota privada en CRM:', e.message);
      }
      return;
    }

    // 1. Enviar a Meta Graph API
    const channel = payload.channel || 'whatsapp';
    let metaApiUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    let requestBody;

    if (channel === 'whatsapp') {
      requestBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: false, body: text }
      };
    } else {
      // Messenger / Instagram
      metaApiUrl = `https://graph.facebook.com/v20.0/me/messages`;
      requestBody = {
        recipient: { id: recipient },
        message: { text: text },
        messaging_type: "RESPONSE"
      };
    }

    try {
      const metaResponse = await fetch(metaApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!metaResponse.ok) {
        console.error('[BOT] Error enviando a Meta:', await metaResponse.text());
      }
    } catch (e) {
      console.error('[BOT] Error de red enviando a Meta:', e.message);
    }
    
    // 2. Guardar en el CRM (SaaS)
    try {
      if (pgPool) {
        await pgPool.query(
          `INSERT INTO messages (conversation_id, direction, content, message_id, sender_name, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [conversationId, 'outbound', text, msgId, 'BotWaba AI', Math.floor(Date.now() / 1000)]
        );
      } else {
        await supabaseMeta.from('messages').insert({
          conversation_id: conversationId,
          direction: 'outbound',
          content: text,
          message_id: msgId,
          sender_name: 'BotWaba AI',
          timestamp: Math.floor(Date.now() / 1000)
        });
      }

      // 3. Notificar a la UI del CRM en tiempo real usando Ably
      if (ablyKey) {
        try {
          const ably = new Ably.Realtime({ key: ablyKey, clientId: 'botwaba_ai' });
          await ably.connection.once('connected');
          const channel = ably.channels.get('get-started');
          
          const ackTimestamp = Date.now();
          const ackPayload = {
            object: 'whatsapp_business_account',
            entry: [
              {
                id: wabaId,
                changes: [
                  {
                    value: {
                      messaging_product: 'whatsapp',
                      metadata: { phone_number_id: phoneNumberId },
                      messages: [
                        {
                          id: msgId,
                          from: '_ackbot_',
                          type: 'text',
                          text: { body: text },
                          timestamp: Math.floor(ackTimestamp / 1000),
                          _ackbot_recipient: recipient,
                        },
                      ],
                    },
                    field: 'messages',
                  },
                ],
              },
            ],
          };

          await channel.publish('first', ackPayload);
          ably.close();
        } catch (ablyErr) {
          console.error('[BOT] Error notificando a Ably:', ablyErr.message);
        }
      }

    } catch (e) {
      console.warn('[BOT] Error al guardar en CRM:', e.message);
    }
  };

  // ==========================================================
  // MOTOR DE ACCIONES DATA-DRIVEN (botones de plantilla)
  // ----------------------------------------------------------
  // Si el mensaje viene de un bot??n interactivo, resolvemos la acci??n
  // global vinculada por match_key (lo que Meta devuelve al tapping) en
  // global_button_actions. Si hay coincidencia ejecutamos su cadena y
  // cerramos SIN pasar por la IA. Si no, cae al flujo normal (IA/RAG),
  // que es la red de seguridad en runtime (el silencio se corta de ra??z
  // exigiendo el v??nculo en el builder, ver R1).
  // ==========================================================
  try {
    const buttonMatchKey =
      payload.match_key ||
      payload.button?.text ||
      payload.button_payload?.button?.text ||
      payload.button_payload?.interactive?.button_reply?.title ||
      payload.button_payload?.interactive?.button_reply?.id ||
      payload.button_payload?.interactive?.list_reply?.title ||
      payload.button_payload?.interactive?.list_reply?.id ||
      null;

    if (buttonMatchKey) {
      const action = await resolveButtonAction(buttonMatchKey, { wabaId });
      if (action) {
        const stepCount = Array.isArray(action.actions) ? action.actions.length : 0;
        console.log(`[BOT] ???? Bot??n "${buttonMatchKey}" ??? acci??n "${action.name}" (id=${action.id}). Ejecutando ${stepCount} paso(s).`);
        const ctx = buildActionContext(payload, {
          message_content,
          sendReply,
          aiModel,
          systemPromptBase: system_prompt,
        });
        await runActionChain(action.actions, ctx);
        console.log(`[BOT] ??? Cadena de acci??n completada para conversaci??n ${conversationId}.`);
        return; // acci??n ejecutada: NO cae a la IA
      } else {
        console.log(`[BOT] ?????? Bot??n "${buttonMatchKey}" sin acci??n global vinculada ??? red de seguridad: cae a IA.`);
      }
    }
  } catch (e) {
    console.error('[BOT] Error en motor de acciones (bot??n):', e.message, '??? cae a IA como red de seguridad.');
  }
  // ==========================================================

  // ==========================================
  // MODO ADMINISTRADOR (COMANDOS V??A WHATSAPP)
  // ==========================================
  const textMsg = message_content.trim();
  const adminPin = process.env.ADMIN_PIN || '1234';

  if (textMsg.startsWith('?ayuda')) {
    const ayudaText = `🤖🌟 *MODO ADMINISTRADOR (BotWaba)* 🌟🤖\n\nComandos disponibles:\n\n1️⃣ *?ayuda*\nMuestra este menú.\n\n2️⃣ */aprender [PIN] [Información]*\nEl bot procesará la información, generará Q&As y las inyectará a su memoria RAG en tiempo real.\nEjemplo: _/aprender 1234 A partir de mañana nuestra pizzería cerrará a las 10 PM._\n\n3️⃣ */olvidar_todo [PIN]*\n⚠️ PELIGRO: Borra TODA la memoria de este bot (Inbox ${effectiveInboxId}).`;
    await sendReply(ayudaText);
    return; // Detenemos el flujo normal
  }

  if (textMsg.startsWith('/aprender')) {
    const parts = textMsg.split(' ');
    if (parts.length < 3) {
      await sendReply(`??? Error de sintaxis.\nUso correcto: /aprender [PIN] [Texto a aprender]`);
      return;
    }
    const pin = parts[1];
    if (pin !== adminPin) {
      await sendReply(`??? Acceso denegado: PIN incorrecto.`);
      return;
    }
    const infoToLearn = parts.slice(2).join(' ');
    await sendReply(`??? Procesando nueva informaci??n...\nGenerando conocimiento y vectorizando...`);
    
    try {
      // Usamos Gemma para generar QA desde el texto crudo
      const systemPrompt = `Eres un experto en extracci??n de conocimiento. El usuario te dar?? un texto crudo. Extrae los datos importantes y genera un JSON con un arreglo "qas" donde cada objeto tiene "q" (pregunta/narrativa) y "a" (respuesta). Solo devuelve JSON v??lido.`;
      
      const llmRes = await callLlmChat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: infoToLearn }
        ],
        response_format: { type: "json_object" }
      });
      
      let content = llmRes.content || '{}';
      content = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      const parsedQa = JSON.parse(content);
      
      if (!parsedQa.qas || parsedQa.qas.length === 0) {
        await sendReply(`??? La IA no pudo extraer conocimiento ??til de tu texto.`);
        return;
      }

      await vectorizeQnA(effectiveInboxId.toString(), parsedQa.qas);
      await sendReply(`??? ??Conocimiento asimilado con ??xito!\nSe inyectaron ${parsedQa.qas.length} nuevos fragmentos a mi memoria.`);
    } catch (e) {
      console.error(e);
      await sendReply(`??? Ocurri?? un error al intentar aprender: ${e.message}`);
    }
    return;
  }

  if (textMsg.startsWith('/olvidar_todo')) {
    const parts = textMsg.split(' ');
    if (parts.length < 2) {
      await sendReply(`??? Error de sintaxis.\nUso correcto: /olvidar_todo [PIN]`);
      return;
    }
    const pin = parts[1];
    if (pin !== adminPin) {
      await sendReply(`??? Acceso denegado: PIN incorrecto.`);
      return;
    }
    
    try {
      const { error } = await supabase
        .from('company_knowledge')
        .delete()
        .eq('inbox_id', effectiveInboxId.toString());
        
      if (error) throw error;
      await sendReply(`??????? Memoria borrada. Soy un lienzo en blanco para este Inbox.`);
    } catch (e) {
      await sendReply(`??? Ocurri?? un error al borrar la memoria: ${e.message}`);
    }
    return;
  }
  // ==========================================

  try {
    // 2. Obtener historial de la conversaci??n desde la BD del CRM para dar contexto a la IA
    console.log(`[BOT] ???? Obteniendo historial de la conversaci??n ${conversationId}...`);
    let historyMessages = [];
    try {
      let dbMessages = [];
      if (pgPool) {
        const { rows } = await pgPool.query(
          `SELECT direction, content, timestamp FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC`,
          [conversationId]
        );
        dbMessages = rows;
      } else {
        const { data, error: histError } = await supabaseMeta
          .from('messages')
          .select('direction, content, timestamp')
          .eq('conversation_id', conversationId)
          .order('timestamp', { ascending: true });
        if (histError) throw histError;
        dbMessages = data || [];
      }

      if (dbMessages && dbMessages.length > 0) {
        // Tomar los ??ltimos 10 mensajes
        const validMessages = dbMessages.slice(-10);

        validMessages.forEach(m => {
          // Ya no excluimos el ??ltimo porque el SaaS ya lo insert??, as?? que simplemente lo mapeamos.
          // Pero para evitar duplicar el mensaje actual en el prompt, verificamos si es igual.
          historyMessages.push({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.content
          });
        });
        
        // Removemos el ??ltimo mensaje si coincide con el mensaje actual (para evitar pasarlo 2 veces)
        if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].content === message_content) {
          historyMessages.pop();
        }
      }
    } catch (err) {
      console.warn(`[BOT] ?????? No se pudo obtener el historial del CRM:`, err.message);
    }

    // 2.5 Buscar contexto en base de datos vectorial (RAG)
    console.log(`[BOT] 🧠 Buscando información de empresa (RAG) para inbox_id: ${effectiveInboxId}...`);
    let companyContext = '';
    try {
      // Usamos la API de Embeddings de OpenRouter con baai/bge-m3
      const embedResponse = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'baai/bge-m3',
          input: message_content
        })
      });

      if (!embedResponse.ok) {
        throw new Error(`Error en API de embeddings: ${await embedResponse.text()}`);
      }
      
      const embedData = await embedResponse.json();
      const queryArray = embedData.data[0].embedding;
      
      // Llamada RPC a Supabase para buscar similaridad
      const { data: matches, error: matchError } = await supabase.rpc('match_knowledge', {
        query_embedding: queryArray,
        match_threshold: 0.3, // Umbral de similaridad del coseno (ajustable)
        match_count: 4, // Traer las 4 piezas de informaci??n m??s relevantes
        p_inbox_id: effectiveInboxId.toString()
      });

      if (matchError) {
        console.error(`[BOT] ??? Error en match_knowledge:`, matchError.message);
      } else if (matches && matches.length > 0) {
        console.log(`[BOT] ??? Encontrados ${matches.length} fragmentos de conocimiento relevantes.`);
        
        // Log logging usage
        const matchIds = matches.map(m => m.id);
        // Fire and forget update to increment usage count (optional)
        
        // Construimos el contexto para inyectar
        companyContext = `\n\n--- INFORMACI??N DE LA EMPRESA (Basa tus respuestas estrictamente en esto si es relevante) ---\n`;
        matches.forEach(m => {
          companyContext += `Q: ${m.question}\nA: ${m.answer}\n\n`;
        });
      } else {
        console.log(`[BOT] ?????? No se encontraron matches relevantes en el knowledge base.`);
      }
    } catch (err) {
      console.warn(`[BOT] ?????? Fall?? la recuperaci??n RAG:`, err.message);
    }

    // 3. Llamada a OpenRouter
    console.log(`[BOT] ???? OpenRouter (${aiModel}) procesando el texto con memoria y contexto RAG...`);
    
    // Inyectamos el contexto de RAG en el system_prompt
    const handoffInstruction = `\n\n--- INSTRUCCI??N DE TRANSFERENCIA A HUMANO ---\nSi consideras que ya recopilaste los datos del cliente (nombre, tel??fono, empresa) para hacer una transferencia al equipo de ventas, O si no puedes responder a la solicitud y debes derivarlo a un humano, DEBES agregar al final de tu respuesta la etiqueta especial [NOTA_PRIVADA] seguida de un breve resumen de la situaci??n del cliente para que el agente humano lo lea en privado.\nEjemplo de tu respuesta:\n"En un momento un asesor te atender??.\n[NOTA_PRIVADA]\n- Cliente: Juan P??rez (555-1234)\n- Empresa: X\n- Requerimiento: Cotizaci??n de n??minas."`;

    const clinicalTriageInstruction = `\n\n--- ALERTA DE URGENCIA CL??NICA (TRIAGE) ---\nSi el paciente reporta s??ntomas de emergencia m??dica u odontol??gica severa (ej. dolor agudo insoportable, sangrado severo, accidente, infecci??n grave, diente roto con dolor), DEBES agregar al final de tu respuesta la etiqueta especial [URGENCIA_CLINICA]. Tu respuesta visible debe ser emp??tica y extremadamente breve, indicando que un humano tomar?? el control de inmediato. NO hagas preguntas de rutina si detectas una urgencia cl??nica.`;

    // Prompt din??mico seg??n el tipo de m??dulo de bot activo
    let activePrompt = '';
    
    if (botModuleType === 'retail_delivery') {
      activePrompt = `Eres el asistente de ventas oficial de la empresa "${activeBusinessName}", cuya naturaleza de negocio es: ${activeBusinessNature}.
Tu objetivo es guiar a los clientes en su proceso de compra usando el embudo AIDA (Atenci??n, Inter??s, Deseo, Acci??n).
REGLAS DEL M??DULO (COMERCIO & DELIVERY):
1. Tienes habilitado el sistema de pedidos y delivery de productos. Direcci??n f??sica: ${activeAddress?.street || 'No especificada'}, Ciudad: ${activeAddress?.city || ''}.
2. Si el usuario desea comprar, ind??cale de forma amigable y concisa que puede ver nuestro cat??logo o hacer su pedido por aqu??.
3. Si el usuario pregunta por env??os, ind??cale si hacemos delivery (??Hacemos delivery?: ${activeIsDelivery ? 'S??' : 'No'}) y los detalles del mismo.
4. PARQUEDAD ABSOLUTA: Respuestas cortas, directas y sin rodeos.`;
    } else if (botModuleType === 'appointments') {
      activePrompt = `Eres el asistente de reservas oficial de la empresa "${activeBusinessName}", cuya naturaleza de negocio es: ${activeBusinessNature}.
Tu objetivo principal es asistir al cliente a agendar su cita de forma amable y concisa.
REGLAS DEL M??DULO (CITAS / AGENDAMIENTO):
1. Informa al cliente sobre los servicios disponibles, duraciones y precios de forma organizada.
2. Ori??ntalo sobre nuestros horarios de atenci??n y d??as laborables.
3. PARQUEDAD ABSOLUTA: Mant??n las respuestas muy breves y enfocadas en ofrecer horarios libres o servicios.`;
    } else if (botModuleType === 'lead_gen') {
      activePrompt = `Eres el asistente de ventas experto en neuromarketing de "${activeBusinessName}", cuya naturaleza de negocio es: ${activeBusinessNature}.
Tu objetivo principal es capturar y calificar prospectos interesados en nuestros servicios usando el embudo AIDA (Atenci??n, Inter??s, Deseo, Acci??n) y guiar org??nicamente la conversaci??n.
REGLAS DEL M??DULO (CAPTURA DE LEADS):
1. Conversa de manera emp??tica para generar inter??s y deseo.
2. En la fase de Acci??n, p??dele al cliente de forma directa y natural sus datos de contacto (como nombre o requerimiento) para transferirlo con un asesor.
3. PARQUEDAD ABSOLUTA: S?? conciso y evita explicaciones largas.`;
    } else {
      // basic_qa y por defecto
      activePrompt = `Eres el asistente de atenci??n al cliente de la empresa "${activeBusinessName}", cuya naturaleza de negocio es: ${activeBusinessNature}.
Tu objetivo principal es responder a las preguntas frecuentes de los usuarios bas??ndote estrictamente en el manual y la base de conocimientos proporcionada.
REGLAS DEL M??DULO (FAQ & SOPORTE):
1. Responde de forma cordial, servicial y directa.
2. Si no tienes la respuesta en la base de conocimientos, ind??calo de forma amable y ofrece derivarlo a un agente humano.
3. PARQUEDAD ABSOLUTA: Respuestas concisas, evita textos innecesarios o redundantes.`;
    }

    // Integraci??n de Pago M??vil en Venezuela en el Prompt si est?? configurado y habilitado
    if (activePaymentMovil && activePaymentMovil.enabled) {
      activePrompt += `\n\n--- M??DULO PAGO M??VIL (VENEZUELA) ---\nSi el cliente desea realizar el pago mediante Pago M??vil (Bol??vares), sumin??strale de manera clara estos datos de transferencia:\n- Banco: ${activePaymentMovil.banco || ''}\n- Tel??fono: ${activePaymentMovil.telefono || ''}\n- RIF/C??dula: ${activePaymentMovil.rif || ''}\n- Titular: ${activePaymentMovil.nombre_titular || ''}\n- Moneda de referencia: ${commerceSettings?.currency || 'USD'}\nInd??cale que, una vez hecha la transferencia, te env??e el n??mero de referencia del pago para registrar su pedido.`;
    }

    // Regla de conocimientos RAG generales
    activePrompt += `\n\nREGLAS DE CONOCIMIENTO:\n1. Basar??s tus respuestas estrictamente en la informaci??n oficial provista en la base de conocimientos del RAG. No inventes precios, promociones o servicios que no est??n all?? registrados.`;

    const isMedical = activeBusinessNature && activeBusinessNature.includes('[Categor??a AI: Cl??nica Dental y M??dica]');
    const finalSystemPrompt = activePrompt + companyContext + handoffInstruction + (isMedical ? clinicalTriageInstruction : '');

    // Construimos el array de mensajes: System prompt -> Historial -> Mensaje actual
    const messagesPayload = [
      { role: 'system', content: finalSystemPrompt },
      ...historyMessages,
      { role: 'user', content: message_content }
    ];
    
    const llmStart = Date.now();
    const llmRes = await callLlmChat({ messages: messagesPayload });
    const latencyMs = Date.now() - llmStart;
    
    // Descontar tokens del saldo del cliente
    if (llmRes.usage) {
      await deductAiTokens(llmRes.usage, latencyMs, commerceSettings?.admin_phones || []);
    }

    let botReply = llmRes.content || 'Error: No se pudo generar una respuesta.';

    console.log(`[BOT] ???? Respuesta generada por la IA. Notificando a Meta y CRM...`);
    
    let publicReply = botReply;
    let privateSummary = null;
    let isEmergency = false;
    
    if (publicReply.includes('[URGENCIA_CLINICA]')) {
      isEmergency = true;
      publicReply = publicReply.replace('[URGENCIA_CLINICA]', '').trim();
    }

    if (publicReply.includes('[NOTA_PRIVADA]')) {
      const parts = publicReply.split('[NOTA_PRIVADA]');
      publicReply = parts[0].trim();
      privateSummary = '???? **Resumen de Handoff AI:**\n' + (parts[1] ? parts[1].trim() : '');
    }

    // 3. Respondiendo de vuelta (P??blico)
    await sendReply(publicReply);
    
    // Si la IA gener?? una nota privada, enviarla al CRM como privada
    if (privateSummary) {
      await sendReply(privateSummary, true);
      console.log(`[BOT] ???? Nota privada de Handoff guardada en CRM.`);
    }

    if (isEmergency) {
      console.log(`[BOT] ???? URGENCIA CL??NICA detectada en la conversaci??n ${conversationId}. Activando Auto-Handoff y Alarma...`);
      try {
        if (pgPool) {
          await pgPool.query('UPDATE meta_saas.conversations SET bot_enabled = false WHERE id = $1', [conversationId]);
        } else {
          await supabaseMeta.from('conversations').update({ bot_enabled: false }).eq('id', conversationId);
        }
      } catch (err) {
        console.warn('[BOT] No se pudo actualizar bot_enabled en CRM para emergencia:', err.message);
      }
      
      try {
        const Ably = require('ably');
        const ablyClient = new Ably.Rest(process.env.ABLY_API_KEY);
        const channelAlarm = ablyClient.channels.get('whatsapp');
        await channelAlarm.publish('emergency_alarm', {
          conversationId: conversationId,
          phone_id: inbox_id
        });
      } catch (err) {
        console.warn('[BOT] No se pudo emitir alarma a Ably:', err.message);
      }
    }

    console.log(`[BOT] ??? Respuesta entregada a la conversaci??n ${conversationId}.`);

  } catch (error) {
    console.error(`[BOT] ??? Error en el puente Chatwoot-OpenRouter:`, error.message);
    
    // 4. Resiliencia: Loguear el error en Supabase bajo el ID del cliente
    try {
      await supabase
        .from('clientes_bot')
        .update({ ultimo_error_bot: `${new Date().toISOString()} - ${error.message}` })
        .eq('inbox_id', inbox_id);
        
      console.log(`[BOT] ???? Error logueado en Supabase para el inbox_id ${inbox_id}`);
    } catch (logError) {
      console.error(`[BOT] ??? Fall?? tambi??n el guardado del log en Supabase:`, logError.message);
    }
  }
}

/**
 * Genera el JSON de Preguntas y Respuestas (Q&A) usando Gemma v??a OpenRouter
 */
async function generateQnA({ activeBusinessName, description, products, hours, isOnline, address }) {
  if (!openRouterApiKey) throw new Error('Falta OPENROUTER_API_KEY');

  const systemPrompt = `Eres un experto en extraer conocimiento empresarial y estructurarlo para sistemas RAG (Retrieval-Augmented Generation).
Tu tarea es tomar la informaci??n de la empresa proporcionada y generar un JSON puro que contenga una lista de preguntas (y respuestas) frecuentes y datos clave de la empresa.
Las respuestas deben ser detalladas, asumiendo el rol de atenci??n al cliente de la empresa.

INSTRUCCIONES CR??TICAS:
1. Devuelve ??NICAMENTE un bloque de c??digo JSON v??lido, sin texto adicional antes ni despu??s, ni bloques de c??digo de markdown.
2. El JSON debe ser un objeto con un arreglo llamado "qas".
3. Cada objeto del arreglo debe tener una propiedad "q" (la pregunta o narrativa) y una propiedad "a" (la respuesta estandarizada).
4. Cubre: Informaci??n b??sica, productos/servicios, horarios, ubicaci??n y c??mo comprar/contactar.
`;

  const userPrompt = `Aqu?? tienes los datos de la empresa:
- Nombre: ${activeBusinessName}
- Descripci??n: ${description}
- Productos/Servicios: ${products}
- Horarios: ${hours}
- Es online: ${isOnline ? 'S??' : 'No'}
- Direcci??n: ${address}

Genera el JSON con el formato solicitado.`;

  const llmRes = await callLlmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: "json_object" }
  });

  let content = llmRes.content || '{}';
  
  // Clean markdown block if present
  content = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  
  return JSON.parse(content);
}

/**
 * Vectoriza las Q&As generadas usando baai/bge-m3 v??a OpenRouter y las guarda en Supabase
 */
async function vectorizeQnA(inbox_id, qas) {
  if (!supabase) throw new Error('No hay cliente de Supabase configurado');
  if (!openRouterApiKey) throw new Error('Falta OPENROUTER_API_KEY');

  const results = [];
  
  for (let i = 0; i < qas.length; i++) {
    const qa = qas[i];
    const textToEmbed = `Pregunta: ${qa.q}\nRespuesta: ${qa.a}`;
    
    try {
      const embedResponse = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'baai/bge-m3',
          input: textToEmbed
        })
      });

      if (!embedResponse.ok) {
        throw new Error(`Error en API de embeddings: ${await embedResponse.text()}`);
      }
      
      const embedData = await embedResponse.json();
      const embeddingArray = embedData.data[0].embedding;

      // Insertamos en Supabase
      const { error } = await supabase.from('company_knowledge').insert({
        inbox_id: inbox_id.toString(),
        question: qa.q,
        answer: qa.a,
        embedding: embeddingArray,
        status: 'approved'
      });

      if (error) {
        throw new Error(`Error insertando en Supabase: ${error.message}`);
      }
      
      results.push({ success: true, question: qa.q });
    } catch (err) {
      results.push({ success: false, question: qa.q, error: err.message });
    }
  }

  return results;
}

/**
 * PASO 1: Indagaci??n Profunda (SaaS)
 * Genera preguntas de seguimiento basadas en datos b??sicos.
 */
async function askDynamicQuestions({ description }) {
  if (!openRouterApiKey) throw new Error('Falta OPENROUTER_API_KEY');

  let globalTemplateContext = '';
  let matchedCategory = null;

  // B??squeda de Plantilla Global (Inteligencia Colectiva)
  try {
    if (supabase) {
      console.log('[BOT] Buscando plantilla global para la anamnesis...');
      // 1. Vectorizar la descripci??n
      const embedResponse = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'baai/bge-m3',
          input: description
        })
      });

      if (embedResponse.ok) {
        const embedData = await embedResponse.json();
        const queryArray = embedData.data[0].embedding;

        // 2. Buscar similitud
        const { data: matches, error: matchError } = await supabase.rpc('match_global_template', {
          query_embedding: queryArray,
          match_threshold: 0.4, // Ajustable, 40% de similitud m??nima
          match_count: 1
        });

        if (!matchError && matches && matches.length > 0) {
          const match = matches[0];
          matchedCategory = match.category_name;
          console.log(`[BOT] Plantilla global encontrada: ${match.category_name} (${(match.similarity * 100).toFixed(2)}%)`);
          
          let parsedQuestions = match.essential_questions;
          try {
             parsedQuestions = JSON.parse(match.essential_questions).join("\n- ");
          } catch(e) { /* ignorar si ya es texto */ }

          globalTemplateContext = `
HEMOS IDENTIFICADO ESTA EMPRESA DENTRO DE LA CATEGOR??A: "${match.category_name}".
Hist??ricamente, para este tipo de negocios, es OBLIGATORIO hacer las siguientes preguntas ineludibles:
- ${parsedQuestions}

Tu tarea es tomar estas preguntas ineludibles y adaptarlas sutilmente a la descripci??n espec??fica de esta empresa para que suenen naturales, adem??s de a??adir cualquier otra pregunta que consideres cr??tica.
`;
        }
      }
    }
  } catch (err) {
    console.warn('[BOT] Error al buscar plantilla global:', err.message);
  }

  const systemPrompt = `Eres un consultor experto en dise??o de chatbots y automatizaci??n empresarial. 
Tu objetivo es ayudar al due??o de un negocio a crear la base de conocimiento perfecta para su bot de atenci??n al cliente.
Se te dar?? la descripci??n b??sica del negocio.
Tu tarea es formular entre 3 y 5 preguntas espec??ficas e inteligentes que necesitas hacerle al due??o para entender a fondo la operatividad de su empresa, sus pol??ticas y qu?? suelen preguntar sus clientes.
${globalTemplateContext}

INSTRUCCIONES CR??TICAS:
1. Devuelve ??NICAMENTE un JSON v??lido con un arreglo de strings llamado "questions". No agregues texto markdown.
2. Las preguntas deben ser directas y f??ciles de entender para el due??o del negocio.
`;

  const userPrompt = `Datos iniciales de la empresa:
- Descripci??n: ${description}

Por favor, formula las preguntas de seguimiento necesarias.`;

  const llmRes = await callLlmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: "json_object" }
  });

  let content = llmRes.content || '{"questions": []}';
  content = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  
  const parsedContent = JSON.parse(content);
  return {
    category_name: matchedCategory,
    questions: parsedContent.questions || []
  };
}

/**
 * PASO 2: Creaci??n del Manual Operativo (SaaS)
 * Genera un manual maestro basado en las respuestas.
 */
async function generateOperationalManual({ rawContext }) {
  if (!openRouterApiKey) throw new Error('Falta OPENROUTER_API_KEY');

  let compiledContext = rawContext;

  const systemPrompt = `Eres un experto redactor t??cnico y analista de negocios.
Tu tarea es tomar la entrevista realizada al due??o de una empresa y redactar un "Manual Operativo de Atenci??n al Cliente".
Este manual servir?? como la "biblia" de conocimiento (base de datos) para un Agente de Inteligencia Artificial.
Estructura el documento usando Markdown de forma muy ordenada: incluye introducci??n de la empresa, productos/servicios, horarios/ubicaci??n, y pol??ticas o informaci??n clave proporcionada.
IMPORTANTE: NO inventes ni agregues secciones sobre "Tono de Voz", "Directrices de Comunicaci??n" o "Flujos de Soporte". Lim??tate estrictamente a los datos operativos y comerciales de la empresa.
Redacta el texto de manera profesional, clara y exhaustiva.`;

  const llmRes = await callLlmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Entrevista con el due??o:\n\n${compiledContext}\n\nPor favor, redacta el Manual Operativo en Markdown.` }
    ]
  });

  return llmRes.content || '# Error al generar el manual';
}

/**
 * PASO 3: Chunking y Vectorizaci??n (SaaS)
 * Descuartiza el manual en Q&As y las vectoriza.
 */
async function chunkAndVectorizeManual(inbox_id, manualContent) {
  if (!supabase) throw new Error('No hay cliente de Supabase configurado');
  if (!openRouterApiKey) throw new Error('Falta OPENROUTER_API_KEY');

  console.log(`[BOT] Vectorizando manual para inbox_id: ${inbox_id}...`);

  try {
    if (supabase) {
      // 1. ELIMINAR VECTORES ANTERIORES PARA ESTE INBOX (PREVENIR DUPLICADOS)
      console.log(`[BOT] Eliminando memoria anterior para el inbox ${inbox_id}...`);
      const { error: deleteError } = await supabase
        .from('company_knowledge')
        .delete()
        .eq('inbox_id', inbox_id.toString());
      
      if (deleteError) {
        console.warn(`[BOT] Advertencia al limpiar memoria anterior: ${deleteError.message}`);
      }

      // 2. GUARDAR EL MANUAL MAESTRO (PARA EL MODO EDICI??N)
      console.log(`[BOT] Guardando Manual Maestro en el perfil de la empresa...`);
      const { error: profileError } = await supabase
        .from('company_profiles')
        .upsert({
          inbox_id: inbox_id.toString(),
          master_manual: manualContent,
          updated_at: new Date().toISOString()
        }, { onConflict: 'inbox_id' });
        
      if (profileError) {
        console.warn(`[BOT] Advertencia al guardar el manual maestro: ${profileError.message}`);
      }
    }
  } catch (err) {
    console.warn(`[BOT] Excepci??n en limpieza/guardado de perfil: ${err.message}`);
  }

  // Primero, le pedimos a Gemma que descuartice el texto en Q&As
  const systemPrompt = `Eres un experto en bases de datos vectoriales (RAG).
Se te proporcionar?? el Manual Operativo de una empresa.
Tu tarea es "descuartizar" o dividir l??gicamente toda la informaci??n del manual en un formato estricto de Preguntas y Respuestas (Q&A).
Cada pieza de informaci??n importante debe convertirse en un objeto con "q" (la posible pregunta o intenci??n del usuario) y "a" (la respuesta detallada basada en el manual).

INSTRUCCIONES CR??TICAS:
1. Devuelve ??NICAMENTE un JSON v??lido con un arreglo de objetos llamado "qas".
2. No agregues texto markdown.
3. Aseg??rate de extraer TODA la informaci??n valiosa del manual y no omitir detalles importantes.`;

  const llmRes = await callLlmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Manual Operativo:\n\n${manualContent}` }
    ],
    response_format: { type: "json_object" }
  });
  
  let content = llmRes.content || '{}';
  content = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  const parsedQa = JSON.parse(content);
  
  if (!parsedQa.qas || parsedQa.qas.length === 0) {
    throw new Error('La IA no pudo extraer Q&As v??lidas del manual.');
  }

  // Segundo, reutilizamos la funci??n vectorizeQnA existente
  return await vectorizeQnA(inbox_id, parsedQa.qas);
}

/**
 * PASO 3.5: Refinamiento Asistido por IA (SaaS)
 * Toma el manual actual y las instrucciones del usuario para generar una versi??n mejorada.
 */
async function refineOperationalManual({ currentManual, feedback }) {
  if (!openRouterApiKey) throw new Error('Falta OPENROUTER_API_KEY');

  const systemPrompt = `Eres un experto redactor t??cnico y analista de negocios.
Se te proporcionar?? el "Manual Operativo de Atenci??n al Cliente" actual de una empresa y unas instrucciones de refinamiento (feedback) del due??o de la empresa.
Tu tarea es inyectar la informaci??n o cambios solicitados en el manual de forma natural, profesional y exhaustiva.
Mant??n la estructura en Markdown y aseg??rate de que el documento siga siendo cohesivo y parezca escrito por un profesional.
NO respondas con mensajes conversacionales como "Aqu?? tienes el manual", simplemente devuelve el manual mejorado en Markdown.`;

  const userPrompt = `--- MANUAL ACTUAL ---\n${currentManual}\n\n--- INSTRUCCIONES DE MEJORA ---\n${feedback}\n\nPor favor, reescribe el manual incorporando estas mejoras.`;

  const llmRes = await callLlmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  return llmRes.content || '# Error al refinar el manual';
}

/**
 * Funci??n helper para vectorizar una sola pregunta y respuesta (usada en edici??n manual de BD)
 */
async function vectorizeSingleQA(question, answer) {
  if (!openRouterApiKey) throw new Error('Falta OPENROUTER_API_KEY');
  const textToEmbed = `Pregunta: ${question}\nRespuesta: ${answer}`;
  
  const embedResponse = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'baai/bge-m3',
      input: textToEmbed
    })
  });

  if (!embedResponse.ok) {
    throw new Error(`Error en API de embeddings: ${await embedResponse.text()}`);
  }
  
  const embedData = await embedResponse.json();
  return embedData.data[0].embedding;
}

// ============================================================
// MOTOR DE ACCIONES DATA-DRIVEN (botones de plantilla)
// Helpers a nivel de m??dulo usados por la bifurcaci??n en processMessage.
// El cat??logo de tipos de acci??n es extensible: agregar un handler aqu??
// + una fila en global_button_actions basta para un nuevo comportamiento.
// ============================================================

/**
 * Resuelve la acci??n global vinculada a un match_key (texto/ID que Meta
 * devuelve al tapping un bot??n). Preferencia: override por inquilino
 * (tenant_id = wabaId) ??? global (tenant_id IS NULL).
 */
async function resolveButtonAction(matchKey, { wabaId } = {}) {
  if (!pgPool) return null;
  try {
    const { rows } = await pgPool.query(
      `SELECT id, tenant_id, match_type, match_key, name, actions, enabled, description
       FROM meta_saas.global_button_actions
       WHERE match_type IN ('button_text','button_reply_id','list_reply_id','postback_payload')
         AND match_key = $1
         AND enabled = true
       ORDER BY (tenant_id = $2) DESC, (tenant_id IS NULL) DESC
       LIMIT 1`,
      [matchKey, wabaId || '']
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[BOT] Error consultando global_button_actions:', e.message);
    return null;
  }
}

/**
 * Construye el contexto compartido entre los pasos de una cadena de acciones.
 * `sendReply` es la closure definida dentro de processMessage (env??a a Meta +
 * persiste en CRM + notifica Ably), as?? cada handler s??lo se preocupa por su
 * l??gica y deja el env??o/registro a esa funci??n.
 */
function buildActionContext(payload, extras = {}) {
  return {
    recipient: payload.recipient,
    phoneNumberId: payload.phoneNumberId,
    wabaId: payload.wabaId,
    accessToken: payload.accessToken,
    conversationId: payload.conversationId,
    platform: payload.platform || 'whatsapp',
    messageContent: extras.message_content || '',
    sendReply: extras.sendReply,
    aiModel: extras.aiModel || modeloPorDefecto,
    systemPromptBase: extras.systemPromptBase || '',
    pgPool,
    supabase,
    supabaseMeta,
    vars: {}, // resultados entre pasos (last_<type>)
  };
}

/**
 * Ejecuta secuencialmente la cadena de acciones. Cada paso puede fallar sin
 * tirar la cadena entera: si step.on_error === 'stop' se corta, si no se
 * loguea y contin??a. Los tipos desconocidos se saltan con warning.
 */
async function runActionChain(actions, ctx) {
  if (!Array.isArray(actions) || actions.length === 0) {
    console.warn('[BOT] runActionChain: cadena vac??a ??? sin pasos.');
    return;
  }
  for (const step of actions) {
    if (!step || !step.type) continue;
    const handler = ACTION_HANDLERS[step.type];
    if (!handler) {
      console.warn(`[BOT] runActionChain: handler desconocido "${step.type}". Saltando paso.`);
      continue;
    }
    try {
      const r = await handler(ctx, step);
      ctx.vars[`last_${step.type}`] = r;
    } catch (e) {
      console.error(`[BOT] runActionChain: error en paso "${step.type}":`, e.message);
      if (step.on_error === 'stop') {
        console.warn('[BOT] runActionChain: on_error=stop ??? corto la cadena.');
        break;
      }
    }
  }
}

// --- Helpers de env??o a Meta Graph API (WhatsApp) ---

async function sendMediaMessage(ctx, step, type) {
  const url = `https://graph.facebook.com/v20.0/${ctx.phoneNumberId}/messages`;
  const media = step.media_id
    ? { id: step.media_id, caption: step.caption || '' }
    : { link: step.url, caption: step.caption || '' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: ctx.recipient,
      type,
      [type]: media,
    }),
  });
  if (!res.ok) console.error(`[BOT] sendMediaMessage(${type}) error:`, await res.text());
}

async function sendTemplateMessage(ctx, step) {
  const url = `https://graph.facebook.com/v20.0/${ctx.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: ctx.recipient,
      type: 'template',
      template: {
        name: step.name,
        language: { code: step.lang || 'es_MX' },
        components: step.components || [],
      },
    }),
  });
  if (!res.ok) console.error('[BOT] sendTemplateMessage error:', await res.text());
}

/**
 * Respuesta con IA para un paso ai_reply. Usa el system_prompt del paso si lo
 * trae (caso t??pico de botones: "el cliente toc?? X, responde???"), si no, el
 * system_prompt base del bot. Llamada simple (sin RAG/historial) ??? el caso de
 * bot??n es single-shot; integrar RAG aqu?? es una mejora futura.
 */
async function aiGenerate(ctx, step) {
  const sys = step.system_prompt || ctx.systemPromptBase || 'Eres un asistente comercial amable, breve y directo.';
  const userMsg = step.user_message || ctx.messageContent || '';
  try {
    const llmRes = await callLlmChat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userMsg },
      ]
    });
    return llmRes.content || '';
  } catch (err) {
    console.error('[BOT] aiGenerate error:', err.message);
    return 'Lo siento, no pude procesar tu solicitud en este momento.';
  }
}

/**
 * Registro de handlers por tipo de acci??n. Para a??adir un nuevo tipo de
 * acci??n: (1) implementa el handler aqu??, (2) inserta filas en
 * global_button_actions que lo referencien. No se toca processMessage.
 */
const ACTION_HANDLERS = {
  send_text: async (ctx, step) => {
    if (step.body) await ctx.sendReply(step.body);
    return { sent: step.body };
  },
  send_url: async (ctx, step) => {
    if (step.url) await ctx.sendReply(step.url);
    return { sent: step.url };
  },
  send_phone: async (ctx, step) => {
    const msg = step.number ? `???? Ll??manos al: ${step.number}` : '';
    if (msg) await ctx.sendReply(msg);
    return { sent: msg };
  },
  send_document: async (ctx, step) => {
    await sendMediaMessage(ctx, step, 'document');
    return { sent: true };
  },
  send_image: async (ctx, step) => {
    await sendMediaMessage(ctx, step, 'image');
    return { sent: true };
  },
  send_video: async (ctx, step) => {
    await sendMediaMessage(ctx, step, 'video');
    return { sent: true };
  },
  send_audio: async (ctx, step) => {
    await sendMediaMessage(ctx, step, 'audio');
    return { sent: true };
  },
  send_template: async (ctx, step) => {
    await sendTemplateMessage(ctx, step);
    return { sent: true };
  },
  ai_reply: async (ctx, step) => {
    const text = await aiGenerate(ctx, step);
    if (text) await ctx.sendReply(text);
    return { sent: text };
  },
  log_event: async (ctx, step) => {
    console.log(`[BOT][log_event] conv=${ctx.conversationId} button="${ctx.messageContent}" msg="${step.message || ''}"`);
    return { logged: true };
  },
  escalate_agent: async (ctx, step) => {
    try {
      if (ctx.pgPool) {
        await ctx.pgPool.query('UPDATE meta_saas.conversations SET bot_enabled = false WHERE id = $1', [ctx.conversationId]);
      } else if (ctx.supabaseMeta) {
        await ctx.supabaseMeta.from('conversations').update({ bot_enabled: false }).eq('id', ctx.conversationId);
      }
    } catch (e) {
      console.warn('[BOT] escalate_agent: no se pudo desactivar el bot:', e.message);
    }
    if (step.message) await ctx.sendReply(step.message);
    return { escalated: true };
  },
};


// === Cron: Revisar pedidos sin respuesta del admin cada 5 minutos ===
setInterval(async () => {
  try {
    if (!pgPool) return;
    const { rows: staleOrders } = await pgPool.query(
      "SELECT order_number, inbox_id, customer_phone, status, created_at FROM botwaba.pedidos WHERE status IN ('pending','paid') AND created_at < NOW() - INTERVAL '30 minutes' AND updated_at < NOW() - INTERVAL '30 minutes'"
    );
    for (const ord of staleOrders) {
      const notifyKey = 'pedidos:stale_notified:' + ord.order_number;
      if (redisClient && redisClient.isOpen) {
        const already = await redisClient.get(notifyKey);
        if (already) continue;
        await redisClient.set(notifyKey, '1', { EX: 3600 });
      }
      const { rows: botRows } = await pgPool.query("SELECT commerce_settings FROM botwaba.clientes_bot WHERE inbox_id=$1", [ord.inbox_id]);
      if (!botRows[0]) continue;
      const cs = botRows[0].commerce_settings || {};
      const adminPhones = cs.admin_phones || [];
      if (adminPhones.length > 0) {
        const adminMsg = 'Han pasado 30+ min sin que valides el pedido *' + ord.order_number + '* (cliente: ' + ord.customer_phone + '). Escribe *confirmar ' + ord.order_number.replace('ORD-','') + '* o *rechazar ' + ord.order_number.replace('ORD-','') + '*.';
        for (const ap of adminPhones) {
          try {
            await fetch('https://graph.facebook.com/v20.0/' + ord.inbox_id + '/messages', { method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.META_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: String(ap).replace(/^\+/, ''), type: 'text', text: { preview_url: false, body: adminMsg } }) });
          } catch(e) {}
        }
      }
      const clientMsg = 'Disculpa la demora con tu pedido *' + ord.order_number + '*. Nuestro equipo esta verificando tu pago. Si necesitas contacto directo, escribenos al ' + (adminPhones.length > 0 ? '+' + adminPhones[0] : 'numero de la empresa') + '.';
      try {
        await fetch('https://graph.facebook.com/v20.0/' + ord.inbox_id + '/messages', { method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.META_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: String(ord.customer_phone).replace(/^\+/, ''), type: 'text', text: { preview_url: false, body: clientMsg } }) });
      } catch(e) {}
      console.log('[COMMERCE] Cron: Pedido stale notificado: ' + ord.order_number);
    }
  } catch (e) { console.warn('[COMMERCE] Cron error:', e.message); }
}, 300000); // Cada 5 minutos

async function getInteractiveMenuPayload(pgPool, catalogId, bizBusinessName, bizIsDelivery, bizDeliveryFee) {
  try {
    const { rows: allProducts } = await pgPool.query("SELECT id, retailer_id, title, description, price, category FROM meta_saas.catalog_products WHERE catalog_id = $1 AND availability = 'in stock' ORDER BY category ASC, id ASC", [catalogId]);
    if (allProducts.length === 0) return null;

    const EXTRA_CATS = ['extra', 'agregado', 'adicional', 'topping', 'complemento'];
    const categories = {}; const extraItems = []; const noCategory = [];
    for (const p of allProducts) {
      const cat = (p.category || '').trim();
      if (cat === '') noCategory.push(p);
      else if (EXTRA_CATS.includes(cat.toLowerCase())) extraItems.push(p);
      else { if (!categories[cat]) categories[cat] = []; categories[cat].push(p); }
    }

    const nativeSections = [];
    const MAX_ROWS = 10;
    const actionRowCount = bizIsDelivery ? 3 : 2;
    let totalItemsAdded = 0;

    const actionRows = [
      { id: 'action_finish_order', title: 'FINALIZAR PEDIDO', description: 'Ir a pagar y confirmar' }
    ];
    if (bizIsDelivery) {
      actionRows.push({ id: 'delivery_option_delivery', title: 'Para Delivery', description: 'Envio a domicilio (+$' + parseFloat(bizDeliveryFee || 0).toFixed(2) + ')' });
    }
    actionRows.push({ id: 'delivery_option_pickup', title: 'Retiro en Tienda', description: 'Para llevar / Retirar en local' });
    nativeSections.push({ title: 'ACCIONES', rows: actionRows });
    totalItemsAdded += actionRowCount;

    const addSection = (title, items) => {
      if (items.length === 0 || totalItemsAdded >= MAX_ROWS) return;
      const allowed = Math.min(items.length, MAX_ROWS - totalItemsAdded);
      const sectionItems = items.slice(0, allowed);
      nativeSections.push({
        title: title.substring(0, 24),
        rows: sectionItems.map(p => ({
          id: ('prod_' + (p.retailer_id || p.id).toString()).substring(0, 190),
          title: p.title.substring(0, 24),
          description: ('$' + parseFloat(p.price).toFixed(2) + ' - ' + (p.description || '')).substring(0, 72)
        }))
      });
      totalItemsAdded += sectionItems.length;
    };

    addSection('Pizzas', categories['Pizza'] || categories['Pizzas'] || []);
    addSection('Refrescos', categories['Refresco'] || categories['Refrescos'] || []);
    addSection('Adicionales', extraItems);
    if (noCategory.length > 0) addSection('Principales', noCategory);

    if (nativeSections.length > 0) {
      return {
        type: "list",
        header: { type: "text", text: ("Menú - " + bizBusinessName).substring(0, 60) },
        body: { text: "Selecciona el producto o tipo de entrega para tu pedido:" },
        footer: { text: "MBTech Commerce AI" },
        action: {
          button: "Elegir Producto 🛒",
          sections: nativeSections
        }
      };
    }
    return null;
  } catch (e) {
    console.error('[COMMERCE] Error build list payload:', e.message);
    return null;
  }
}

async function analyzePaymentCapture(imageUrl, openRouterApiKey) {
  try {
    console.log('[COMMERCE] Iniciando análisis OCR del comprobante vía OpenRouter (Gemini-2.5-Flash)...');
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analiza la siguiente imagen de captura de pantalla de un pago móvil de Venezuela y extrae los detalles estructurados en formato JSON. Devuelve ÚNICAMENTE el objeto JSON sin etiquetas de código ni explicaciones.\n\nFormato JSON:\n{\n  "status": "exitoso" | "fallido",\n  "monto_bs": float,\n  "referencia": string,\n  "fecha": string,\n  "banco_destino": string,\n  "telefono_destino": string,\n  "documento_identidad": string\n}\n\nReglas:\n1. Si la captura de pantalla muestra "Transacción Fallida", "Rechazada", "Fallo", "El número ingresado no se encuentra afiliado", "Error", o similar, el "status" debe ser obligatoriamente "fallido". Si muestra "exitoso", "aprobada", "Listo", o un checkmark verde/azul de éxito, el "status" es "exitoso".\n2. El "monto_bs" debe ser un número flotante limpio (ej: "2.000,00" -> 2000.0, "14.550,00" -> 14550.0).\n3. Extrae la referencia completa sin espacios.\n4. Si algún dato no es visible, pon null.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ]
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter Vision API error (${response.status}): ${errText.substring(0, 200)}`);
    }
    const json = await response.json();
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    console.log('[COMMERCE] Vision API Response:', content);
    const cleanJsonStr = content.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJsonStr);
  } catch (e) {
    console.error('[COMMERCE] Error analizando captura de pago móvil:', e.message);
    return null;
  }
}

module.exports = {
  processMessage,
  generateQnA,
  vectorizeQnA,
  askDynamicQuestions,
  generateOperationalManual,
  refineOperationalManual,
  chunkAndVectorizeManual,
  vectorizeSingleQA,
  resolveButtonAction,
  runActionChain,
  ACTION_HANDLERS,
  redisClient,
  pgPool,
};
