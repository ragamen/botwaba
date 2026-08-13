const { Pool } = require('pg');
const pool = new Pool({ 
  connectionString: 'postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres' 
});

pool.query("SELECT id, catalog_id, title, availability, category FROM meta_saas.catalog_products WHERE catalog_id = '1199850446786643'")
  .then(res => {
    console.log(res.rows);
    pool.end();
  })
  .catch(err => {
    console.error(err);
    pool.end();
  });
