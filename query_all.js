const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres', options: '-c search_path=botwaba,public' });
pool.query('SELECT inbox_id, system_prompt FROM clientes_bot')
  .then(res => { 
      console.log(res.rows); 
      pool.end(); 
  })
  .catch(err => {
      console.error(err);
      pool.end();
  });
