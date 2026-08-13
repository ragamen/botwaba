-- Activar módulo commerce con catalog_id y datos de Pago Móvil
UPDATE botwaba.clientes_bot
SET 
  bot_module_type = 'commerce',
  is_delivery_enabled = true,
  commerce_settings = jsonb_build_object(
    'catalog_id', '1255972477908976',
    'currency', 'USD',
    'delivery_fee', 2.00,
    'min_order_value', 5.00
  )
WHERE inbox_id = '1213848621804009';

-- Verificar el resultado
SELECT inbox_id, bot_module_type, is_delivery_enabled, commerce_settings
FROM botwaba.clientes_bot 
WHERE inbox_id = '1213848621804009';
