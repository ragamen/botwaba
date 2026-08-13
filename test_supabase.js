require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
global.WebSocket = require('ws');
const supabaseMeta = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema: 'meta_saas' } });
async function test() {
  const { data, error } = await supabaseMeta.from('messages').insert({
    conversation_id: 1, 
    direction: 'outbound',
    content: 'test',
    message_id: 'test_' + Date.now(),
    sender_name: 'test',
    timestamp: Math.floor(Date.now() / 1000)
  });
  console.log("Error:", error);
  console.log("Data:", data);
}
test();
