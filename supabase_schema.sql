-- Crear la tabla clientes_bot en el esquema public
CREATE TABLE IF NOT EXISTS botwaba.clientes_bot (
  inbox_id text PRIMARY KEY,
  chatwoot_token text NOT NULL,
  chatwoot_url text NOT NULL,
  ai_model text,
  system_prompt text,
  ultimo_error_bot text,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Habilitar seguridad de nivel de fila (RLS) si es necesario en el futuro
ALTER TABLE botwaba.clientes_bot ENABLE ROW LEVEL SECURITY;

-- Crear una política por defecto para permitir acceso a todo (si se usa server-side)
-- Ya que usamos el ANON_KEY o SERVICE_KEY en nuestro backend, podemos definir una política de lectura/escritura sencilla
CREATE POLICY "Permitir todo a roles autenticados/servicio"
ON botwaba.clientes_bot
FOR ALL
USING (true);

-- Agregar comentarios descriptivos
COMMENT ON TABLE botwaba.clientes_bot IS 'Configuración de los bots de IA para cada cliente/bandeja en Chatwoot';
COMMENT ON COLUMN botwaba.clientes_bot.inbox_id IS 'ID del Inbox en Chatwoot (Llave maestra)';
COMMENT ON COLUMN botwaba.clientes_bot.chatwoot_token IS 'Token del Agente Bot de Chatwoot';
COMMENT ON COLUMN botwaba.clientes_bot.chatwoot_url IS 'URL base de la instancia de Chatwoot';
COMMENT ON COLUMN botwaba.clientes_bot.ai_model IS 'Modelo de OpenRouter (ej. openai/gpt-4o-mini). Puede ser nulo.';
COMMENT ON COLUMN botwaba.clientes_bot.system_prompt IS 'El prompt del sistema (personalidad) de este bot.';
COMMENT ON COLUMN botwaba.clientes_bot.ultimo_error_bot IS 'Último error registrado para depuración rápida.';
