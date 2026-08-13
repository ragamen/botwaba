async function test() {
  const token = 'EAAYfIFhdpxoBRZCTZCT7xtaUhYeImDZBwlSxTsLg3zEPZBKt9PgMS63QcRJGaIIcPpIkVYjmJRLb7s3ZC5VWiCdwgNrcmxMWiW7nn5usCRySBBoaLEXlTMcguQCFQOppWK4hBajnCAUncT3YRRRGebg0qDeKVq44orAzfFFzXZCtN3McfNXjWi5HeF2ieHzz41wAZDZD';
  const phoneNumberId = '1213848621804009';

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/whatsapp_commerce_settings?access_token=${token}`;
  console.log('Fetching WhatsApp Commerce Settings...');
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log('Commerce Settings Result:', JSON.stringify(data, null, 2));
  } catch(e) {
    console.error('Error:', e.message);
  }
}
test();
