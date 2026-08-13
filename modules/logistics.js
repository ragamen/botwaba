// logistics.js
'use strict';

async function handleLogisticsMessage({ recipient, message, context, pgPool, sendReply }) {
  console.log('[LOGISTICS] Procesando mensaje en modelo de logística');
  
  const text = message.messageText || '';
  const isLocation = message.messageType === 'location' || message.location;
  
  if (isLocation) {
    const loc = message.location || {};
    const lat = loc.latitude;
    const lng = loc.longitude;
    const address = loc.address || loc.name || 'Ubicación compartida';
    
    await sendReply(`📍 Ubicación recibida: ${address} (lat: ${lat}, lng: ${lng}). Estimando precio y buscando conductores...`);
    // Enviar webhook de asignación de conductores
    return;
  }
  
  await sendReply("👋 Bienvenido al servicio de despacho rápido. Por favor, comparte tu ubicación actual usando la opción de WhatsApp 'Compartir ubicación' para estimar tu tarifa.");
}

module.exports = { handleLogisticsMessage };
