const { Client } = require('pg');
const c = new Client('postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres');
c.connect().then(() => c.query("SELECT company_name, is_active_demo FROM meta_saas.saas_clients WHERE whatsapp_number = '+584265708509'")).then(res => { console.table(res.rows); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
