const SUPABASE_URL = 'https://metasupa.mbtech.work';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzU0NjA1MTE3LCJleHAiOjE3ODYxNDExMTd9.4i_y4EaOJU_x3v-NJb5mdWxqFnjH4dyQZ3xVT_8qdeY';

async function updateRecords(table, oldId, newId) {
  const url = SUPABASE_URL + '/rest/v1/' + table + '?inbox_id=eq.' + oldId;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Accept-Profile': 'botwaba',
      'Content-Profile': 'botwaba',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({ inbox_id: newId })
  });
  const data = await res.json();
  console.log('Updated records in ' + table + ':', data.length || 0);
}

async function fix() {
  await updateRecords('company_knowledge', '1047109242354157', '1213848621804009');
  await updateRecords('company_profiles', '1047109242354157', '1213848621804009');
}
fix();
