'use strict';
// Serviços transversais: senha, tokens, e-mail (caixa de saída), auditoria, termos.
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const { randomToken, json } = require('./util');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(h, 'base64');
  return exp.length === calc.length && crypto.timingSafeEqual(calc, exp);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function issueToken(userId, type, minutes) {
  const t = randomToken(32);
  db.run('INSERT INTO tokens(token_hash,user_id,type,expires_at) VALUES(?,?,?,?)', sha256(t), userId, type, new Date(Date.now() + minutes * 60000).toISOString());
  return t;
}
function consumeToken(t, type) {
  const row = db.one('SELECT * FROM tokens WHERE token_hash=? AND type=?', sha256(t), type);
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) return null;
  db.run('UPDATE tokens SET used_at=? WHERE token_hash=?', new Date().toISOString(), row.token_hash);
  return row.user_id;
}

/**
 * E-mail: nesta versão as mensagens vão para a caixa de saída (tabela outbox),
 * visível em /dev/caixa-de-saida fora de produção. Envio SMTP real: configuração externa pendente.
 * category 'marketing' respeita o consentimento; transacionais sempre são registradas.
 */
function sendMail(to, subject, body, category = 'transactional') {
  if (category === 'marketing') {
    const u = db.one('SELECT marketing_opt_in FROM users WHERE email=?', to);
    if (!u || !u.marketing_opt_in) return false;
  }
  if (category !== 'transactional' && category !== 'marketing') {
    const u = db.one('SELECT notify_prefs FROM users WHERE email=?', to);
    const prefs = json(u?.notify_prefs, {});
    if (prefs[category] === false) return false;
  }
  db.run('INSERT INTO outbox(to_email,subject,body,category) VALUES(?,?,?,?)', to, subject, body, category);
  if (!config.isTest) console.log(`[e-mail:${category}] para=${to} assunto="${subject}"`);
  return true;
}

function audit(req, action, { entity, entityId, orgId, detail, userId } = {}) {
  db.run('INSERT INTO audit_log(user_id,org_id,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)',
    userId ?? req?.user?.id ?? null, orgId ?? null, action, entity ?? null, entityId != null ? String(entityId) : null,
    detail ? JSON.stringify(detail) : null, req?.ip ?? null);
}

// Documentos legais versionados. Os textos são modelos de demonstração e precisam de revisão jurídica.
const LEGAL = {
  terms: { title: 'Termos de Uso', version: '2026-11-01' },
  privacy: { title: 'Política de Privacidade', version: '2026-11-01' },
  organizer: { title: 'Termos do Organizador', version: '2026-11-01' },
};
function recordConsent(req, userId, key, context) {
  const doc = LEGAL[key];
  db.run('INSERT INTO consents(user_id,doc_key,version,context,ip) VALUES(?,?,?,?,?)', userId, key, doc ? doc.version : String(context), context || null, req?.ip ?? null);
}
function hasConsent(userId, key) {
  return !!db.one('SELECT 1 FROM consents WHERE user_id=? AND doc_key=? AND version=?', userId, key, LEGAL[key].version);
}

const DEFAULT_SETTINGS = {
  platform_fee_percent: 0, // definido pela administração; nenhum valor comercial é presumido
  default_fee_payer: 'athlete',
  reservation_minutes: 15,
  publish_requires_active: true, // publicar exige organizador "ativo" (verificado)
  require_identity_document: true,
  free_events_fee_percent: 0,
  commercial_conditions: 'Condições comerciais a definir pela administração da plataforma.',
};
function settings() { const out = {}; for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) out[k] = db.setting(k, v); return out; }

module.exports = { hashPassword, verifyPassword, sha256, issueToken, consumeToken, sendMail, audit, LEGAL, recordConsent, hasConsent, settings, DEFAULT_SETTINGS };
