const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres' });
(async () => {
  await client.connect();
  const res = await client.query("SELECT * FROM botwaba.clientes_bot WHERE inbox_id = '1213848621804009';");
  console.log('CLIENTES_BOT:', JSON.stringify(res.rows, null, 2));
  const conv = await client.query("SELECT id, status, bot_enabled, metadata FROM meta_saas.conversations WHERE id = '30dd9600-a9a3-4d87-a8b8-b0ec86ff32b5';");
  console.log('CONVERSATION:', JSON.stringify(conv.rows, null, 2));
  const saasClient = await client.query("SELECT inbox_id, status FROM meta_saas.saas_clients WHERE inbox_id = '1213848621804009';");
  console.log('SAAS_CLIENT:', JSON.stringify(saasClient.rows, null, 2));
  await client.end();
})();
