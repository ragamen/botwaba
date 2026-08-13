const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres', options: '-c search_path=botwaba,public' });
pool.query('SELECT inbox_id, ai_model, system_prompt FROM clientes_bot LIMIT 1')
  .then(res => { 
      console.log('--- SYSTEM PROMPT ---'); 
      console.log(res.rows[0]); 
      if(res.rows.length === 0) return null;
      return res.rows[0].inbox_id; 
  })
  .then(inboxId => {
      if(!inboxId) return;
      return pool.query('SELECT question, answer FROM company_knowledge WHERE inbox_id = $1 LIMIT 10', [inboxId.toString()]);
  })
  .then(res => { 
      if(res) {
          console.log('--- KNOWLEDGE ---'); 
          console.log(res.rows); 
      }
      pool.end(); 
  })
  .catch(err => {
      console.error(err);
      pool.end();
  });
