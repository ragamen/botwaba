-- Clonar los 15 productos del catálogo viejo (1255972477908976) al catálogo nuevo y activo (1199850446786643)
INSERT INTO meta_saas.catalog_products (
  catalog_id, user_id, retailer_id, title, description, price, currency,
  image_url, availability, condition, brand, category, synced_to_meta
)
SELECT 
  '1199850446786643', user_id, retailer_id, title, description, price, currency,
  image_url, availability, condition, brand, category, synced_to_meta
FROM meta_saas.catalog_products
WHERE catalog_id = '1255972477908976'
ON CONFLICT (catalog_id, retailer_id) DO NOTHING;
