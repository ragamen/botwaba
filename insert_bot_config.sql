INSERT INTO botwaba.clientes_bot (inbox_id, chatwoot_token, chatwoot_url, ai_model, system_prompt)
SELECT '2109313352968146', chatwoot_token, chatwoot_url, ai_model, system_prompt
FROM botwaba.clientes_bot WHERE inbox_id = '2'
ON CONFLICT (inbox_id) DO NOTHING;
