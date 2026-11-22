'use strict';
/**
 * Pagamentos via Mercado Pago (Checkout Pro + Webhooks).
 * Referências oficiais consultadas:
 *  - Criar preferência: POST https://api.mercadopago.com/checkout/preferences
 *  - Consultar pagamento: GET https://api.mercadopago.com/v1/payments/{id}
 *  - Reembolso: POST https://api.mercadopago.com/v1/payments/{id}/refunds (X-Idempotency-Key)
 *  - Webhooks: cabeçalhos x-signature (ts=...,v1=...) e x-request-id;
 *    manifesto "id:{data.id};request-id:{x-request-id};ts:{ts};" assinado com HMAC-SHA256 da chave secreta.
 * Nunca confiamos no corpo da notificação: o estado é sempre consultado no provedor e validado
 * (pedido, valor, moeda e beneficiário) antes de liberar a inscrição.
 *
 * Sem credenciais e fora de produção, o "simulador" (DEMONSTRAÇÃO) reproduz o mesmo fluxo:
 * cria um pagamento local, envia webhook assinado e o servidor consulta o estado como faria no MP.
 */
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const { confirmOrder, cancelRegistration } = require('./orders');
const { audit, sendMail } = require('./core');
const { nowIso, code, UserError } = require('./util');

const SIM_SECRET = 'simulador-local-somente-desenvolvimento';
const MP_API = 'https://api.mercadopago.com';

const STATUS_MAP = { approved: 'approved', authorized: 'pending', pending: 'pending', in_process: 'pending', in_mediation: 'pending', rejected: 'rejected', cancelled: 'cancelled', refunded: 'refunded', charged_back: 'refunded', expired: 'expired' };
const PAY_LABEL = { approved: 'Aprovado', pending: 'Pendente', rejected: 'Recusado', cancelled: 'Cancelado', refunded: 'Reembolsado', expired: 'Expirado' };

