const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
global.WebSocket = require('ws');

const { 
  processMessage, 
  generateQnA, 
  vectorizeQnA,
  askDynamicQuestions,
  generateOperationalManual,
  refineOperationalManual,
  chunkAndVectorizeManual,
  vectorizeSingleQA,
  redisClient,
  pgPool
} = require('./aiService');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  db: { schema: 'botwaba' }
});

const supabaseMeta = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  db: { schema: 'meta_saas' }
});

// Inicializar cliente de Ably para notificaciones en tiempo real al CRM
const Ably = require('ably');
const ably = process.env.ABLY_API_KEY ? new Ably.Realtime({ key: process.env.ABLY_API_KEY }) : null;
if (ably) {
  ably.connection.on('connected', () => {
    console.log('[Ably] 🔌 Conectado exitosamente en botwaba');
  });
}

const app = express();

// Configurar CORS para permitir solo el SaaS
const allowedOrigins = ['https://mbtechpanel.mbtech.work', 'http://localhost:3000'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-internal-secret']
}));

// Usamos el middleware para parsear JSON pero guardando el body crudo para el HMAC
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const PORT = process.env.PORT || 4000;
// ==========================================
// MÓDULO RAG Y ENDPOINTS INTERNOS (SaaS)
// ==========================================

// Middleware básico para proteger los endpoints internos
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'mbtech_internal_rag_123';

const verifyInternalAuth = (req, res, next) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== INTERNAL_SECRET) {
    console.error(`[API] ❌ Intento no autorizado con token: ${secret}`);
    return res.status(401).json({ error: 'Unauthorized internal access' });
  }
  next();
};

