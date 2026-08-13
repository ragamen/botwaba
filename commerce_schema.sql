-- ============================================================
-- COMMERCE MODULE SCHEMA — BotWaba
-- ============================================================

-- Sesiones de compra activas por cliente
CREATE TABLE IF NOT EXISTS botwaba.commerce_sessions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbox_id        VARCHAR(50) NOT NULL,
  customer_phone  VARCHAR(30) NOT NULL,
  state           VARCHAR(30) DEFAULT 'IDLE',
  cart            JSONB DEFAULT '[]',
  current_item    JSONB DEFAULT NULL,
  delivery_type   VARCHAR(10) DEFAULT NULL,
  delivery_address TEXT DEFAULT NULL,
  order_total_usd DECIMAL(10,2) DEFAULT 0,
  bcv_rate        DECIMAL(10,4) DEFAULT 0,
  proof_media_url TEXT DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(inbox_id, customer_phone)
);

-- Pedidos finalizados
CREATE SEQUENCE IF NOT EXISTS botwaba.pedidos_order_seq START 1;

CREATE TABLE IF NOT EXISTS botwaba.pedidos (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number    VARCHAR(20) NOT NULL UNIQUE,
  inbox_id        VARCHAR(50) NOT NULL,
  customer_phone  VARCHAR(30) NOT NULL,
  items           JSONB NOT NULL DEFAULT '[]',
  subtotal_usd    DECIMAL(10,2) DEFAULT 0,
  delivery_fee_usd DECIMAL(10,2) DEFAULT 0,
  total_usd       DECIMAL(10,2) DEFAULT 0,
  total_bs        DECIMAL(14,2) DEFAULT 0,
  bcv_rate        DECIMAL(10,4) DEFAULT 0,
  delivery_type   VARCHAR(10) DEFAULT 'pickup',
  delivery_address TEXT DEFAULT NULL,
  payment_info    JSONB DEFAULT '{}',
  proof_media_url TEXT DEFAULT NULL,
  status          VARCHAR(20) DEFAULT 'pending',
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_sessions_inbox ON botwaba.commerce_sessions(inbox_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_inbox ON botwaba.pedidos(inbox_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON botwaba.pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_phone ON botwaba.pedidos(customer_phone);
