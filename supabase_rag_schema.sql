-- 1. Habilitar pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Crear tabla de conocimiento
CREATE TABLE IF NOT EXISTS botwaba.company_knowledge (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  inbox_id text NOT NULL, -- Para que un mismo bot pueda servir a varias empresas (separadas por inbox)
  question text NOT NULL, -- Pregunta o narrativa
  answer text NOT NULL, -- Respuesta estandarizada
  embedding vector(1024), -- Usaremos 1024 porque es el tamaño de baai/bge-m3
  status text DEFAULT 'approved', -- 'pending', 'approved', 'rejected'
  usage_count int DEFAULT 0,
  feedback_score float DEFAULT 0.0,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Habilitar seguridad (RLS)
ALTER TABLE botwaba.company_knowledge ENABLE ROW LEVEL SECURITY;

-- 4. Permitir todo a roles anon y authenticated para facilitar uso desde la API
CREATE POLICY "Permitir todo a company_knowledge"
ON botwaba.company_knowledge
FOR ALL
USING (true);

-- 5. Crear la función RPC (Remote Procedure Call) para buscar conocimiento usando similaridad del coseno
CREATE OR REPLACE FUNCTION match_knowledge (
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  p_inbox_id text
)
RETURNS TABLE (
  id uuid,
  question text,
  answer text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    company_knowledge.id,
    company_knowledge.question,
    company_knowledge.answer,
    1 - (company_knowledge.embedding <=> query_embedding) AS similarity
  FROM company_knowledge
  WHERE 
    company_knowledge.inbox_id = p_inbox_id
    AND company_knowledge.status = 'approved'
    AND 1 - (company_knowledge.embedding <=> query_embedding) > match_threshold
  ORDER BY company_knowledge.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ======================================================================
-- ONBOARDING RAG GLOBAL (INTELIGENCIA COLECTIVA)
-- ======================================================================

-- 6. Crear tabla global de plantillas de negocios
CREATE TABLE IF NOT EXISTS botwaba.global_business_templates (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  category_name text NOT NULL, -- Ej: "Consultoría de Software", "Restaurante"
  essential_questions text NOT NULL, -- JSON o texto con las preguntas ineludibles
  embedding vector(1024), -- Vector de la categoría para búsqueda por similitud
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Habilitar seguridad (RLS) para la tabla global
ALTER TABLE botwaba.global_business_templates ENABLE ROW LEVEL SECURITY;

-- 8. Permitir lectura a todos (el bot necesita leer las plantillas)
CREATE POLICY "Permitir lectura a global_business_templates"
ON botwaba.global_business_templates
FOR SELECT
USING (true);

-- Permitir inserción/actualización (útil si el script semilla o el panel actualizan)
CREATE POLICY "Permitir todo a global_business_templates"
ON botwaba.global_business_templates
FOR ALL
USING (true);

-- 9. Crear la función RPC para buscar plantillas globales
CREATE OR REPLACE FUNCTION match_global_template (
  query_embedding vector(1024),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  category_name text,
  essential_questions text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    global_business_templates.id,
    global_business_templates.category_name,
    global_business_templates.essential_questions,
    1 - (global_business_templates.embedding <=> query_embedding) AS similarity
  FROM global_business_templates
  WHERE 1 - (global_business_templates.embedding <=> query_embedding) > match_threshold
  ORDER BY global_business_templates.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ======================================================================
-- MODO EDICIÓN Y ALMACENAMIENTO DE MANUAL MAESTRO
-- ======================================================================

-- 10. Crear tabla para guardar el perfil y manual completo de la empresa
CREATE TABLE IF NOT EXISTS botwaba.company_profiles (
  inbox_id text PRIMARY KEY,
  master_manual text NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 11. Habilitar seguridad (RLS)
ALTER TABLE botwaba.company_profiles ENABLE ROW LEVEL SECURITY;

-- 12. Permitir todo a roles anon y authenticated para la API
CREATE POLICY "Permitir todo a company_profiles"
ON botwaba.company_profiles
FOR ALL
$$;

-- ======================================================================
-- DASHBOARD CRM (MANEJADOR DE CLIENTES)
-- ======================================================================

-- 13. Crear tabla para los clientes del SaaS
CREATE TABLE IF NOT EXISTS meta_saas.saas_clients (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  inbox_id text UNIQUE NOT NULL, -- El ID de Chatwoot
  company_name text NOT NULL,
  whatsapp_number text,
  subscription_plan text DEFAULT 'Basic',
  balance_due numeric(10, 2) DEFAULT 0.00,
  status text DEFAULT 'Active',
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 14. Habilitar seguridad (RLS)
ALTER TABLE meta_saas.saas_clients ENABLE ROW LEVEL SECURITY;

-- 15. Permitir lectura/escritura a la API
CREATE POLICY "Permitir todo a saas_clients"
ON meta_saas.saas_clients
FOR ALL
USING (true);
