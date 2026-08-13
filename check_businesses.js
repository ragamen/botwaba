const { Pool } = require('pg');
const pool = new Pool({ 
  connectionString: 'postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres' 
});

pool.query("SELECT id, business_name, catalog_id, is_active FROM botwaba.commerce_businesses")
  .then(res => {
    console.log(res.rows);
    pool.end();
  })
  .catch(err => {
    console.error(err);
    pool.end();
  });
