const SUPABASE_URL = 'https://metasupa.mbtech.work';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzU0NjA1MTE3LCJleHAiOjE3ODYxNDExMTd9.4i_y4EaOJU_x3v-NJb5mdWxqFnjH4dyQZ3xVT_8qdeY';

async function check() {
  const url = SUPABASE_URL + '/rest/v1/company_knowledge?select=inbox_id';
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Accept-Profile': 'botwaba', 'Content-Profile': 'botwaba' }});
  const data = await res.json();
  const ids = new Set(data.map(d => d.inbox_id));
  console.log('Unique inbox_ids in company_knowledge:', [...ids]);
}
check();
