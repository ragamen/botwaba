require('dotenv').config();
const { Pool } = require('pg');

const postgresUrl = process.env.POSTGRES_URL;

async function migrate() {
  const pool = new Pool({
    connectionString: postgresUrl
  });

  try {
    console.log("Migrando meta_saas.saas_clients...");
    await pool.query(`ALTER TABLE meta_saas.saas_clients ADD COLUMN IF NOT EXISTS business_nature VARCHAR(255);`);
    console.log("Columna business_nature agregada a meta_saas.saas_clients.");

    await pool.query(`ALTER TABLE meta_saas.saas_clients ADD COLUMN IF NOT EXISTS onboarding_questions TEXT;`);
    await pool.query(`ALTER TABLE meta_saas.saas_clients ADD COLUMN IF NOT EXISTS onboarding_answers TEXT;`);
    console.log("Columnas onboarding agregadas a meta_saas.saas_clients.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_saas.saas_tenants (
        user_email VARCHAR(255) PRIMARY KEY,
        company_name VARCHAR(255) NOT NULL,
        max_phones INTEGER DEFAULT 1,
        base_price NUMERIC DEFAULT 0.0,
        extra_phone_price NUMERIC DEFAULT 0.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Tabla meta_saas.saas_tenants verificada/creada.");

  } catch (e) {
    console.error("Error migrating:", e);
  } finally {
    await pool.end();
  }
}

migrate();
