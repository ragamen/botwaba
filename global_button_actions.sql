-- ============================================================
-- Motor de acciones data-driven para botones de plantilla
-- El botón (texto/ID) vive en Meta y es inmutable sin re-revisión;
-- la acción vinculada vive aquí y es editable libre, sin pasar por Meta.
-- Vínculo por match_key = lo que Meta devuelve al tocar el botón.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_saas.global_button_actions (
  id          SERIAL PRIMARY KEY,
  tenant_id   TEXT NULL,                       -- NULL = acción global/default; waba_id = override por inquilino
  match_type  TEXT NOT NULL CHECK (match_type IN ('button_text','button_reply_id','list_reply_id','postback_payload')),
  match_key   TEXT NOT NULL,                   -- texto o ID que Meta devuelve al tapping el botón
  name        TEXT NOT NULL,
  actions     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- cadena de pasos: [{type, ...}]
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup rápido: el motor consulta por (match_type, match_key) WHERE enabled.
CREATE INDEX IF NOT EXISTS gba_lookup_idx
  ON meta_saas.global_button_actions (match_type, match_key)
  WHERE enabled;

-- Seed: migra el hack hardcoded "Ver demostración" de aiService.js a la tabla.
INSERT INTO meta_saas.global_button_actions (match_type, match_key, name, actions, description)
VALUES (
  'button_text',
  'Ver demostración',
  'Demo IA',
  '[{"type":"ai_reply","system_prompt":"El cliente tocó el botón “Ver demostración” en una plantilla de marketing. Quiere ver una demostración detallada de los bots de IA de la empresa. Responde de forma entusiasta, breve y natural: explica qué pueden hacer los bots de IA y propón agendar una demo en vivo o pide sus datos de contacto para derivarlo a ventas.","user_message":"Hola, me interesa ver una demostración detallada de los bots de IA de la empresa."}]'::jsonb,
  'Botón Ver demostración — plantilla promocion (migración del hack en aiService.js)'
)
ON CONFLICT DO NOTHING;