'use strict';
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { expireStale } = require('./lib/events');

(async () => {
// Desenvolvimento sem DATABASE_URL: sobe o PostgreSQL local automaticamente
await require('../scripts/pg-local').ensureLocal();
const app = await createApp();
// Libera reservas vencidas periodicamente (também ocorre sob demanda em cada reserva)
setInterval(async () => { try { await db.tx(async () => await expireStale()); } catch (e) { console.error('expiração', e.message); } }, 60000).unref();
const delivery = require('./lib/delivery');
setInterval(() => { delivery.processQueue().catch(() => {}); }, 20000).unref();
// Recarrega as integrações salvas (útil com mais de uma instância do app)
setInterval(() => { require('./lib/integrations').load().catch((e) => console.error('integrações', e.message)); }, 60000).unref();
app.listen(config.port, config.host, () => console.log(`Plataforma em ${config.baseUrl} (escutando em ${config.host}:${config.port}) (ambiente: ${config.env}, pagamentos: ${config.mp.mode})`));
})().catch((e) => { console.error(e); process.exit(1); });
