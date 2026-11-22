'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const payments = require('../lib/payments');

const r = express.Router();
r.use(express.json({ limit: '256kb' }));

/**
 * Processa notificação: valida assinatura, deduplica, consulta o provedor e aplica o estado.
 * Registros de diagnóstico guardam apenas identificadores — nenhum dado pessoal ou de cartão.
 */
async function handleNotification({ provider, secret, headers, query, body }) {
  const dataId = String(query['data.id'] || body?.data?.id || query.id || '');
  const topic = String(query.type || body?.type || query.topic || '');
  const requestId = String(headers['x-request-id'] || '');
  const ok = payments.verifySignature({ secret, xSignature: headers['x-signature'], xRequestId: requestId, dataId });
  const dedupe = `${provider}:${requestId || 'sem-id'}:${dataId}:${body?.action || topic}`;
  if (!ok) {
    await db.run('INSERT INTO webhook_events(provider,dedupe_key,topic,resource_id,signature_ok,result) VALUES(?,?,?,?,0,?) ON CONFLICT DO NOTHING', provider, `${dedupe}:invalid:${Date.now()}`, topic, dataId, 'assinatura inválida');
    return { status: 401, result: 'invalid_signature' };
  }
  if (topic !== 'payment' || !dataId) return { status: 200, result: 'ignored_topic' };
  const ins = await db.run('INSERT INTO webhook_events(provider,dedupe_key,topic,resource_id,signature_ok) VALUES(?,?,?,?,1) ON CONFLICT DO NOTHING', provider, dedupe, topic, dataId);
  if (!ins.changes) return { status: 200, result: 'duplicate' };
  try {
    const out = await payments.processPayment(provider, dataId);
    await db.run('UPDATE webhook_events SET result=? WHERE dedupe_key=?', JSON.stringify(out).slice(0, 300), dedupe);
    return { status: 200, result: out };
  } catch (e) {
    // remove a deduplicação para permitir nova tentativa do provedor
    await db.run('DELETE FROM webhook_events WHERE dedupe_key=?', dedupe);
    console.error('[webhook] falha ao processar', provider, dataId, e.message);
    return { status: 500, result: 'error' };
  }
}

r.post('/mercadopago', async (req, res) => {
  if (!['mp_test', 'mp_live'].includes(config.mp.mode)) return res.status(404).end();
  const out = await handleNotification({ provider: 'mercadopago', secret: config.mp.webhookSecret, headers: req.headers, query: req.query, body: req.body });
  res.status(out.status).json({ ok: out.status === 200 });
});
/** Registra o evento (deduplicado) e aplica o estado consultado no provedor. */
async function applyVerified(provider, dedupe, topic, resourceId, fn) {
  const ins = await db.run('INSERT INTO webhook_events(provider,dedupe_key,topic,resource_id,signature_ok) VALUES(?,?,?,?,1) ON CONFLICT DO NOTHING', provider, dedupe, topic, resourceId);
  if (!ins.changes) return { status: 200, result: 'duplicate' };
  try {
    const out = await fn();
    await db.run('UPDATE webhook_events SET result=? WHERE dedupe_key=?', JSON.stringify(out ?? null).slice(0, 300), dedupe);
    return { status: 200, result: out };
  } catch (e) {
    await db.run('DELETE FROM webhook_events WHERE dedupe_key=?', dedupe);
    console.error('[webhook] falha ao processar', provider, resourceId, e.message);
    return { status: 500, result: 'error' };
  }
}
const rejectSignature = async (provider, topic, id) => { await db.run('INSERT INTO webhook_events(provider,dedupe_key,topic,resource_id,signature_ok,result) VALUES(?,?,?,?,0,?) ON CONFLICT DO NOTHING', provider, `${provider}:invalid:${Date.now()}:${Math.random()}`, topic, id, 'assinatura inválida'); return { status: 401, result: 'invalid_signature' }; };

async function handlePaypal(headers, body) {
  const type = String(body?.event_type || '');
  const res = body?.resource || {};
  let ok = false;
  try { ok = await payments.providers.paypal.verifyWebhook(headers, body); } catch { ok = false; }
  if (!ok) return await rejectSignature('paypal', type, String(res.id || ''));
  if (!body.id) return { status: 200, result: 'ignored' };
  let captureId = null;
  if (type === 'CHECKOUT.ORDER.APPROVED') captureId = async () => await payments.providers.paypal.capture(res.id); // atleta fechou a janela antes do retorno
  else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
    const up = (res.links || []).find((l) => l.rel === 'up')?.href || '';
    captureId = up.split('/').pop() || res.id;
  } else if (type.startsWith('PAYMENT.CAPTURE.')) captureId = res.id;
  if (!captureId) return { status: 200, result: 'ignored_topic' };
  return await applyVerified('paypal', `paypal:${body.id}`, type, String(res.id || ''), async () => {
    const id = typeof captureId === 'function' ? await captureId() : captureId;
    return id ? await payments.processPayment('paypal', id) : { ok: false, reason: 'no_capture' };
  });
}
async function handlePicpay(headers, body) {
  const ref = String(body?.referenceId || '');
  if (!await payments.providers.picpay.verifyWebhook(headers)) return await rejectSignature('picpay', 'callback', ref);
  if (!ref) return { status: 200, result: 'ignored' };
  // O PicPay repete o mesmo corpo a cada mudança de estado; o processamento é idempotente.
  return await applyVerified('picpay', `picpay:${ref}:${body.authorizationId || '-'}:${Date.now()}`, 'callback', ref, async () => await payments.processPayment('picpay', ref));
}
r.post('/paypal', async (req, res) => {
  if (!['test', 'live'].includes(config.paypal.mode)) return res.status(404).end();
  const out = await handlePaypal(req.headers, req.body);
  res.status(out.status).json({ ok: out.status === 200 });
});
r.post('/picpay', async (req, res) => {
  if (!['test', 'live'].includes(config.picpay.mode)) return res.status(404).end();
  const out = await handlePicpay(req.headers, req.body);
  res.status(out.status).json({ ok: out.status === 200 });
});
r.post('/simulador', async (req, res) => {
  if (config.isProd) return res.status(404).end();
  const out = await handleNotification({ provider: 'simulator', secret: payments.SIM_SECRET, headers: req.headers, query: req.query, body: req.body });
  res.status(out.status).json({ ok: out.status === 200, result: out.result });
});
module.exports = r;
module.exports.handleNotification = handleNotification;
module.exports.handlePaypal = handlePaypal;
module.exports.handlePicpay = handlePicpay;
