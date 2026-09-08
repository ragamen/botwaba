const { Client } = require('pg');
const client = new Client('postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres');
client.connect().then(() => {
    return client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'botwaba' AND table_name = 'pedidos'");
}).then(res => {
    console.table(res.rows);
    return client.end();
}).catch(console.error);
