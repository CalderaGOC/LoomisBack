const { Pool } = require('pg');

const pool = new Pool({
  user: 'lmuser',
  host: 'localhost',
  database: 'loomis',
  password: 'loomispwd',
  port: 5432,
});

module.exports = pool;
