'use strict';
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { expireStale } = require('./lib/events');

const app = createApp();
// Libera reservas vencidas periodicamente (também ocorre sob demanda em cada reserva)
setInterval(() => { try { db.tx(() => expireStale()); } catch (e) { console.error('expiração', e.message); } }, 60000).unref();
app.listen(config.port, () => console.log(`Plataforma em ${config.baseUrl} (ambiente: ${config.env}, pagamentos: ${config.mp.mode})`));
