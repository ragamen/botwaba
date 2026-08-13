-- Registrar el teléfono de prueba 584245913370 como motorizado de Pizzeria mbtech
UPDATE botwaba.commerce_businesses 
SET driver_phones = '["584245913370"]'::jsonb 
WHERE business_name ILIKE '%pizzeria%';
