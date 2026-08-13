require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const openRouterApiKey = process.env.OPENROUTER_API_KEY;

if (!supabaseUrl || !supabaseKey || !openRouterApiKey) {
  console.error('Faltan variables de entorno en .env');
  process.exit(1);
}

const WebSocket = require('ws');

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
  db: { schema: 'botwaba' }
});

const templates = [
  {
    category_name: 'Consultoría y Servicios Profesionales',
    essential_questions: JSON.stringify([
      "¿Cuáles son los servicios específicos de consultoría que ofreces y cuál es el precio por hora o por proyecto?",
      "¿Cuál es el proceso exacto que debe seguir un cliente para agendar una sesión contigo?",
      "¿En qué horarios estás disponible para atender consultas o sesiones?",
      "¿Cuáles son los métodos de pago aceptados y cuáles son las políticas de cancelación o reembolso?",
      "¿Qué tipo de clientes o industrias son tu especialidad?"
    ])
  },
  {
    category_name: 'Restaurante y Comida Rápida',
    essential_questions: JSON.stringify([
      "¿Cuál es el menú principal, cuáles son los platos estrella y cuáles son los precios aproximados?",
      "¿Cuál es el horario de atención y los días que abren?",
      "¿Cuál es la dirección física exacta del local y tienen estacionamiento?",
      "¿Ofrecen servicio a domicilio (delivery)? Si es así, ¿cuáles son las zonas de cobertura y el costo de envío?",
      "¿Cómo es el proceso para realizar un pedido o hacer una reserva?"
    ])
  },
  {
    category_name: 'Clínica Dental y Médica',
    essential_questions: JSON.stringify([
      "¿Cuáles son los tratamientos principales que ofrecen y sus precios aproximados?",
      "¿Qué seguros médicos o dentales aceptan actualmente?",
      "¿Tienen un protocolo para emergencias como dolores agudos o sangrados?",
      "¿Cuál es el horario de atención, días de apertura y dirección física de la clínica?",
      "¿Ofrecen facilidades de pago o financiamiento para tratamientos?"
    ])
  }
];

async function getEmbedding(text) {
  const embedResponse = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'baai/bge-m3',
      input: text
    })
  });

  if (!embedResponse.ok) {
    throw new Error(`Error API Embeddings: ${await embedResponse.text()}`);
  }
  
  const embedData = await embedResponse.json();
  return embedData.data[0].embedding;
}

async function seed() {
  console.log('🌱 Iniciando inyección de Plantillas Globales...');
  
  for (const t of templates) {
    console.log(`Vectorizando categoría: ${t.category_name}...`);
    try {
      const embedding = await getEmbedding(t.category_name);
      
      const { error } = await supabase.from('global_business_templates').insert({
        category_name: t.category_name,
        essential_questions: t.essential_questions,
        embedding: embedding
      });
      
      if (error) {
        console.error(`❌ Error insertando ${t.category_name}:`, error.message);
      } else {
        console.log(`✅ Categoría '${t.category_name}' guardada exitosamente.`);
      }
    } catch (e) {
      console.error(`❌ Falló ${t.category_name}:`, e.message);
    }
  }
  
  console.log('✅ Proceso de seed terminado.');
}

seed();
