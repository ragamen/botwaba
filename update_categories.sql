-- Normalizar y completar categorías vacías en catalog_products en base al prefijo del retailer_id
UPDATE meta_saas.catalog_products 
SET category = 'Refresco' 
WHERE retailer_id LIKE 'refresco-%' AND (category IS NULL OR category = '');

UPDATE meta_saas.catalog_products 
SET category = 'Extra' 
WHERE retailer_id LIKE 'extra-%' AND (category IS NULL OR category = '');

UPDATE meta_saas.catalog_products 
SET category = 'Pizza' 
WHERE retailer_id LIKE 'pizza-%' AND (category IS NULL OR category = '');
