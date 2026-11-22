'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const f = require('./fixtures');
const { db } = h;
const config = require('../src/config');
const payments = require('../src/lib/payments');
const { handlePaypal, handlePicpay } = require('../src/routes/webhooks');

before(h.start);
after(h.stop);

// Respostas falsas das APIs externas; chamadas ao próprio app passam direto.
const realFetch = global.fetch;
let calls = [];
let api = {};
function mockApis() {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!/paypal\.com|picpay\.com/.test(u)) return realFetch(url, opts);
    const body = opts.body && opts.headers?.['Content-Type'] === 'application/json' ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: u, method: opts.method || 'GET', body, headers: opts.headers });
    const handler = Object.entries(api).filter(([k]) => u.includes(k)).sort((x, y) => y[0].length - x[0].length)[0];
    const [status, json] = handler ? handler[1](u, body) : [404, { message: 'not mocked' }];
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
const saved = { paypal: { ...config.paypal }, picpay: { ...config.picpay } };
function restore() { global.fetch = realFetch; Object.assign(config.paypal, saved.paypal); Object.assign(config.picpay, saved.picpay); calls = []; api = {}; }

let o, ev;
before(async () => { await h.start(); o = await f.organizer(); ev = await f.event(o.c); });
async function newOrder() { const a = await f.athlete(); const r = await f.register(a, ev); return { a, order: r.order }; }
const order = async (code) => await db.one('SELECT * FROM orders WHERE code=?', code);

test('pedido oferece Mercado Pago, PayPal e PicPay; PayPal simulado confirma a inscrição', async () => {
  const { a, order: ord } = await newOrder();
  const page = await a.c.get(`/pedido/${ord.code}`);
  for (const m of ['Mercado Pago', 'PayPal', 'PicPay']) assert.match(page.text, new RegExp(`value="${m === 'Mercado Pago' ? 'mercadopago' : m.toLowerCase()}"`));
  const go = await a.c.post(`/pedido/${ord.code}/pagar`, { meio: 'paypal' });
  assert.match(go.url, /meio=paypal/);
  assert.match(go.text, /Checkout simulado · PayPal/);
  await a.c.post(`/dev/pagamento-simulado/${ord.code}`, { acao: 'approved:paypal', meio: 'paypal' });
  assert.equal((await order(ord.code)).status, 'paid');
  assert.equal((await db.one('SELECT method FROM payments WHERE order_id=?', ord.id)).method, 'paypal');
  assert.match((await a.c.get(`/pedido/${ord.code}`)).text, /<td>PayPal<\/td>/);
});

test('meio desconhecido é recusado', async () => {
  const { a, order: ord } = await newOrder();
  const r = await a.c.post(`/pedido/${ord.code}/pagar`, { meio: 'bitcoin' });
  assert.equal(r.status, 503);
});

test('PayPal real: cria ordem em BRL, captura no retorno e valida o valor', async (t) => {
  t.after(restore);
  Object.assign(config.paypal, { clientId: 'cid', clientSecret: 'sec', webhookId: 'WH1', env: 'sandbox', mode: 'test' });
  mockApis();
  const { a, order: ord } = await newOrder();
  const value = (ord.total_cents / 100).toFixed(2);
  let captured = { status: 'COMPLETED', value };
  api = {
    '/v1/oauth2/token': () => [200, { access_token: 'tok', expires_in: 3600 }],
    '/v2/checkout/orders/PPO1/capture': () => [201, { purchase_units: [{ payments: { captures: [{ id: 'CAP1' }] } }] }],
    '/v2/checkout/orders': () => [201, { id: 'PPO1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PPO1' }] }],
    '/v2/payments/captures/CAP1': () => [200, { id: 'CAP1', status: captured.status, amount: { value: captured.value, currency_code: 'BRL' }, custom_id: ord.code, update_time: new Date().toISOString() }],
  };
  const go = await a.c.post(`/pedido/${ord.code}/pagar`, { meio: 'paypal' }, { follow: false });
  assert.match(go.location, /sandbox\.paypal\.com\/checkoutnow\?token=PPO1/);
  const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'));
  assert.equal(create.body.purchase_units[0].amount.currency_code, 'BRL');
  assert.equal(create.body.purchase_units[0].amount.value, value);
  assert.equal(create.body.purchase_units[0].custom_id, ord.code);
  assert.equal(create.headers['PayPal-Request-Id'], `ppo-${ord.code}`, 'criação idempotente');
  await a.c.get('/pagamento/paypal/retorno?token=PPO1');
  assert.equal((await order(ord.code)).status, 'paid');

  // Valor divergente em outro pedido vira exceção, não confirmação
  const second = await newOrder();
  api['/v2/checkout/orders'] = () => [201, { id: 'PPO2', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PPO2' }] }];
  api['/v2/checkout/orders/PPO2/capture'] = () => [201, { purchase_units: [{ payments: { captures: [{ id: 'CAP2' }] } }] }];
  api['/v2/payments/captures/CAP2'] = () => [200, { id: 'CAP2', status: 'COMPLETED', amount: { value: '1.00', currency_code: 'BRL' }, custom_id: second.order.code, update_time: new Date().toISOString() }];
  await second.a.c.post(`/pedido/${second.order.code}/pagar`, { meio: 'paypal' }, { follow: false });
  await second.a.c.get('/pagamento/paypal/retorno?token=PPO2');
  assert.equal((await order(second.order.code)).status, 'exception');
});

