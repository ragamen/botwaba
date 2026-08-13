-- Crear tabla de tokens de acceso rápido para la PWA de Pedidos
CREATE TABLE IF NOT EXISTS botwaba.pwa_tokens (
  token           VARCHAR(100) PRIMARY KEY,
  inbox_id        VARCHAR(50) NOT NULL,
  business_id     INTEGER DEFAULT NULL,
  role            VARCHAR(20) NOT NULL, -- 'kitchen', 'delivery', 'admin'
  expires_at      TIMESTAMP NOT NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Asegurar que la tabla de pedidos tiene la columna business_id
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='botwaba' AND table_name='pedidos' AND column_name='business_id') THEN
    ALTER TABLE botwaba.pedidos ADD COLUMN business_id INTEGER DEFAULT NULL;
  END IF;
END $$;
