// cronWorker.js
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { Pool } = require('pg');

const postgresUrl = process.env.POSTGRES_URL;
const checkIntervalMs = 15 * 60 * 1000; // Cada 15 minutos

if (!postgresUrl) {
  console.error('[CRON-WORKER] Error: POSTGRES_URL no definido en .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: postgresUrl,
  options: '-c search_path=botwaba,meta_saas,public'
});

console.log('[CRON-WORKER] Iniciado. Escaneando carritos abandonados cada 15 minutos...');

async function scanAbandonedCarts() {
  console.log('[CRON-WORKER] Iniciando escaneo de sesiones inactivas...');
  try {
    // Buscar sesiones en estado SELECTING (con artículos) inactivas por más de 1 hora
    const query = `
      SELECT cs.id, cs.inbox_id, cs.customer_phone, cs.cart, cs.customer_email, sc.company_name, sc.abandoned_cart_email_enabled
      FROM botwaba.commerce_sessions cs
      JOIN meta_saas.saas_clients sc ON cs.inbox_id = sc.inbox_id
      WHERE cs.state = 'SELECTING'
        AND cs.abandoned_notified = false
        AND cs.updated_at < NOW() - INTERVAL '1 hour'
    `;
    const { rows: abandonedSessions } = await pool.query(query);

    if (abandonedSessions.length === 0) {
      console.log('[CRON-WORKER] No se encontraron nuevos carritos abandonados.');
      return;
    }

    console.log(`[CRON-WORKER] Detectados ${abandonedSessions.length} carritos abandonados.`);

    for (const session of abandonedSessions) {
      const { id, inbox_id, customer_phone, cart, customer_email, company_name, abandoned_cart_email_enabled } = session;
      let cartArr = [];
      try {
        cartArr = typeof cart === 'string' ? JSON.parse(cart) : (cart || []);
      } catch (e) {
        cartArr = [];
      }

      if (cartArr.length === 0) continue;

      const itemsText = cartArr.map(item => `- ${item.qty}x ${item.title}`).join('\n');
      console.log(`[CRON-WORKER] Procesando abandono de ${customer_phone} para el negocio ${company_name}.`);

      // 1. Intentar recuperación por Email si está habilitado y tenemos el correo
      if (abandoned_cart_email_enabled && customer_email) {
        console.log(`[CRON-WORKER-EMAIL] Enviando correo de recuperación a ${customer_email}...`);
        // Simulación de envío de correo en logs (ampliable a SMTP / SendGrid / Resend)
        console.log(`
          --- CORREO SIMULADO ---
          Para: ${customer_email}
          Asunto: ¡Dejaste algo en tu carrito de ${company_name}!
          Cuerpo:
          Hola, notamos que no terminaste tu compra. Aquí están tus artículos:
          ${itemsText}
          Abre tu WhatsApp y escribe *carrito* para completar el pedido.
          -----------------------
        `);
      } else {
        // 2. Fallback a WhatsApp
        console.log(`[CRON-WORKER-WHATSAPP] Enviando recordatorio de WhatsApp a ${customer_phone}...`);
        try {
          // Obtener credenciales WABA del negocio
          const { rows: wabaCreds } = await pool.query(
            'SELECT access_token FROM meta_saas.wabas WHERE waba_id = (SELECT waba_id FROM meta_saas.phones WHERE phone_id = CAST($1 AS bigint) LIMIT 1) LIMIT 1',
            [inbox_id]
          );

          const token = wabaCreds[0]?.access_token;
          if (token) {
            const body = {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: customer_phone.replace(/^\+/, ''),
              type: 'text',
              text: {
                preview_url: false,
                body: `¡Hola! Notamos que dejaste algunos artículos en tu carrito de *${company_name}* 🛒:\n\n${itemsText}\n\nEscribe *carrito* si deseas completar tu orden o realizar cambios. 😊`
              }
            };

            const res = await fetch(`https://graph.facebook.com/v20.0/${inbox_id}/messages`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });

            if (res.ok) {
              const msgId = 'msg_cron_' + Date.now();
              // Registrar mensaje en el CRM para que el agente vea el recordatorio en la conversación
              await pool.query(
                `INSERT INTO meta_saas.messages (conversation_id, direction, content, message_id, sender_name, timestamp)
                 VALUES ((SELECT id FROM meta_saas.conversations WHERE inbox_id = $1 AND customer_phone = $2 LIMIT 1), 'outbound', $3, $4, 'Recordador de Carrito', Math.floor(Date.now() / 1000))`,
                [inbox_id, customer_phone, `[Recordatorio de Carrito Abandonado Enviado]\n${itemsText}`, msgId]
              );
              console.log(`[CRON-WORKER-WHATSAPP] Notificación enviada con éxito a ${customer_phone}.`);
            } else {
              console.error('[CRON-WORKER-WHATSAPP] Error enviando recordatorio:', await res.text());
            }
          }
        } catch (waErr) {
          console.error('[CRON-WORKER-WHATSAPP] Error:', waErr.message);
        }
      }

      // Marcar sesión como notificada para no duplicar envíos
      await pool.query('UPDATE botwaba.commerce_sessions SET abandoned_notified = true WHERE id = $1', [id]);
    }
  } catch (err) {
    console.error('[CRON-WORKER] Error en escaneo:', err.message);
  }
}

// Ejecutar inmediatamente al arrancar y luego cada 15 min
scanAbandonedCarts();
setInterval(scanAbandonedCarts, checkIntervalMs);