test('PayPal webhook: assinatura recusada pelo PayPal retorna 401 e nada muda', async (t) => {
  t.after(restore);
  Object.assign(config.paypal, { clientId: 'cid', clientSecret: 'sec', webhookId: 'WH1', mode: 'test' });
  mockApis();
  api = { '/v1/oauth2/token': () => [200, { access_token: 'tok', expires_in: 3600 }], 'verify-webhook-signature': () => [200, { verification_status: 'FAILURE' }] };
  const out = await handlePaypal({ 'paypal-transmission-id': 'x' }, { id: 'WH-EV-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPX' } });
  assert.equal(out.status, 401);
  assert.ok(!calls.some((c) => c.url.includes('/captures/CAPX')), 'não consulta pagamento com assinatura inválida');
});

test('PicPay: cobrança com CPF do comprador, callback autenticado, reembolso só total', async (t) => {
  t.after(restore);
  Object.assign(config.picpay, { token: 'pp-token', sellerToken: 'seller-123', mode: 'test' });
  mockApis();
  const { a, order: ord } = await newOrder();
  let status = 'created';
  api = {
    [`ecommerce/public/payments/${ord.code}/cancellations`]: () => { status = 'refunded'; return [200, { referenceId: ord.code, cancellationId: 'CANC1' }]; },
    [`ecommerce/public/payments/${ord.code}/status`]: () => [200, { referenceId: ord.code, status, authorizationId: 'AUTH1' }],
    'ecommerce/public/payments': () => [200, { referenceId: ord.code, paymentUrl: `https://app.picpay.com/checkout/${ord.code}` }],
  };
  const go = await a.c.post(`/pedido/${ord.code}/pagar`, { meio: 'picpay' }, { follow: false });
  assert.match(go.location, /app\.picpay\.com\/checkout/);
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/payments'));
  assert.equal(create.headers['x-picpay-token'], 'pp-token');
  assert.equal(create.body.value, ord.total_cents / 100);
  assert.match(create.body.buyer.document, /^\d{3}\.\d{3}\.\d{3}-\d{2}$/);

  assert.equal((await handlePicpay({ 'x-seller-token': 'errado' }, { referenceId: ord.code })).status, 401);
  status = 'paid';
  assert.equal((await handlePicpay({ 'x-seller-token': 'seller-123' }, { referenceId: ord.code, authorizationId: 'AUTH1' })).status, 200);
  assert.equal((await order(ord.code)).status, 'paid');

  await assert.rejects(async () => await payments.refund(await order(ord.code), 100, null), /reembolso do valor total/);
  await payments.refund(await order(ord.code), ord.total_cents, null);
  assert.equal((await order(ord.code)).status, 'refunded');
  assert.ok(calls.some((c) => c.url.endsWith('/cancellations') && c.body.authorizationId === 'AUTH1'));
});
