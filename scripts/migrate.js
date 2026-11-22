'use strict';
const config = require('../src/config');
const db = require('../src/db');
db.open();
const v = db.one('SELECT MAX(version) v FROM schema_migrations').v;
console.log(`Banco ${config.dbFile} migrado até a versão ${v} (${db.migrationsCount} migração(ões) disponíveis).`);
db.close();
