const { Client } = require('pg');
const client = new Client('postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres');
client.connect().then(() => {
  client.query("SELECT * FROM meta_saas.pages WHERE page_id = '2304725433694475' OR instagram_business_account_id = '2304725433694475'")
    .then(res => {
      console.log(res.rows);
      process.exit(0);
    });
});
