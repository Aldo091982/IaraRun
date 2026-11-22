'use strict';
// Ferramentas exclusivas de desenvolvimento/testes. Não são montadas em produção.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { html, brl, fmtDateTime, nowIso, code, UserError } = require('../lib/util');
const payments = require('../lib/payments');
const { handleNotification } = require('./webhooks');
const { csrf, table, badge } = require('../views/layout');

const r = express.Router();

r.get('/caixa-de-saida', (req, res) => {
  const mails = db.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 100');
  res.page({ title: 'Caixa de saída (desenvolvimento)', wide: true, body: html`<h1>Caixa de saída local</h1><div class="alert alert-info">Ambiente de desenvolvimento: os e-mails não são enviados; ficam registrados aqui. Configure um provedor de e-mail para produção.</div>
  ${mails.map((m) => html`<article class="card mail"><p class="muted">${fmtDateTime(m.created_at)} · ${badge(m.category, 'muted')} · para <strong>${m.to_email}</strong></p><h3>${m.subject}</h3><pre class="mail-body">${m.body}</pre></article>`)}` });
});

r.get('/pagamento-simulado/:code', (req, res) => {
  if (!payments.anySimulator()) throw new UserError('Simulador desativado: os meios de pagamento têm credenciais configuradas.', 404);
  const o = db.one('SELECT * FROM orders WHERE code=?', req.params.code);
  if (!o) throw new UserError('Pedido não encontrado.', 404);
  const sims = db.all('SELECT * FROM sim_payments WHERE order_code=?', o.code);
  const meio = payments.METHODS[req.query.meio] ? String(req.query.meio) : 'mercadopago';
  res.page({ title: 'Pagamento simulado', body: html`<section class="card narrow sim"><p>${badge('DEMONSTRAÇÃO — nenhum valor real', 'warn')}</p><h1>Checkout simulado · ${payments.METHODS[meio].label}</h1>
  <p>Pedido <strong>${o.code}</strong> · ${brl(o.total_cents)}</p><p class="muted">Este simulador substitui o ${payments.METHODS[meio].label} quando não há credenciais. Ele cria uma transação local e envia um webhook assinado; o servidor consulta o estado e valida valor, moeda e pedido antes de confirmar — o mesmo fluxo do provedor real.</p>
  <form method="post">${csrf(req)}<input type="hidden" name="meio" value="${meio}">
  ${meio === 'paypal' ? html`<button class="btn btn-block" name="acao" value="approved:paypal">Pagar com conta PayPal (aprovar)</button>`
    : meio === 'picpay' ? html`<button class="btn btn-block" name="acao" value="approved:picpay">Pagar com PicPay (aprovar)</button>`
    : html`<button class="btn btn-block" name="acao" value="approved:pix">Pagar com Pix (aprovar)</button>
  <button class="btn btn-block" name="acao" value="approved:credit_card">Pagar com cartão de teste (aprovar)</button>
  <button class="btn btn-block" name="acao" value="approved:account_money">Pagar com saldo Mercado Pago (aprovar)</button>`}
  <button class="btn btn-ghost btn-block" name="acao" value="pending:${meio === 'mercadopago' ? 'pix' : meio}">Deixar pendente</button>
  <button class="btn btn-ghost btn-block" name="acao" value="rejected:${meio === 'mercadopago' ? 'credit_card' : meio}">Simular recusa</button>
  <button class="btn btn-ghost btn-block" name="acao" value="wrong_amount:${meio === 'mercadopago' ? 'pix' : meio}">Simular valor divergente</button></form>
  ${sims.length ? html`<h2>Transações simuladas</h2>${table(['ID', 'Situação', 'Valor'], sims.map((s) => [s.id, s.status, brl(s.amount_cents)]))}<form method="post">${csrf(req)}<button class="btn btn-ghost btn-sm" name="acao" value="replay">Reenviar último webhook (teste de duplicidade)</button></form>` : ''}
  <p><a href="/pedido/${o.code}">Voltar ao pedido</a></p></section>` });
});

async function simulate(orderCode, status, method, { amount } = {}) {
  const o = db.one('SELECT * FROM orders WHERE code=?', orderCode);
  const id = `SIM${code('').slice(1)}`;
  db.run('INSERT INTO sim_payments(id,order_code,status,amount_cents,method,updated_at) VALUES(?,?,?,?,?,?)', id, o.code, status, amount ?? o.total_cents, method, nowIso());
  return sendSimWebhook(id);
}
async function sendSimWebhook(paymentId, requestId = code('REQ')) {
  return handleNotification({ provider: 'simulator', secret: payments.SIM_SECRET, headers: { 'x-request-id': requestId, 'x-signature': payments.signForSim(paymentId, requestId) }, query: { 'data.id': paymentId, type: 'payment' }, body: { action: 'payment.updated', type: 'payment', data: { id: paymentId } } });
}
r.post('/pagamento-simulado/:code', async (req, res) => {
  if (!payments.anySimulator()) throw new UserError('Simulador desativado.', 404);
  const o = db.one('SELECT * FROM orders WHERE code=?', req.params.code);
  if (!o) throw new UserError('Pedido não encontrado.', 404);
  if (req.body.acao === 'replay') {
    const last = db.one('SELECT * FROM sim_payments WHERE order_code=? ORDER BY rowid DESC LIMIT 1', o.code);
    const ev = db.one("SELECT dedupe_key FROM webhook_events WHERE resource_id=? AND signature_ok=1 ORDER BY id DESC LIMIT 1", last.id);
    const out = await sendSimWebhook(last.id, ev ? ev.dedupe_key.split(':')[1] : undefined);
    res.flash('info', `Webhook reenviado: ${typeof out.result === 'string' ? out.result : 'processado'}.`);
    return res.redirect(303, `/dev/pagamento-simulado/${o.code}?meio=${encodeURIComponent(req.body.meio || 'mercadopago')}`);
  }
  const [st, method] = String(req.body.acao).split(':');
  if (st === 'wrong_amount') await simulate(o.code, 'approved', method, { amount: o.total_cents - 100 });
  else await simulate(o.code, ['approved', 'pending', 'rejected'].includes(st) ? st : 'pending', method);
  res.redirect(303, `/pedido/${o.code}`);
});
module.exports = r;
module.exports.simulate = simulate;
module.exports.sendSimWebhook = sendSimWebhook;
