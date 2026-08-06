const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'monthend',
  user:     process.env.DB_USER     || 'monthend',
  password: process.env.DB_PASSWORD || 'monthend',
});

module.exports = pool;
