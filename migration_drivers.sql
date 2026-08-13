-- Agregar columna driver_phones a commerce_businesses para registrar motorizados
ALTER TABLE botwaba.commerce_businesses ADD COLUMN IF NOT EXISTS driver_phones JSONB DEFAULT '[]';
