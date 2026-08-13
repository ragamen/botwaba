require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Faltan las credenciales de Supabase en el archivo .env (SUPABASE_URL, SUPABASE_KEY)");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    auth: { persistSession: false },
    realtime: { transport: WebSocket },
    db: { schema: 'botwaba' }
  }
);

// Configuración de Chatwoot
const chatwootBaseUrl = process.env.CHATWOOT_BASE_URL;
const chatwootApiToken = process.env.CHATWOOT_API_TOKEN;
const chatwootAccountId = process.env.CHATWOOT_ACCOUNT_ID || 1; // Usualmente 1 para la cuenta principal

if (!chatwootBaseUrl || !chatwootApiToken) {
  console.error("❌ Faltan las credenciales globales de Chatwoot en el archivo .env (CHATWOOT_BASE_URL, CHATWOOT_API_TOKEN)");
  process.exit(1);
}

async function syncInboxes() {
  console.log(`\n📡 Conectando a Chatwoot: ${chatwootBaseUrl}`);
  console.log(`📦 Account ID: ${chatwootAccountId}`);

  try {
    // 0. Validar el Token y Obtener Account ID dinámicamente
    console.log(`🔍 Verificando token con /api/v1/profile...`);
    const profileRes = await fetch(`${chatwootBaseUrl.replace(/\/$/, '')}/api/v1/profile`, {
      method: 'GET',
      headers: {
        'api_access_token': chatwootApiToken,
        'Content-Type': 'application/json'
      }
    });

    if (!profileRes.ok) {
      const err = await profileRes.text();
      console.error(`❌ El Token fue rechazado en /api/v1/profile. Status: ${profileRes.status} - ${err}`);
      console.log(`💡 Asegúrate de copiar el 'Access Token' desde Profile Settings (Configuraciones de Perfil) de un usuario Administrador, NO de un Agent Bot.`);
      return;
    }

    const profileData = await profileRes.json();
    console.log(`✅ Autenticado como: ${profileData.name} (${profileData.email})`);
    
    // Obtener el primer account_id disponible para este usuario
    const accountId = profileData.account_id || chatwootAccountId;
    console.log(`📦 Usando Account ID: ${accountId}`);

    // 1. Obtener los inboxes desde Chatwoot
    const response = await fetch(`${chatwootBaseUrl.replace(/\/$/, '')}/api/v1/accounts/${accountId}/inboxes`, {
      method: 'GET',
      headers: {
        'api_access_token': chatwootApiToken,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Error en la API de Chatwoot: ${response.status} - ${err}`);
    }

    const { payload: inboxes } = await response.json();
    
    if (!inboxes || inboxes.length === 0) {
      console.log("ℹ️ No se encontraron inboxes en Chatwoot.");
      return;
    }

    console.log(`✅ Se encontraron ${inboxes.length} inboxes en Chatwoot. Sincronizando con Supabase...\n`);

    let creados = 0;
    let omitidos = 0;
    let errores = 0;

    // 2. Iterar sobre cada inbox y guardarlo en Supabase
    for (const inbox of inboxes) {
      const inbox_id = inbox.id.toString();
      const nombre = inbox.name;
      
      console.log(`Procesando Inbox: ${nombre} (ID: ${inbox_id})`);

      // Verificamos si ya existe en Supabase
      const { data: existente, error: checkError } = await supabase
        .from('clientes_bot')
        .select('inbox_id')
        .eq('inbox_id', inbox_id)
        .single();

      if (checkError && checkError.code !== 'PGRST116') { // PGRST116 significa que no retornó resultados (está bien, es nuevo)
        console.error(`  ❌ Error consultando la base de datos:`, checkError.message);
        errores++;
        continue;
      }

      if (existente) {
        console.log(`  ⏭️ El inbox ya existe en Supabase. Omitiendo.`);
        omitidos++;
      } else {
        // Insertamos la nueva fila
        const { error: insertError } = await supabase
          .from('clientes_bot')
          .insert({
            inbox_id: inbox_id,
            chatwoot_token: chatwootApiToken, // Token maestro por defecto, lo puedes cambiar luego en Supabase
            chatwoot_url: chatwootBaseUrl,
            ai_model: null, // Dejamos null para que use el default
            system_prompt: `Eres un asistente virtual amable atendiendo el canal de ${nombre}.`,
          });

        if (insertError) {
          console.error(`  ❌ Error insertando:`, insertError.message);
          errores++;
        } else {
          console.log(`  ✨ Inbox registrado en Supabase correctamente.`);
          creados++;
        }
      }
    }

    console.log(`\n🎉 Sincronización finalizada.`);
    console.log(`📊 Resumen: ${creados} insertados, ${omitidos} omitidos, ${errores} errores.\n`);

  } catch (error) {
    console.error("\n❌ Ocurrió un error general durante la sincronización:", error.message);
  }
}

syncInboxes();
