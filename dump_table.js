const { Pool } = require('pg');
const pool = new Pool({ 
  connectionString: 'postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres' 
});

pool.query("SELECT id, catalog_id, title, availability, category FROM meta_saas.catalog_products")
  .then(res => {
    console.log("Total rows:", res.rows.length);
    res.rows.forEach(r => console.log(r.catalog_id, r.title, r.availability, r.category));
    pool.end();
  })
  .catch(err => {
    console.error(err);
    pool.end();
  });
