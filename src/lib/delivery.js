'use strict';
/**
 * Entrega de mensagens: e-mail (SMTP) e SMS/WhatsApp (Twilio).
 *
 * As mensagens são gravadas primeiro (outbox / message_log) e enviadas por uma fila:
 * - "kick()" agenda o envio logo após a requisição, fora da transação em andamento;
 * - o servidor também processa a fila periodicamente e tenta de novo (até 5 vezes) em caso de falha;
 * - várias instâncias podem processar a mesma fila: cada linha é reservada com FOR UPDATE SKIP LOCKED.
 * Sem provedor configurado, e-mails ficam com situação "local" (registrados, não enviados).
 */
const nodemailer = require('nodemailer');
const db = require('../db');
const config = require('../config');

const MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------- E-mail
let transport = null; let transportKey = '';
function smtp() {
  const m = config.mail;
  const key = JSON.stringify([m.smtpHost, m.smtpPort, m.smtpSecure, m.smtpUser, m.smtpPass]);
  if (transport && key === transportKey) return transport;
  transport = nodemailer.createTransport({
    host: m.smtpHost, port: m.smtpPort || 587,
    secure: m.smtpSecure === 'tls', requireTLS: m.smtpSecure === 'starttls', ignoreTLS: m.smtpSecure === 'none',
    auth: m.smtpUser ? { user: m.smtpUser, pass: m.smtpPass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  transportKey = key;
  return transport;
}
async function sendSmtp({ to, subject, text }) {
  const info = await smtp().sendMail({ from: config.mail.from, to, subject, text });
  return info.messageId || null;
}

// ---------------------------------------------------------------- SMS / WhatsApp
/** Normaliza telefone brasileiro para E.164 (+55DDNNNNNNNNN). Retorna null se inválido. */
function toE164(phone) {
  const raw = String(phone || '').trim();
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return d.length >= 10 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return `+${d}`;
  return null;
}
async function sendTwilio({ channel, to, body }) {
  const m = config.messaging;
  const from = channel === 'whatsapp' ? m.whatsappFrom : m.smsFrom;
  if (!from) throw new Error(`Número de envio de ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} não configurado.`);
  const pre = channel === 'whatsapp' ? 'whatsapp:' : '';
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(m.twilioSid)}/Messages.json`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Basic ' + Buffer.from(`${m.twilioSid}:${m.twilioToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: pre + to, From: pre + (toE164(from) || from), Body: body.slice(0, 1500) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${j.message || 'erro'}`);
  return j.sid || null;
}

// ---------------------------------------------------------------- Fila
let running = false;
const STALE_MS = 10 * 60000; // reserva "enviando" mais velha que isso é considerada abandonada (processo caiu)
async function processQueue() {
  if (running) return; running = true;
  const now = new Date().toISOString(); const stale = new Date(Date.now() - STALE_MS).toISOString();
  try {
    // Reservas abandonadas voltam para a fila (ou viram "falhou" se esgotaram as tentativas)
    await db.run(`UPDATE outbox SET status=CASE WHEN attempts >= ? THEN 'failed' ELSE 'retry' END, error=COALESCE(error,'envio interrompido') WHERE status='sending' AND (claimed_at IS NULL OR claimed_at < ?)`, MAX_ATTEMPTS, stale);
    await db.run(`UPDATE message_log SET status=CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END WHERE status='sending' AND (claimed_at IS NULL OR claimed_at < ?)`, MAX_ATTEMPTS, stale);
    if (config.mail.mode === 'smtp') {
      const rows = await db.all(`UPDATE outbox SET status='sending', attempts=attempts+1, claimed_at=? WHERE id IN (
        SELECT id FROM outbox WHERE status IN ('queued','retry') AND attempts < ? ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`, now, MAX_ATTEMPTS);
      for (const r of rows) {
        try { await sendSmtp({ to: r.to_email, subject: r.subject, text: r.body }); await db.run("UPDATE outbox SET status='sent', sent_at=?, error=NULL WHERE id=?", new Date().toISOString(), r.id); }
        catch (e) { await db.run('UPDATE outbox SET status=?, error=? WHERE id=?', r.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', String(e.message).slice(0, 300), r.id); }
      }
    }
    if (config.messaging.mode === 'twilio') {
      // Consentimento conferido de novo na hora do envio: quem desautorizou não recebe
      await db.run(`UPDATE message_log m SET status='cancelled', error='autorização retirada' FROM users u
        WHERE u.id=m.user_id AND m.status='queued' AND COALESCE((u.notify_prefs::jsonb ->> m.channel), 'false') <> 'true'`);
      const rows = await db.all(`UPDATE message_log SET status='sending', attempts=attempts+1, claimed_at=? WHERE id IN (
        SELECT id FROM message_log WHERE status='queued' AND attempts < ? ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`, now, MAX_ATTEMPTS);
      for (const r of rows) {
        try { const sid = await sendTwilio({ channel: r.channel, to: r.to_phone, body: r.body }); await db.run("UPDATE message_log SET status='sent', provider_id=?, sent_at=?, error=NULL WHERE id=?", sid, new Date().toISOString(), r.id); }
        catch (e) { await db.run('UPDATE message_log SET status=?, error=? WHERE id=?', r.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', String(e.message).slice(0, 300), r.id); }
      }
    }
  } catch (e) {
    console.error('[envio] falha ao processar a fila', e.message);
  } finally { running = false; }
}
/** Agenda o processamento da fila para logo após a requisição (fora de transação). */
function kick() {
  if (config.isTest && !process.env.DELIVERY_IN_TESTS) return;
  // Duas tentativas: a mensagem pode ter sido gravada dentro de uma transação ainda não confirmada
  db.detached(() => { for (const ms of [400, 3000]) setTimeout(() => { processQueue().catch(() => {}); }, ms).unref(); });
}

/** Registra SMS/WhatsApp para um usuário, respeitando a autorização dele. Retorna quantos canais foram enfileirados. */
async function queueUserMessage(userId, text, { category = 'transactional' } = {}) {
  if (config.messaging.mode !== 'twilio') return 0;
  const u = await db.one('SELECT phone, notify_prefs FROM users WHERE id=?', userId);
  const to = toE164(u?.phone);
  if (!to) return 0;
  let prefs = {}; try { prefs = JSON.parse(u.notify_prefs || '{}'); } catch { /* preferências inválidas: nada é enviado */ }
  let n = 0;
  for (const channel of ['whatsapp', 'sms']) {
    if (prefs[channel] !== true) continue; // opt-in explícito
    await db.run('INSERT INTO message_log(user_id,channel,to_phone,body,category) VALUES(?,?,?,?,?)', userId, channel, to, text, category);
    n++;
  }
  if (n) kick();
  return n;
}

// ---------------------------------------------------------------- Testes pela tela da administração
async function testEmail(to) {
  if (config.mail.mode !== 'smtp') throw new Error('Configure e salve o servidor SMTP antes de testar.');
  await smtp().verify();
  return sendSmtp({ to, subject: 'Teste de envio de e-mail', text: `Este é um e-mail de teste enviado pela administração de ${config.mail.from}.\n\nSe você recebeu, o servidor SMTP está funcionando.` });
}
async function testMessage(channel, phone) {
  if (config.messaging.mode !== 'twilio') throw new Error('Configure e salve a Twilio antes de testar.');
  const to = toE164(phone);
  if (!to) throw new Error('Telefone inválido. Use DDD + número, por exemplo (11) 99999-0000.');
  return sendTwilio({ channel, to, body: 'Mensagem de teste da plataforma. Se você recebeu, o envio está funcionando.' });
}

module.exports = { processQueue, kick, queueUserMessage, toE164, testEmail, testMessage, MAX_ATTEMPTS };
