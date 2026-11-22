'use strict';
const config = require('../src/config');
const db = require('../src/db');

(async () => {
  await require('./pg-local').ensureLocal();
  await db.open();
  const v = (await db.one('SELECT MAX(version) v FROM schema_migrations')).v;
  const u = new URL(config.db.url);
  console.log(`Banco ${u.pathname.slice(1)} em ${u.host} migrado até a versão ${v} (${db.migrationsCount} migração(ões) disponíveis).`);
  await db.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
