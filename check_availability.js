const { Pool } = require('pg');
const pool = new Pool({ 
  connectionString: 'postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres' 
});

pool.query("SELECT catalog_id, title, availability FROM meta_saas.catalog_products")
  .then(res => {
    console.log(res.rows);
    pool.end();
  })
  .catch(err => {
    console.error(err);
    pool.end();
  });
