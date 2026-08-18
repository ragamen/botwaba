const fs = require('fs');

const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg3MDIwMjkwLCJleHAiOjIxMDIzODAyOTB9.CMzHff3i6QbgYX4HsRYw_7qECv3tRf0YAsZXo11VTio';
const SRK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3ODcwMjAyOTAsImV4cCI6MjEwMjM4MDI5MH0.f11kQyMNeZRH9ADoZ8UYxI-Ez-IY04ZvgUwYl75rGsA';

function updateEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  
  if (content.includes('SUPABASE_ANON_KEY=')) {
    content = content.replace(/^SUPABASE_ANON_KEY=.*$/m, `SUPABASE_ANON_KEY=${ANON}`);
  } else {
    content += `\nSUPABASE_ANON_KEY=${ANON}`;
  }

  if (content.includes('SUPABASE_KEY=')) {
    content = content.replace(/^SUPABASE_KEY=.*$/m, `SUPABASE_KEY=${ANON}`);
  } else {
    content += `\nSUPABASE_KEY=${ANON}`;
  }

  if (content.includes('SUPABASE_SERVICE_ROLE_KEY=')) {
    content = content.replace(/^SUPABASE_SERVICE_ROLE_KEY=.*$/m, `SUPABASE_SERVICE_ROLE_KEY=${SRK}`);
  } else {
    content += `\nSUPABASE_SERVICE_ROLE_KEY=${SRK}`;
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${filePath}`);
}

updateEnv('/root/crm-saas/.env.local');
updateEnv('/root/botwaba/.env');
console.log('SUCCESS');