app.post('/api/internal/bot-webhook', verifyInternalAuth, (req, res) => {
  // 1. Procesamiento 'Zero-Wait'
  // Enviamos 200 OK inmediatamente para liberar el hilo del SaaS
  res.status(200).json({ status: 'ok', message: 'Accepted' });

  // 2. Enrutamiento dinámico (Lógica asíncrona)
  const payload = req.body;
  console.log(`[DEBUG] Llamando a processMessage con payload:`, payload);
  
  // Ejecutamos la promesa asíncrona en background
  processMessage(payload).catch(err => {
    console.error(`[BOT] ❌ Excepción no capturada en background:`, err);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT UNIVERSAL: Bots externos reportan mensajes salientes al CRM Inbox
// Soporta: text | image | audio | video | document | location | sticker
//
// Payload esperado:
// {
//   phone_number_id: "123456",        ← ID del número de WhatsApp Business
//   customer_phone:  "584121234567",  ← Teléfono del cliente (sin +)
//   type:            "text",          ← Tipo de mensaje (default: "text")
//   content:         "Hola!",         ← Texto o descripción del mensaje
//   media_url:       "https://...",   ← URL pública del media (opcional)
//   media_type:      "image/jpeg",    ← MIME type del media (opcional)
//   sender_name:     "Bot Taxi",      ← Nombre que aparece en el inbox
//   message_id:      "wamid.xxx",     ← ID de Meta (opcional, se genera uno)
// }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/internal/log-outbound', verifyInternalAuth, async (req, res) => {
  // Respuesta inmediata — no bloqueamos al bot
  res.status(200).json({ status: 'ok', message: 'Message logged' });

  const {
    phone_number_id,
    customer_phone,
    type        = 'text',
    content     = '',
    media_url   = null,
    media_type  = null,
    sender_name = 'Bot',
    message_id,
  } = req.body;

  // Validación mínima
  if (!phone_number_id || !customer_phone) {
    console.warn('[LOG-OUTBOUND] ⚠️ Faltan phone_number_id o customer_phone. Se ignorará.');
    return;
  }
  if (!content && !media_url) {
    console.warn('[LOG-OUTBOUND] ⚠️ Mensaje sin content ni media_url. Se ignorará.');
    return;
  }

  // Texto de fallback para tipos de media sin caption
  const CONTENT_FALLBACK = {
    image:    '🖼️ [Imagen]',
    audio:    '🎵 [Audio]',
    voice:    '🎤 [Nota de voz]',
    video:    '🎬 [Video]',
    document: '📄 [Documento]',
    location: '📍 [Ubicación]',
    sticker:  '😀 [Sticker]',
  };
  const displayContent = content || CONTENT_FALLBACK[type] || `[${type}]`;

  try {
    const cleanPhone = String(customer_phone).replace(/^\+/, '');
    let convData = null;

    if (pgPool) {
      try {
        const { rows: cRows } = await pgPool.query(
          'SELECT id, waba_id FROM meta_saas.conversations WHERE phone_number_id = $1 AND customer_phone = $2 LIMIT 1',
          [phone_number_id, cleanPhone]
        );
        if (cRows.length > 0) convData = cRows[0];
      } catch (dbErr) {
        console.error('[LOG-OUTBOUND] ❌ Error buscando conversación en PostgreSQL:', dbErr.message);
      }
    }

    if (!convData && supabaseMeta) {
      const { data, error: convErr } = await supabaseMeta
        .from('conversations')
        .select('id, waba_id')
        .eq('phone_number_id', phone_number_id)
        .eq('customer_phone', cleanPhone)
        .maybeSingle();

      if (convErr) {
        console.error('[LOG-OUTBOUND] ❌ Error buscando conversación:', convErr.message);
      }
      convData = data;
    }

    if (!convData?.id) {
      console.warn(`[LOG-OUTBOUND] ⚠️ Sin conversación para phone_number_id=${phone_number_id}, customer=${cleanPhone}`);
      return;
    }

    // 2. Insertar el mensaje saliente en meta_saas.messages
    const msgId = message_id || `bot_out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nowTimestamp = Math.floor(Date.now() / 1000);
    let insertSuccess = false;

    if (pgPool) {
      try {
        await pgPool.query(
          `INSERT INTO meta_saas.messages (conversation_id, direction, content, message_id, sender_name, media_url, media_type, timestamp)
           VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7)`,
          [convData.id, displayContent, msgId, sender_name, media_url, media_type || (type !== 'text' ? type : null), nowTimestamp]
        );
        insertSuccess = true;
      } catch (pgInsertErr) {
        console.error('[LOG-OUTBOUND] ❌ Error insertando mensaje en PostgreSQL:', pgInsertErr.message);
      }
    }

    if (!insertSuccess && supabaseMeta) {
      const { error: insertErr } = await supabaseMeta
        .from('messages')
        .insert({
          conversation_id: convData.id,
          direction:       'outbound',
          content:         displayContent,
          message_id:      msgId,
          sender_name:     sender_name,
          media_url:       media_url,
          media_type:      media_type || (type !== 'text' ? type : null),
          timestamp:       nowTimestamp,
        });

      if (!insertErr) insertSuccess = true;
      else console.error('[LOG-OUTBOUND] ❌ Error insertando mensaje en Supabase:', insertErr.message);
    }

    if (insertSuccess) {
      const icon = { image:'🖼️', audio:'🎵', voice:'🎤', video:'🎬', document:'📄', location:'📍', text:'💬' }[type] || '📩';
      console.log(`[LOG-OUTBOUND] ${icon} [${type}] de "${sender_name}" guardado en conv: ${convData.id}`);

      // 3. Emitir el evento de Ably en tiempo real para refrescar la interfaz del CRM inmediatamente
      if (ably) {
        try {
          const channel = ably.channels.get('get-started');
          const ablyPayload = {
            object: 'whatsapp_business_account',
            entry: [
              {
                id: convData.waba_id || 'unknown',
                changes: [
                  {
                    field: 'messages',
                    value: {
                      messaging_product: 'whatsapp',
                      metadata: {
                        phone_number_id: phone_number_id
                      },
                      contacts: [
                        {
                          profile: { name: sender_name },
                          wa_id: cleanPhone
                        }
                      ],
                      messages: [
                        {
                          id: msgId,
                          from: '_ackbot_',
                          _ackbot_recipient: cleanPhone,
                          type: type,
                          timestamp: nowTimestamp,
                          text: type === 'text' ? { body: displayContent } : undefined,
                          image: type === 'image' ? { caption: displayContent, url: media_url } : undefined,
                          location: type === 'location' ? { name: displayContent } : undefined
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          };

          channel.publish('first', ablyPayload)
            .then(() => {
              console.log(`[LOG-OUTBOUND] 📡 Evento en tiempo real emitido a Ably para conv: ${convData.id}`);
            })
            .catch((err) => {
              console.error('[LOG-OUTBOUND] ❌ Error publicando a Ably:', err.message);
            });
        } catch (ablyErr) {
          console.error('[LOG-OUTBOUND] ❌ Error enviando notificación en tiempo real:', ablyErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[LOG-OUTBOUND] ❌ Excepción inesperada:', err.message);
  }
});

app.post('/api/internal/human-reply', verifyInternalAuth, (req, res) => {
  // 1. Procesamiento 'Zero-Wait'
  res.status(200).json({ status: 'ok', message: 'Accepted' });

  // 2. Lógica asíncrona en background para no bloquear el CRM
  (async () => {
    try {
      const { inbox_id, conversation_id, message_content } = req.body;
      if (!inbox_id || !conversation_id || !message_content) {
        console.warn('[AUTO-LEARN] ⚠️ Faltan campos requeridos (inbox_id, conversation_id o message_content)');
        return;
      }

      console.log(`[AUTO-LEARN] 🧠 Procesando respuesta humana para conv: ${conversation_id}, inbox: ${inbox_id}`);

      // Buscar el último mensaje entrante ('inbound') en esta conversación
      let lastInboundMsg = null;
      if (pgPool) {
        const { rows } = await pgPool.query(
          `SELECT content FROM messages 
           WHERE conversation_id = $1 AND direction = 'inbound' 
           ORDER BY timestamp DESC LIMIT 1`,
          [conversation_id]
        );
        if (rows && rows.length > 0) {
          lastInboundMsg = rows[0].content;
        }
      } else {
        const { data, error } = await supabaseMeta
          .from('messages')
          .select('content')
          .eq('conversation_id', conversation_id)
          .eq('direction', 'inbound')
          .order('timestamp', { ascending: false })
          .limit(1);
        if (!error && data && data.length > 0) {
          lastInboundMsg = data[0].content;
        }
      }

      if (!lastInboundMsg || lastInboundMsg.trim() === '') {
        console.log(`[AUTO-LEARN] ⏭️ No se encontró mensaje previo del cliente para emparejar.`);
        return;
      }

      const questionText = lastInboundMsg.trim();
      const answerText = message_content.trim();

      // Filtrado rápido: Evitar guardar textos de cortesía muy cortos
      if (answerText.length < 5 || questionText.length < 3) {
        console.log(`[AUTO-LEARN] ⏭️ Pregunta o respuesta demasiado corta para ser conocimiento. Omitiendo.`);
        return;
      }

      // Verificar duplicados exactos en company_knowledge
      const { data: existingQA, error: checkError } = await supabase
        .from('company_knowledge')
        .select('id')
        .eq('inbox_id', inbox_id.toString())
        .eq('question', questionText)
        .limit(1);

      if (checkError) {
        console.warn('[AUTO-LEARN] Error buscando duplicados:', checkError.message);
      }

      if (existingQA && existingQA.length > 0) {
        console.log(`[AUTO-LEARN] ⏭️ Ya existe la pregunta exacta en la base de conocimientos. Omitiendo.`);
        return;
      }

      // Insertar en company_knowledge con status: 'pending' (y sin vector inicial)
      const { error: insertError } = await supabase
        .from('company_knowledge')
        .insert({
          inbox_id: inbox_id.toString(),
          question: questionText,
          answer: answerText,
          status: 'pending'
        });

      if (insertError) {
        console.error('[AUTO-LEARN] ❌ Error insertando sugerencia pendiente:', insertError.message);
      } else {
        console.log(`[AUTO-LEARN] ✨ Nueva sugerencia de conocimiento guardada en estado PENDIENTE para el inbox: ${inbox_id}`);
      }

    } catch (err) {
      console.error('[AUTO-LEARN] ❌ Excepción en auto-aprendizaje:', err.message);
    }
  })();
});

// ==========================================
// RUTAS PARA EL RAG (Consumidas por el SaaS)
// ==========================================

app.post('/api/rag/generate', verifyInternalAuth, async (req, res) => {
  try {
    const qas = await generateQnA(req.body);
    res.json(qas);
  } catch (error) {
    console.error(`[API] ❌ Error en /api/rag/generate:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rag/vectorize', verifyInternalAuth, async (req, res) => {
  try {
    const { inbox_id, qas } = req.body;
    if (!inbox_id || !qas || !Array.isArray(qas)) {
      return res.status(400).json({ error: 'Falta inbox_id o qas es inválido' });
    }
    const results = await vectorizeQnA(inbox_id, qas);
    res.json({ message: 'Conocimiento vectorizado y guardado con éxito.', results });
  } catch (error) {
    console.error('Error en /api/rag/vectorize:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// NUEVO ONBOARDING MULTI-ETAPA PARA SaaS
// ==========================================

// Paso 1: Consultor - Indagación
app.post('/api/onboarding/indagar', async (req, res) => {
  try {
    const { inbox_id, initialDescription } = req.body;
    if (!inbox_id || !initialDescription) {
      return res.status(400).json({ error: 'Faltan campos (inbox_id, initialDescription)' });
    }
    const result = await askDynamicQuestions({ description: initialDescription });
    
    // Si la IA identificó una categoría global, la guardamos sigilosamente en la descripción
    if (result.category_name && supabaseMeta) {
      console.log(`[ONBOARDING] Categoría detectada: ${result.category_name}. Guardando en CRM...`);
      const updatedNature = initialDescription + `\n[Categoría AI: ${result.category_name}]`;
      await supabaseMeta
        .from('saas_clients')
        .update({ business_nature: updatedNature })
        .eq('inbox_id', inbox_id);
    }
    
    res.json(result); // Devuelve { category_name, questions: [...] }
  } catch (error) {
    console.error('Error en /api/onboarding/indagar:', error);
    res.status(500).json({ error: error.message });
  }
});

// Paso 1.5: Guardar Progreso del Cuestionario
app.post('/api/onboarding/save_progress', async (req, res) => {
  try {
    const { inbox_id, questions, answers } = req.body;
    if (!inbox_id) return res.status(400).json({ error: 'Falta inbox_id' });
    
    // Asumimos que el cliente ya existe en saas_clients (se crea desde CRM antes)
    const { error } = await supabaseMeta
      .from('saas_clients')
      .update({
        onboarding_questions: questions || null,
        onboarding_answers: answers || null
      })
      .eq('inbox_id', inbox_id.toString());
      
    if (error) throw error;
    res.json({ message: 'Progreso guardado' });
  } catch (error) {
    console.error('Error guardando progreso:', error);
    res.status(500).json({ error: error.message });
  }
});

// Paso 2: Redactor - Crear Manual
app.post('/api/onboarding/generar_manual', async (req, res) => {
  try {
    const { inbox_id, additionalContext } = req.body;
    if (!inbox_id || !additionalContext) {
      return res.status(400).json({ error: 'Faltan campos' });
    }
    const manualMarkdown = await generateOperationalManual({ rawContext: additionalContext });
    res.json({ manual: manualMarkdown });
  } catch (error) {
    console.error('Error en /api/onboarding/generar_manual:', error);
    res.status(500).json({ error: error.message });
  }
});

// Paso 2.5: Refinamiento del Manual
app.post('/api/onboarding/refinar_manual', async (req, res) => {
  try {
    const { currentManual, feedback } = req.body;
    if (!currentManual || !feedback) {
      return res.status(400).json({ error: 'Faltan campos' });
    }
    const refinedManual = await refineOperationalManual({ currentManual, feedback });
    res.json({ manual: refinedManual });
  } catch (error) {
    console.error('Error en /api/onboarding/refinar_manual:', error);
    res.status(500).json({ error: error.message });
  }
});

// Paso 3: Cirujano - Chunking y Vectorización
app.post('/api/onboarding/vectorizar_manual', async (req, res) => {
  try {
    const { inbox_id, manual, webhookUrl } = req.body;
    if (!inbox_id || !manual) {
      return res.status(400).json({ error: 'Falta inbox_id o manual' });
    }
    const results = await chunkAndVectorizeManual(inbox_id.toString(), manual);
    res.json({ message: 'Manual procesado y vectorizado con éxito.', results });
  } catch (error) {
    console.error('Error en /api/onboarding/vectorizar_manual:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// PLANTILLAS DE DEMOS (DEMO TEMPLATES)
// ==========================================

// Listar todas las plantillas de demostración
app.get('/api/onboarding/templates', async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT id, title, category_key, business_nature, bot_module_type, description, master_manual, created_at 
       FROM botwaba.demo_templates 
       ORDER BY created_at ASC`
    );
    res.json({ templates: rows || [] });
  } catch (error) {
    console.error('Error al listar demo templates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Guardar nueva plantilla o actualizar existente
app.post('/api/onboarding/templates/save', async (req, res) => {
  try {
    const { title, category_key, business_nature, bot_module_type, description, master_manual } = req.body;
    if (!title || !master_manual) {
      return res.status(400).json({ error: 'Falta título o manual para la plantilla' });
    }
    const key = category_key || title.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { rows } = await pgPool.query(
      `INSERT INTO botwaba.demo_templates (title, category_key, business_nature, bot_module_type, description, master_manual)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category_key) DO UPDATE SET
         title = EXCLUDED.title,
         business_nature = EXCLUDED.business_nature,
         bot_module_type = EXCLUDED.bot_module_type,
         description = EXCLUDED.description,
         master_manual = EXCLUDED.master_manual
       RETURNING *`,
      [title, key, business_nature || 'General', bot_module_type || 'basic_qa', description || '', master_manual]
    );
    res.json({ success: true, template: rows[0] });
  } catch (error) {
    console.error('Error al guardar demo template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aplicar plantilla completa a un inbox de demo
app.post('/api/onboarding/templates/apply', async (req, res) => {
  try {
    const { inbox_id, template_id } = req.body;
    if (!inbox_id || !template_id) {
      return res.status(400).json({ error: 'Faltan parámetros inbox_id o template_id' });
    }

    const { rows: tRows } = await pgPool.query(
      `SELECT * FROM botwaba.demo_templates WHERE id = $1 LIMIT 1`,
      [template_id]
    );
    if (!tRows || tRows.length === 0) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }
    const t = tRows[0];

    // 1. Actualizar configuración en clientes_bot
    await pgPool.query(
      `UPDATE botwaba.clientes_bot 
       SET bot_module_type = $1 
       WHERE inbox_id = $2`,
      [t.bot_module_type, inbox_id.toString()]
    );

    // 2. Actualizar configuración en saas_clients (si existe)
    await pgPool.query(
      `UPDATE meta_saas.saas_clients 
       SET business_nature = $1 
       WHERE inbox_id = $2`,
      [t.business_nature, inbox_id.toString()]
    );

    // 3. Guardar el manual maestro en company_profiles
    await pgPool.query(
      `INSERT INTO botwaba.company_profiles (inbox_id, master_manual, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (inbox_id) DO UPDATE SET
         master_manual = EXCLUDED.master_manual,
         updated_at = NOW()`,
      [inbox_id.toString(), t.master_manual]
    );

    // 4. Si el módulo usa RAG vectorial (basic_qa, appointments, lead_gen, retail_delivery)
    if (['basic_qa', 'appointments', 'lead_gen', 'retail_delivery'].includes(t.bot_module_type)) {
      await chunkAndVectorizeManual(inbox_id.toString(), t.master_manual);
    } else {
      // Limpiar memoria anterior para que no contamine otros módulos como commerce o taxi
      await pgPool.query(`DELETE FROM botwaba.company_knowledge WHERE inbox_id = $1`, [inbox_id.toString()]);
    }

    res.json({
      success: true,
      message: `Plantilla "${t.title}" aplicada con éxito al inbox ${inbox_id}. Módulo activo: ${t.bot_module_type}.`,
      template: t
    });
  } catch (error) {
    console.error('Error al aplicar demo template:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// EDITOR DE CONOCIMIENTO (Q&A CRUD)
// ==========================================

app.get('/api/onboarding/knowledge/:inbox_id', async (req, res) => {
  try {
    const { inbox_id } = req.params;
    const { data, error } = await supabase
      .from('company_knowledge')
      .select('id, question, answer, status, usage_count, feedback_score')
      .eq('inbox_id', inbox_id.toString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/onboarding/knowledge', async (req, res) => {
  try {
    const { inbox_id, question, answer } = req.body;
    if (!inbox_id || !question || !answer) return res.status(400).json({ error: 'Faltan campos' });
    
    // Generar embedding
    const embedding = await vectorizeSingleQA(question, answer);
    
    const { data, error } = await supabase
      .from('company_knowledge')
      .insert({
        inbox_id: inbox_id.toString(),
        question,
        answer,
        embedding,
        status: 'approved'
      })
      .select();
    if (error) throw error;
    res.json({ message: 'Q&A añadido exitosamente', data: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/onboarding/knowledge/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { question, answer } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'Faltan campos' });
    
    // Generar embedding nuevo
    const embedding = await vectorizeSingleQA(question, answer);
    
    const { data, error } = await supabase
      .from('company_knowledge')
      .update({
        question,
        answer,
        embedding
      })
      .eq('id', id)
      .select();
    if (error) throw error;
    res.json({ message: 'Q&A actualizado exitosamente', data: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/onboarding/knowledge/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('company_knowledge')
      .delete()
      .eq('id', id);
    if (error) throw error;
    res.json({ message: 'Q&A eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/onboarding/knowledge/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Obtener la pregunta y respuesta desde Supabase
    const { data: qa, error: fetchError } = await supabase
      .from('company_knowledge')
      .select('question, answer, inbox_id')
      .eq('id', id)
      .single();

    if (fetchError || !qa) throw new Error('No se encontró el registro de conocimiento o ya no está disponible');

    // 2. Generar el embedding vectorial con OpenRouter
    const embedding = await vectorizeSingleQA(qa.question, qa.answer);

    // 3. Actualizar el registro a 'approved' con el vector
    const { data, error: updateError } = await supabase
      .from('company_knowledge')
      .update({
        status: 'approved',
        embedding
      })
      .eq('id', id)
      .select();

    if (updateError) throw updateError;

    // 4. Invalidar la caché de configuración para que se recupere la nueva versión del bot (opcional)
    const configCacheKey = `inbox:${qa.inbox_id}:config`;
    try {
      await redisClient.del(configCacheKey);
    } catch (err) {
      console.warn(`[Redis] Error invalidando caché tras aprobación:`, err.message);
    }

    res.json({ message: 'Q&A aprobado y vectorizado exitosamente', data: data[0] });
  } catch (error) {
    console.error('[API] Error al aprobar Q&A:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/onboarding/window/:inbox_id/:recipient', async (req, res) => {
  try {
    const { inbox_id, recipient } = req.params;
    const windowCacheKey = `inbox:${inbox_id}:window:${recipient}`;
    
    // Intentar leer de Redis
    try {
      const isCached = await redisClient.get(windowCacheKey);
      if (isCached === 'true') {
        return res.json({ window_open: true });
      }
    } catch (err) {
      console.warn(`[Redis] Error consultando caché de ventana:`, err.message);
    }

    // Si no está en caché, buscar en base de datos.
    let lastInboundTime = null;
    let conversationId = null;

    if (pgPool) {
      const { rows: convRows } = await pgPool.query(
        `SELECT id FROM conversations 
         WHERE phone_number_id = $1 AND customer_phone = $2 LIMIT 1`,
        [inbox_id, recipient]
      );
      if (convRows && convRows.length > 0) {
        conversationId = convRows[0].id;
        const { rows: msgRows } = await pgPool.query(
          `SELECT timestamp FROM messages 
           WHERE conversation_id = $1 AND direction = 'inbound' 
           ORDER BY timestamp DESC LIMIT 1`,
          [conversationId]
        );
        if (msgRows && msgRows.length > 0) {
          lastInboundTime = parseInt(msgRows[0].timestamp);
        }
      }
    } else {
      const { data: convData } = await supabaseMeta
        .from('conversations')
        .select('id')
        .eq('phone_number_id', inbox_id)
        .eq('customer_phone', recipient)
        .limit(1);
      if (convData && convData.length > 0) {
        conversationId = convData[0].id;
        const { data: msgData, error } = await supabaseMeta
          .from('messages')
          .select('timestamp')
          .eq('conversation_id', conversationId)
          .eq('direction', 'inbound')
          .order('timestamp', { ascending: false })
          .limit(1);
        if (!error && msgData && msgData.length > 0) {
          lastInboundTime = parseInt(msgData[0].timestamp);
        }
      }
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
          console.warn(`[Redis] Error guardando ventana en caché:`, err.message);
        }
      }
    }

    res.json({ window_open: isOpen });
  } catch (error) {
    console.error('[API] Error en /api/onboarding/window:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// RUTAS CRM (SAAS)
// ==========================================

// Obtener manual existente (Modo Edición)
app.get('/api/onboarding/manual/:inbox_id', async (req, res) => {
  try {
    const { inbox_id } = req.params;
    
    if (!inbox_id) {
      return res.status(400).json({ error: 'inbox_id es requerido' });
    }

    const { data: manualData } = await supabase
      .from('company_profiles')
      .select('master_manual')
      .eq('inbox_id', inbox_id.toString())
      .single();

    const { data: saasData } = await supabaseMeta
      .from('saas_clients')
      .select('onboarding_questions, onboarding_answers, business_nature')
      .eq('inbox_id', inbox_id.toString())
      .single();

    if (!manualData && !saasData) {
      return res.json({ manual: null, questions: null, answers: null, business_nature: null });
    }

    res.json({ 
      manual: manualData?.master_manual || null,
      questions: saasData?.onboarding_questions || null,
      answers: saasData?.onboarding_answers || null,
      business_nature: saasData?.business_nature || null
    });
  } catch (error) {
    console.error('Error fetching manual:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener todos los clientes
app.get('/api/crm/clients', async (req, res) => {
  try {
    const { data: clients, error } = await supabaseMeta
      .from('saas_clients')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;

    // Obtener las configuraciones de los bots asociadas
    const { data: botConfigs } = await supabase
      .from('clientes_bot')
      .select('inbox_id, bot_module_type, is_delivery_enabled, address_details, payment_pago_movil, commerce_settings');

    const mergedClients = (clients || []).map(client => {
      const bot = (botConfigs || []).find(b => b.inbox_id === client.inbox_id);
      return {
        ...client,
        bot_module_type: bot?.bot_module_type || 'basic_qa',
        is_delivery_enabled: bot?.is_delivery_enabled || false,
        address_details: bot?.address_details || {"street": "", "city": "", "pickup_instructions": ""},
        payment_pago_movil: bot?.payment_pago_movil || {"banco": "", "rif": "", "telefono": "", "nombre_titular": "", "enabled": false},
        commerce_settings: bot?.commerce_settings || {"catalog_id": "", "currency": "USD", "delivery_fee": 0.00, "min_order_value": 0.00}
      };
    });

    res.json({ clients: mergedClients });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: error.message });
  }
});

// Demo Switch: Activar un demo específico en un número compartido
app.post('/api/crm/demo-switch', async (req, res) => {
  try {
    const { inbox_id } = req.body;
    if (!inbox_id) return res.status(400).json({ error: 'inbox_id is required' });

    // 1. Find the whatsapp_number for this inbox
    const { rows: scRows } = await pgPool.query(
      'SELECT whatsapp_number FROM meta_saas.saas_clients WHERE inbox_id = $1 LIMIT 1',
      [inbox_id]
    );
    if (scRows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const whatsappNumber = scRows[0].whatsapp_number;

    // 2. Deactivate all demos with the same whatsapp_number
    await pgPool.query(
      'UPDATE meta_saas.saas_clients SET is_active_demo = false WHERE whatsapp_number = $1',
      [whatsappNumber]
    );

    // 3. Activate the selected demo
    await pgPool.query(
      'UPDATE meta_saas.saas_clients SET is_active_demo = true WHERE inbox_id = $1',
      [inbox_id]
    );

    // 4. Find the real phone_number_id to clear its Redis cache
    const { rows: realPhoneRows } = await pgPool.query(
      `SELECT p.phone_id FROM meta_saas.phones p
       JOIN meta_saas.saas_clients sc ON sc.whatsapp_number = '+' || REPLACE(REPLACE(REPLACE(p.phone_id::text, ' ', ''), '-', ''), '+', '')
       WHERE sc.inbox_id = $1 LIMIT 1`,
      [inbox_id]
    );
    // Also try matching by the real phone_number_id inbox
    const { rows: realInboxRows } = await pgPool.query(
      `SELECT inbox_id FROM meta_saas.saas_clients 
       WHERE whatsapp_number = $1 AND inbox_id ~ '^[0-9]+$' LIMIT 1`,
      [whatsappNumber]
    );
    const realPhoneNumberId = realInboxRows.length > 0 ? realInboxRows[0].inbox_id : null;

    // 5. Clear Redis config cache so the bot reloads immediately
    if (realPhoneNumberId && redisClient.isReady) {
      const cacheKey = `inbox:${realPhoneNumberId}:config`;
      await redisClient.del(cacheKey);
      console.log(`[DEMO-SWITCH] Cleared Redis cache: ${cacheKey}`);
    }

    console.log(`[DEMO-SWITCH] Activated demo '${inbox_id}' for number ${whatsappNumber}`);
    res.json({ success: true, active_inbox_id: inbox_id, whatsapp_number: whatsappNumber });
  } catch (error) {
    console.error('[DEMO-SWITCH] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Crear o actualizar un cliente
app.post('/api/crm/clients', async (req, res) => {
  try {
    const { 
      inbox_id, company_name, business_nature, whatsapp_number, 
      facebook_page_id, instagram_account_id, page_access_token, 
      subscription_plan, balance_due, status,
      bot_module_type, is_delivery_enabled, address_details, 
      payment_pago_movil, commerce_settings
    } = req.body;
    
    if (!inbox_id || !company_name) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    // 1. Guardar cliente en saas_clients
    const { data, error } = await supabaseMeta
      .from('saas_clients')
      .upsert({
        inbox_id: inbox_id.toString(),
        company_name,
        business_nature,
        whatsapp_number,
        facebook_page_id,
        instagram_account_id,
        page_access_token,
        subscription_plan: subscription_plan || 'Basic',
        balance_due: balance_due || 0,
        status: status || 'Active'
      }, { onConflict: 'inbox_id' })
      .select();
      
    if (error) throw error;

    // 2. Consultar si ya existe configuración del bot para preservar su prompt actual
    const { data: existingBot } = await supabase
      .from('clientes_bot')
      .select('system_prompt, chatwoot_token, chatwoot_url, ai_model')
      .eq('inbox_id', inbox_id.toString())
      .single();

    // 3. Aprovisionar o actualizar la configuración en clientes_bot
    const { error: botError } = await supabase
      .from('clientes_bot')
      .upsert({
        inbox_id: inbox_id.toString(),
        chatwoot_token: existingBot?.chatwoot_token || page_access_token || 'temp_token',
        chatwoot_url: existingBot?.chatwoot_url || 'https://soporte.mbtech.work',
        ai_model: existingBot?.ai_model || 'openai/gpt-4o-mini',
        system_prompt: existingBot?.system_prompt || `Eres el asistente de ventas oficial de la empresa "${company_name}", cuya naturaleza de negocio es: ${business_nature || 'Soporte'}.`,
        bot_module_type: bot_module_type || 'basic_qa',
        is_delivery_enabled: is_delivery_enabled === true || is_delivery_enabled === 'true',
        address_details: address_details || {"street": "", "city": "", "pickup_instructions": ""},
        payment_pago_movil: payment_pago_movil || {"banco": "", "rif": "", "telefono": "", "nombre_titular": "", "enabled": false},
        commerce_settings: commerce_settings || {"catalog_id": "", "currency": "USD", "delivery_fee": 0.00, "min_order_value": 0.00}
      }, { onConflict: 'inbox_id' });

    if (botError) {
      console.error('[API] Error al aprovisionar clientes_bot:', botError.message);
    }

    // 4. Invalidar la caché de configuración en Redis para aplicar los cambios al instante
    const configCacheKey = `inbox:${inbox_id}:config`;
    try {
      await redisClient.del(configCacheKey);
    } catch (err) {
      console.warn(`[Redis] Error al invalidar caché tras crear cliente:`, err.message);
    }

    res.json({ message: 'Cliente guardado exitosamente', client: data[0] });
  } catch (error) {
    console.error('Error saving client:', error);
    res.status(500).json({ error: error.message });
  }
});

// Actualizar un cliente existente
app.put('/api/crm/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      inbox_id, company_name, business_nature, whatsapp_number, 
      facebook_page_id, instagram_account_id, page_access_token, 
      subscription_plan, balance_due, status,
      bot_module_type, is_delivery_enabled, address_details, 
      payment_pago_movil, commerce_settings
    } = req.body;
    
    if (!inbox_id || !company_name) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const db = pgPool;
    if (!db) {
      return res.status(500).json({ error: 'No hay conexión a base de datos (pgPool no inicializado)' });
    }

    // 1. Obtener inbox_id actual para detectar si cambió
    const { rows: currentRows } = await db.query(
      'SELECT inbox_id FROM meta_saas.saas_clients WHERE id = $1',
      [id]
    );
    if (currentRows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const oldInboxId = currentRows[0].inbox_id;

    // 2. Actualizar meta_saas.saas_clients
    const { rows: updatedRows } = await db.query(
      `UPDATE meta_saas.saas_clients
       SET inbox_id = $1, company_name = $2, business_nature = $3,
           whatsapp_number = $4, facebook_page_id = $5, instagram_account_id = $6,
           page_access_token = $7, subscription_plan = $8, balance_due = $9, status = $10
       WHERE id = $11
       RETURNING *`,
      [
        inbox_id.toString(), company_name, business_nature,
        whatsapp_number, facebook_page_id, instagram_account_id,
        page_access_token,
        subscription_plan || 'Basic', balance_due || 0, status || 'Active',
        id
      ]
    );

    // 3. Si cambió el inbox_id, actualizar tablas relacionadas
    if (oldInboxId && oldInboxId !== inbox_id.toString()) {
      await db.query(
        'UPDATE botwaba.clientes_bot SET inbox_id = $1 WHERE inbox_id = $2',
        [inbox_id.toString(), oldInboxId]
      );
      await db.query(
        'UPDATE botwaba.company_knowledge SET inbox_id = $1 WHERE inbox_id = $2',
        [inbox_id.toString(), oldInboxId]
      );
    }

    // 4. Consultar config existente de clientes_bot (para no pisar system_prompt, etc.)
    const { rows: botRows } = await db.query(
      'SELECT system_prompt, chatwoot_token, chatwoot_url, ai_model FROM botwaba.clientes_bot WHERE inbox_id = $1',
      [inbox_id.toString()]
    );
    const existingBot = botRows[0] || null;

    // 5. Upsert en botwaba.clientes_bot
    await db.query(
      `INSERT INTO botwaba.clientes_bot
         (inbox_id, chatwoot_token, chatwoot_url, ai_model, system_prompt,
          bot_module_type, is_delivery_enabled, address_details, payment_pago_movil, commerce_settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (inbox_id) DO UPDATE SET
         bot_module_type      = EXCLUDED.bot_module_type,
         is_delivery_enabled  = EXCLUDED.is_delivery_enabled,
         address_details      = EXCLUDED.address_details,
         payment_pago_movil   = EXCLUDED.payment_pago_movil,
         commerce_settings    = EXCLUDED.commerce_settings`,
      [
        inbox_id.toString(),
        existingBot?.chatwoot_token || page_access_token || 'temp_token',
        existingBot?.chatwoot_url   || 'https://soporte.mbtech.work',
        existingBot?.ai_model       || 'openai/gpt-4o-mini',
        existingBot?.system_prompt  || `Eres el asistente de ventas oficial de la empresa "${company_name}", cuya naturaleza de negocio es: ${business_nature || 'Soporte'}.`,
        bot_module_type || 'basic_qa',
        is_delivery_enabled === true || is_delivery_enabled === 'true',
        JSON.stringify(address_details      || { street: '', city: '', pickup_instructions: '' }),
        JSON.stringify(payment_pago_movil   || { banco: '', rif: '', telefono: '', nombre_titular: '', enabled: false }),
        JSON.stringify(commerce_settings    || { catalog_id: '', currency: 'USD', delivery_fee: 0.00, min_order_value: 0.00 })
      ]
    );

    // 6. Invalidar cache de Redis
    const configCacheKey = `inbox:${inbox_id}:config`;
    try {
      await redisClient.del(configCacheKey);
      if (oldInboxId && oldInboxId !== inbox_id.toString()) {
        await redisClient.del(`inbox:${oldInboxId}:config`);
      }
    } catch (err) {
      console.warn(`[Redis] Error al invalidar caché tras actualizar cliente:`, err.message);
    }

    res.json({ message: 'Cliente actualizado exitosamente', client: updatedRows[0] });
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: error.message });
  }
});


// Obtener WABAs desde Supabase (Para el dropdown de Nuevo Cliente)
app.get('/api/crm/wabas', async (req, res) => {
  try {
    const { data, error } = await supabaseMeta.from('wabas').select('id, name');
    if (error) throw error;
    
    // Devolvemos el mismo formato que esperaba el frontend para minimizar cambios
    const inboxes = data.map(waba => ({
      id: waba.id,
      name: waba.name || `WABA ID: ${waba.id}`,
      phone_number: '',
      channel_type: 'Channel::Api'
    }));

    res.json({ inboxes });
  } catch (error) {
    console.error('Error fetching WABAs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🤖 BotWaba Bridge (SaaS CRM <-> OpenRouter) iniciado en el puerto ${PORT}`);
  console.log(`========================================\n`);
});