async function mpFetch(path, { method = 'GET', body, idem } = {}) {
  const res = await fetch(MP_API + path, {
    method,
    headers: { Authorization: `Bearer ${config.mp.accessToken}`, 'Content-Type': 'application/json', ...(idem ? { 'X-Idempotency-Key': idem } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`Mercado Pago ${res.status}`); e.status = res.status; e.provider = j?.message; throw e; }
  return j;
}

const PP_API = () => (config.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
let ppToken = { value: null, exp: 0 };
async function ppAuth() {
  if (ppToken.value && Date.now() < ppToken.exp) return ppToken.value;
  const res = await fetch(PP_API() + '/v1/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Basic ' + Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) { const e = new Error(`PayPal autenticação ${res.status}`); e.status = res.status; throw e; }
  ppToken = { value: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 300) - 60) * 1000 };
  return ppToken.value;
}
async function ppFetch(path, { method = 'GET', body, idem } = {}) {
  const res = await fetch(PP_API() + path, { method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${await ppAuth()}`, 'Content-Type': 'application/json', ...(idem ? { 'PayPal-Request-Id': idem } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`PayPal ${res.status}`); e.status = res.status; e.provider = j?.name; throw e; }
  return j;
}
const PICPAY_API = 'https://appws.picpay.com/ecommerce/public';
async function picFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(PICPAY_API + path, { method, signal: AbortSignal.timeout(15000),
    headers: { 'x-picpay-token': config.picpay.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`PicPay ${res.status}`); e.status = res.status; e.provider = j?.message; throw e; }
  return j;
}

const providers = {
  simulator: {
    name: 'simulator',
    async createCheckout(order, ev, meio = 'mercadopago') { return { ref: `sim-${meio}-${order.code}`, url: `/dev/pagamento-simulado/${order.code}?meio=${meio}` }; },
    async getPayment(id) {
      const p = db.one('SELECT * FROM sim_payments WHERE id=?', id);
      if (!p) return null;
      return { id: p.id, status: p.status, amount_cents: p.amount_cents, currency: p.currency, external_reference: p.order_code, method: p.method, refunded_cents: p.refunded_cents, updated_at: p.updated_at, collector_ok: true };
    },
    async refund(id, cents) {
      const p = db.one('SELECT * FROM sim_payments WHERE id=?', id);
      const refunded = Math.min(p.amount_cents, p.refunded_cents + cents);
      db.run('UPDATE sim_payments SET refunded_cents=?, status=?, updated_at=? WHERE id=?', refunded, refunded >= p.amount_cents ? 'refunded' : p.status, nowIso(), id);
      return { id: 'sim-refund-' + code('R'), amount_cents: cents };
    },
  },
  mercadopago: {
    name: 'mercadopago',
    async createCheckout(order, ev) {
      const pref = await mpFetch('/checkout/preferences', {
        method: 'POST', idem: `pref-${order.code}`,
        body: {
          items: [{ id: order.code, title: `Inscrição — ${ev.name}`.slice(0, 250), quantity: 1, unit_price: order.total_cents / 100, currency_id: 'BRL' }],
          external_reference: order.code,
          notification_url: `${config.baseUrl}/webhooks/mercadopago`,
          back_urls: { success: `${config.baseUrl}/pedido/${order.code}`, pending: `${config.baseUrl}/pedido/${order.code}`, failure: `${config.baseUrl}/pedido/${order.code}` },
          auto_return: 'approved',
          expires: true, expiration_date_to: order.expires_at, date_of_expiration: order.expires_at,
          // Boleto excluído: compensação demorada é incompatível com a reserva temporária (item 21.10)
          payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
          statement_descriptor: 'INSCRICAO',
        },
      });
      return { ref: pref.id, url: config.mp.mode === 'mp_test' ? (pref.sandbox_init_point || pref.init_point) : pref.init_point };
    },
    async getPayment(id) {
      const p = await mpFetch(`/v1/payments/${encodeURIComponent(id)}`);
      const expectedCollector = process.env.MP_COLLECTOR_ID;
      return {
        id: String(p.id), status: p.status, amount_cents: Math.round(Number(p.transaction_amount) * 100), currency: p.currency_id,
        external_reference: p.external_reference, method: p.payment_type_id, refunded_cents: Math.round(Number(p.transaction_amount_refunded || 0) * 100),
        updated_at: p.date_last_updated, collector_ok: !expectedCollector || String(p.collector_id) === String(expectedCollector),
      };
    },
    async refund(id, cents, idem) { const r = await mpFetch(`/v1/payments/${encodeURIComponent(id)}/refunds`, { method: 'POST', idem, body: { amount: cents / 100 } }); return { id: String(r.id), amount_cents: cents }; },
  },
  /**
   * PayPal — Orders v2 (https://developer.paypal.com/docs/api/orders/v2/):
   * cria a ordem (intent CAPTURE, BRL), o atleta aprova no PayPal, o retorno captura a ordem
   * e o estado é sempre lido em GET /v2/payments/captures/{id}. Webhooks verificados por
   * POST /v1/notifications/verify-webhook-signature.
   */
  paypal: {
    name: 'paypal',
    async createCheckout(order, ev) {
      const o = await ppFetch('/v2/checkout/orders', {
        method: 'POST', idem: `ppo-${order.code}`,
        body: {
          intent: 'CAPTURE',
          purchase_units: [{ reference_id: order.code, custom_id: order.code, invoice_id: order.code, description: `Inscrição — ${ev.name}`.slice(0, 127),
            amount: { currency_code: 'BRL', value: (order.total_cents / 100).toFixed(2) } }],
          payment_source: { paypal: { experience_context: { locale: 'pt-BR', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW',
            return_url: `${config.baseUrl}/pagamento/paypal/retorno`, cancel_url: `${config.baseUrl}/pedido/${order.code}` } } },
        },
      });
      const link = (o.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      if (!link) throw new Error('PayPal não retornou o link de pagamento');
      return { ref: o.id, url: link.href };
    },
    /** Captura a ordem aprovada e devolve o ID da captura. Idempotente: se já capturada, consulta. */
    async capture(ppOrderId) {
      let o;
      try { o = await ppFetch(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}/capture`, { method: 'POST', idem: `cap-${ppOrderId}`, body: {} }); }
      catch (e) { if (e.status !== 422) throw e; o = await ppFetch(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}`); }
      return o.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
    },
    async getPayment(id) {
      const c = await ppFetch(`/v2/payments/captures/${encodeURIComponent(id)}`);
      const amount = Math.round(Number(c.amount?.value) * 100);
      const st = { COMPLETED: 'approved', PENDING: 'pending', DECLINED: 'rejected', FAILED: 'rejected', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'approved' }[c.status] || 'pending';
      return { id: String(c.id), status: st, amount_cents: amount, currency: c.amount?.currency_code, external_reference: c.custom_id || c.invoice_id,
        method: 'paypal', refunded_cents: c.status === 'REFUNDED' ? amount : 0, updated_at: c.update_time,
        collector_ok: !config.paypal.merchantId || c.payee?.merchant_id === config.paypal.merchantId };
    },
    async refund(id, cents, idem) {
      const r = await ppFetch(`/v2/payments/captures/${encodeURIComponent(id)}/refund`, { method: 'POST', idem, body: { amount: { value: (cents / 100).toFixed(2), currency_code: 'BRL' } } });
      return { id: String(r.id), amount_cents: cents };
    },
    async verifyWebhook(headers, body) {
      if (!config.paypal.webhookId) return false;
      const r = await ppFetch('/v1/notifications/verify-webhook-signature', { method: 'POST', body: {
        auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: config.paypal.webhookId, webhook_event: body } });
      return r.verification_status === 'SUCCESS';
    },
  },
  /**
   * PicPay — API de e-commerce (https://ecommerce.picpay.com/doc/): POST /payments cria a cobrança,
   * o PicPay chama a URL de callback com x-seller-token e o estado é lido em GET /payments/{ref}/status.
   * Reembolso só total, por POST /payments/{ref}/cancellations.
   */
  picpay: {
    name: 'picpay',
    async createCheckout(order) {
      const u = db.one('SELECT name, email, phone, cpf FROM users WHERE id=?', order.user_id);
      const g = db.one('SELECT name, cpf FROM registrations WHERE order_id=? ORDER BY id LIMIT 1', order.id) || {};
      const name = String(u.name || g.name || '').trim().split(/\s+/);
      const cpf = String(u.cpf || g.cpf || '').replace(/\D/g, '');
      const r = await picFetch('/payments', { method: 'POST', body: {
        referenceId: order.code, callbackUrl: `${config.baseUrl}/webhooks/picpay`, returnUrl: `${config.baseUrl}/pedido/${order.code}`,
        value: order.total_cents / 100, expiresAt: order.expires_at,
        buyer: { firstName: name[0] || 'Atleta', lastName: name.slice(1).join(' ') || '-', document: cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'), email: u.email, phone: u.phone || '' } } });
      if (!r.paymentUrl) throw new Error('PicPay não retornou o link de pagamento');
      return { ref: order.code, url: r.paymentUrl };
    },
    async getPayment(ref) {
      const r = await picFetch(`/payments/${encodeURIComponent(ref)}/status`);
      const order = db.one('SELECT total_cents FROM orders WHERE code=?', ref);
      const st = { created: 'pending', analysis: 'pending', paid: 'approved', completed: 'approved', expired: 'expired', refunded: 'refunded', chargeback: 'refunded' }[r.status] || 'pending';
      // A consulta de status do PicPay não devolve o valor: vale o valor enviado na criação (referenceId = código do pedido).
      return { id: String(r.referenceId || ref), status: st, amount_cents: order?.total_cents, currency: 'BRL', external_reference: r.referenceId || ref,
        method: 'picpay', refunded_cents: st === 'refunded' ? order?.total_cents : 0, updated_at: null, collector_ok: true };
    },
    async refund(ref, cents, idem, pay) {
      if (pay && cents < pay.amount_cents - (pay.refunded_cents || 0)) throw new UserError('O PicPay só permite reembolso do valor total.');
      const st = await picFetch(`/payments/${encodeURIComponent(ref)}/status`);
      const r = await picFetch(`/payments/${encodeURIComponent(ref)}/cancellations`, { method: 'POST', body: st.authorizationId ? { authorizationId: st.authorizationId } : {} });
      return { id: String(r.cancellationId || `picpay-${ref}`), amount_cents: cents };
    },
    verifyWebhook(headers) {
      const got = String(headers['x-seller-token'] || ''); const exp = config.picpay.sellerToken;
      if (!exp || !got) return false;
      const a = Buffer.from(got), b = Buffer.from(exp);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  },
};
function provider() {
  if (config.mp.mode === 'simulator') return providers.simulator;
  if (['mp_test', 'mp_live'].includes(config.mp.mode)) return providers.mercadopago;
  return null;
}
const MODE_LABEL = {
  simulator: 'Simulador local (DEMONSTRAÇÃO — nenhum valor real é cobrado)',
  mp_test: 'Mercado Pago — ambiente de testes',
  mp_live: 'Mercado Pago — produção',
  blocked_undecided: 'Bloqueado: modelo de recebimento (plataforma × organizador) ainda não decidido',
  disabled: 'Desativado: credenciais do Mercado Pago não configuradas',
};

/** Meios de pagamento oferecidos ao atleta. */
const METHODS = {
  mercadopago: { label: 'Mercado Pago', detail: 'Pix, cartão de crédito ou débito, saldo e linha de crédito Mercado Pago' },
  paypal: { label: 'PayPal', detail: 'Conta PayPal ou cartão pelo PayPal' },
  picpay: { label: 'PicPay', detail: 'Carteira PicPay: saldo ou cartão cadastrado no app' },
};
const METHOD_LABEL = { pix: 'Pix', credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito', account_money: 'Saldo Mercado Pago', digital_currency: 'Linha de crédito Mercado Pago', paypal: 'PayPal', picpay: 'PicPay' };
function methodMode(key) {
  if (key === 'mercadopago') return { simulator: 'simulator', mp_test: 'test', mp_live: 'live' }[config.mp.mode] || config.mp.mode;
  return config[key]?.mode || 'disabled';
}
/** Meios disponíveis agora, com o modo de cada um (simulator | test | live). */
function availableMethods() {
  return config.paymentMethods.filter((k) => METHODS[k]).map((k) => ({ key: k, ...METHODS[k], mode: methodMode(k) }))
    .filter((m) => ['simulator', 'test', 'live'].includes(m.mode));
}
const anySimulator = () => availableMethods().some((m) => m.mode === 'simulator');

async function startCheckout(order, meio) {
  const ev = db.one('SELECT * FROM events WHERE id=?', order.event_id);
  const avail = availableMethods();
  const m = avail.find((x) => x.key === meio) || (!meio ? avail[0] : null);
  if (!m) throw new UserError('Meio de pagamento indisponível neste ambiente.', 503);
  const prov = m.mode === 'simulator' ? providers.simulator : providers[m.key];
  const sameMethod = order.provider === prov.name && (prov.name !== 'simulator' || String(order.provider_ref || '').startsWith(`sim-${m.key}-`));
  if (order.checkout_url && sameMethod) return order.checkout_url; // reaproveita o checkout já criado
  // Troca de meio: se o atleta pagar pelos dois, o segundo aprovado vira exceção para reembolso (processPayment).
  const r = await prov.createCheckout(order, ev, m.key);
  db.run('UPDATE orders SET provider=?, provider_ref=?, checkout_url=?, updated_at=? WHERE id=?', prov.name, r.ref, r.url, nowIso(), order.id);
  audit(null, 'payment.checkout', { entity: 'order', entityId: order.id, detail: { method: m.key, mode: m.mode } });
  return r.url;
}

function verifySignature({ secret, xSignature, xRequestId, dataId }) {
  if (!secret || !xSignature) return false;
  const parts = Object.fromEntries(String(xSignature).split(',').map((kv) => kv.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId || '') ? String(dataId).toLowerCase() : dataId;
  let manifest = '';
  if (id) manifest += `id:${id};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${parts.ts};`;
  const calc = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(String(parts.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function signForSim(dataId, requestId) {
  const ts = String(Date.now());
  const v1 = crypto.createHmac('sha256', SIM_SECRET).update(`id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

/** Processa notificação de pagamento consultando o provedor. Idempotente e tolerante a ordem. */
async function processPayment(provName, paymentId) {
  const prov = providers[provName];
  const p = await prov.getPayment(paymentId);
  if (!p) return { ok: false, reason: 'payment_not_found' };
  const order = db.one('SELECT * FROM orders WHERE code=?', p.external_reference || '');
  if (!order) return { ok: false, reason: 'order_not_found' };
  const status = STATUS_MAP[p.status] || 'pending';

  return db.tx(() => {
    const prev = db.one('SELECT * FROM payments WHERE provider=? AND provider_payment_id=?', provName, p.id);
    // Fora de ordem: ignora estado mais antigo do que o já registrado
    if (prev && prev.provider_updated_at && p.updated_at && p.updated_at < prev.provider_updated_at) return { ok: true, ignored: 'stale' };
    if (prev) db.run('UPDATE payments SET status=?, method=?, amount_cents=?, currency=?, refunded_cents=?, provider_updated_at=?, updated_at=? WHERE id=?', status, p.method, p.amount_cents, p.currency, p.refunded_cents || 0, p.updated_at, nowIso(), prev.id);
    else db.run('INSERT INTO payments(order_id,provider,provider_payment_id,status,method,amount_cents,currency,refunded_cents,provider_updated_at) VALUES(?,?,?,?,?,?,?,?,?)', order.id, provName, p.id, status, p.method, p.amount_cents, p.currency, p.refunded_cents || 0, p.updated_at);

    if (status === 'approved') {
      const mismatch = [];
      if (p.amount_cents !== order.total_cents) mismatch.push(`valor ${p.amount_cents} ≠ ${order.total_cents}`);
      if (p.currency !== 'BRL') mismatch.push(`moeda ${p.currency}`);
      if (!p.collector_ok) mismatch.push('beneficiário divergente');
      const otherApproved = db.one("SELECT 1 FROM payments WHERE order_id=? AND status='approved' AND provider_payment_id<>?", order.id, p.id);
      if (otherApproved && ['paid', 'free'].includes(order.status)) mismatch.push('pagamento duplicado para pedido já pago');
      if (mismatch.length) {
        const note = 'Pagamento aprovado com divergência: ' + mismatch.join('; ');
        if (!['paid', 'free'].includes(order.status)) db.run("UPDATE orders SET status='exception', exception_note=? WHERE id=?", note, order.id);
        db.run('INSERT INTO payment_exceptions(order_id,reason) VALUES(?,?)', order.id, note);
        audit(null, 'payment.mismatch', { entity: 'order', entityId: order.id, detail: { mismatch } });
        return { ok: false, reason: 'mismatch' };
      }
      return confirmOrder(order.id);
    }
    if (status === 'refunded' && ['paid', 'partially_refunded'].includes(order.status)) {
      const full = (p.refunded_cents || p.amount_cents) >= order.total_cents;
      if (full) {
        db.run("UPDATE orders SET status='refunded', updated_at=? WHERE id=?", nowIso(), order.id);
        for (const g of db.all("SELECT id FROM registrations WHERE order_id=? AND status='confirmed'", order.id)) cancelRegistration(g.id, 'refunded');
      }
      return { ok: true, refunded: true };
    }
    if (status === 'pending' && order.status === 'pending') {
      const u = db.one('SELECT email FROM users WHERE id=?', order.user_id);
      if (!prev) sendMail(u.email, `Pagamento pendente — pedido ${order.code}`, 'Recebemos seu pagamento e ele está em análise. A inscrição será confirmada assim que o pagamento for aprovado.', 'payments');
    }
    return { ok: true, status };
  });
}

/** Reembolso (total ou parcial) solicitado por quem tem permissão. */
async function refund(order, cents, req) {
  const pay = db.one("SELECT * FROM payments WHERE order_id=? AND status='approved' ORDER BY id DESC LIMIT 1", order.id);
  if (!pay) {
    if (order.status === 'free') return { ok: true, free: true };
    throw new UserError('Não há pagamento aprovado para reembolsar.');
  }
  const prov = providers[pay.provider];
  const amount = Math.min(cents, (pay.amount_cents || 0) - (pay.refunded_cents || 0));
  if (amount <= 0) throw new UserError('Valor já reembolsado.');
  const r = await prov.refund(pay.provider_payment_id, amount, `refund-${order.code}-${pay.refunded_cents + amount}`, pay);
  db.run('UPDATE payments SET refunded_cents=refunded_cents+?, status=CASE WHEN refunded_cents+?>=amount_cents THEN ? ELSE status END, updated_at=? WHERE id=?', amount, amount, 'refunded', nowIso(), pay.id);
  const after = db.one('SELECT * FROM payments WHERE id=?', pay.id);
  db.run('UPDATE orders SET status=?, updated_at=? WHERE id=?', after.refunded_cents >= order.total_cents ? 'refunded' : 'partially_refunded', nowIso(), order.id);
  audit(req, 'payment.refund', { entity: 'order', entityId: order.id, orgId: req?.org?.id, detail: { amount, refund_id: r.id } });
  return { ok: true, amount };
}

/** Conciliação: compara pedidos com transações registradas. */
function reconciliation(eventIds) {
  if (!eventIds.length) return [];
  const ph = eventIds.map(() => '?').join(',');
  return db.all(`SELECT o.code, o.status order_status, o.total_cents, p.provider, p.provider_payment_id, p.status pay_status, p.amount_cents, p.refunded_cents, p.method,
      CASE WHEN o.status IN ('paid','partially_refunded') AND (p.status IS NULL OR p.status<>'approved') AND p.refunded_cents=0 THEN 'Pedido pago sem pagamento aprovado'
           WHEN p.status='approved' AND o.status NOT IN ('paid','partially_refunded') THEN 'Pagamento aprovado sem pedido confirmado'
           WHEN p.status='approved' AND p.amount_cents<>o.total_cents THEN 'Valor divergente'
           ELSE 'OK' END AS check_result
    FROM orders o LEFT JOIN payments p ON p.order_id=o.id WHERE o.event_id IN (${ph}) AND o.total_cents>0 AND o.status NOT IN ('expired') ORDER BY o.created_at DESC`, ...eventIds);
}

module.exports = { providers, provider, METHODS, METHOD_LABEL, availableMethods, methodMode, anySimulator, MODE_LABEL, PAY_LABEL, startCheckout, verifySignature, signForSim, processPayment, refund, reconciliation, SIM_SECRET };
