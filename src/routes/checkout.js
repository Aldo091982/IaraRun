'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { html, raw, brl, fmtDateTime, fmtDate, json, UserError, NotFound, ageAt } = require('../lib/util');
const { fmtCpf } = require('../lib/docs');
const { currentLot, publicStatus, counts, expireStale } = require('../lib/events');
const { createOrder, questionsFor } = require('../lib/orders');
const payments = require('../lib/payments');
const { requireUser } = require('../lib/guards');
const { loadPublicEvent } = require('./public');
const { csrf, field, badge, table, tip, errorsBox, empty } = require('../views/layout');

const r = express.Router();
const ORDER_STATUS = { pending: ['Aguardando pagamento', 'warn'], paid: ['Pago e confirmado', 'ok'], free: ['Confirmado (gratuito)', 'ok'], expired: ['Reserva expirada', 'muted'], cancelled: ['Cancelado', 'muted'], refunded: ['Reembolsado', 'muted'], partially_refunded: ['Parcialmente reembolsado', 'info'], exception: ['Em análise (exceção de pagamento)', 'danger'] };

async function participantBlock(ev, i, user, v = {}) {
  const sizeRows = await db.all('SELECT s.size, s.stock, s.kit_id FROM kit_sizes s JOIN kits k ON k.id=s.kit_id WHERE k.event_id=? ORDER BY s.id', ev.id);
  const sizeOk = new Set();
  for (const s of sizeRows) if (await counts.size(s.kit_id, s.size) < s.stock) sizeOk.add(`${s.kit_id}|${s.size}`);
  const mods = await db.all('SELECT * FROM modalities WHERE event_id=? ORDER BY sort,id', ev.id);
  const kits = await db.all('SELECT * FROM kits WHERE event_id=?', ev.id);
  const allQs = await db.all('SELECT q.*, m.name mn FROM questions q LEFT JOIN modalities m ON m.id=q.modality_id WHERE q.event_id=? AND q.active=1 ORDER BY sort,id', ev.id);
  const self = i === 0 && v.self !== '0';
  const pre = self && !v.name ? { name: user.name, cpf: user.cpf ? fmtCpf(user.cpf) : '', birth_date: user.birth_date, gender: user.gender, email: user.email } : {};
  const val = { ...pre, ...v };
  const p = (n) => `p[${i}][${n}]`;
  return html`<fieldset class="card participant"><legend>Participante ${i + 1}</legend>
  ${i === 0 ? html`<input type="hidden" name="${p('self')}" value="1"><p class="muted">Participante 1 é você (dados do seu perfil). <a href="/minha-conta/perfil">Atualizar perfil</a></p>` : ''}
  <div class="row">${field(p('name'), 'Nome completo', { value: val.name, required: true, id: `p${i}-name` })}${field(p('cpf'), 'CPF', { value: val.cpf, required: true, id: `p${i}-cpf`, attrs: 'inputmode="numeric" data-mask="cpf"' })}</div>
  <div class="row">${field(p('birth_date'), 'Data de nascimento', { type: 'date', value: val.birth_date, required: true, id: `p${i}-birth`, attrs: `data-minor-target="p${i}-guardian"` })}${field(p('gender'), 'Sexo (para categoria)', { value: val.gender, options: [['', 'Selecione'], ['F', 'Feminino'], ['M', 'Masculino']], required: true, id: `p${i}-g` })}${field(p('email'), 'E-mail do participante', { type: 'email', value: val.email, id: `p${i}-email` })}</div>
  <div id="p${i}-guardian" class="guardian"><p class="muted">Menor de 18 anos na data da prova: informe o responsável legal, que autoriza a participação.</p><div class="row">${field(p('guardian_name'), 'Nome do responsável', { value: val.guardian_name, id: `p${i}-gn` })}${field(p('guardian_cpf'), 'CPF do responsável', { value: val.guardian_cpf, id: `p${i}-gc` })}</div></div>
  <div class="row">${field(p('modality_id'), 'Modalidade / distância', { value: val.modality_id, required: true, id: `p${i}-mod`, options: [['', 'Selecione'], ...await Promise.all(mods.map(async (m) => { const l = await currentLot(ev.id, m.id); const full = (m.capacity != null && await counts.modality(m.id) >= m.capacity) || !l; return [m.id, `${m.name} — ${full ? 'indisponível' : `${l.name}: ${l.price_cents ? brl(l.price_cents) : 'gratuito'}`}`]; }))] })}
  ${kits.length ? field(p('kit_id'), 'Kit', { value: val.kit_id, required: true, id: `p${i}-kit`, options: [['', 'Selecione'], ...kits.map((k) => [k.id, `${k.name}${k.extra_price_cents ? ` (+ ${brl(k.extra_price_cents)})` : ''}`])] }) : ''}
  ${kits.some((k) => k.has_shirt) ? field(p('kit_size'), 'Tamanho da camiseta', { value: val.kit_size, id: `p${i}-size`, options: [['', 'Selecione'], ...[...new Set(sizeRows.filter((s) => sizeOk.has(`${s.kit_id}|${s.size}`)).map((s) => s.size))]] }) : ''}</div>
  ${field(p('team_name'), 'Equipe ou assessoria (opcional)', { value: val.team_name, id: `p${i}-team` })}
  ${allQs.length ? html`<div class="questions"><h3>Questionário do organizador</h3>${allQs.map((q) => {
    const name = `p[${i}][answers][q${q.id}]`; const lbl = `${q.label}${q.mn ? ` (somente ${q.mn})` : ''}`;
    const hint = q.purpose ? `Finalidade: ${q.purpose}` : undefined; const cur = v.answers?.[`q${q.id}`];
    if (q.type === 'select') return field(name, lbl, { options: [['', 'Selecione'], ...json(q.options, [])], value: cur, hint, required: !!q.required && !q.modality_id, id: `p${i}-q${q.id}` });
    if (q.type === 'checkbox') return html`<div class="field field-check"><input type="checkbox" id="p${i}-q${q.id}" name="${name}" value="sim" ${cur === 'sim' ? 'checked' : ''}><label for="p${i}-q${q.id}">${lbl}${q.required ? ' *' : ''}</label>${hint ? html`<small class="hint">${hint}</small>` : ''}</div>`;
    return field(name, lbl, { value: cur, hint, id: `p${i}-q${q.id}`, required: !!q.required && !q.modality_id });
  })}</div>` : ''}</fieldset>`;
}

r.get('/e/:slug/inscricao', requireUser, async (req, res) => {
  const ev = await loadPublicEvent(req);
  if (await publicStatus(ev) !== 'open') { res.flash('error', 'As inscrições deste evento não estão abertas.'); return res.redirect(303, `/e/${ev.slug}`); }
  const n = Math.max(1, Math.min(10, Number(req.query.n) || 1));
  res.page({ title: `Inscrição — ${ev.name}`, body: await inscricaoForm(req, ev, n) });
});
async function inscricaoForm(req, ev, n, { values = [], extrasV = {}, errors = [], coupon = '' } = {}) {
  const variants = await db.all('SELECT v.*, p.name, p.price_cents FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.event_id=? AND p.active=1', ev.id);
  return html`<section><p><a href="/e/${ev.slug}">← ${ev.name}</a></p><h1>Inscrição</h1><p>${fmtDate(ev.start_utc, ev.timezone)} · ${ev.city}/${ev.state}</p>
  ${errorsBox(errors)}
  <p>Inscrições neste pedido: ${[1, 2, 3, 4, 5].map((k) => (k === n ? html`<strong>${k}</strong> ` : html`<a href="?n=${k}">${k}</a> `))} ${tip('Inscrições em grupo: adicione vários participantes no mesmo pedido. Cupons de grupo exigem um mínimo de inscrições.')}</p>
  <form method="post" action="/e/${ev.slug}/inscricao?n=${n}" novalidate>${csrf(req)}
  ${Array.from({ length: n }, async (_, i) => await participantBlock(ev, i, req.user, values[i] || {}))}
  ${variants.length ? html`<fieldset class="card"><legend>Produtos extras (opcional)</legend><p class="muted">Itens adicionais com retirada junto ao kit. Não geram nova inscrição.</p>${await Promise.all(variants.map(async (v) => { const left = v.stock - await counts.variant(v.id); return field(`x[v${v.id}]`, `${v.name} — ${v.label} (${brl(v.price_cents)})${left <= 0 ? ' — esgotado' : ''}`, { type: 'number', value: extrasV[`v${v.id}`] || 0, attrs: `min="0" max="${Math.max(0, Math.min(10, left))}" ${left <= 0 ? 'disabled' : ''}`, id: `x-${v.id}` }); }))}</fieldset>` : ''}
  <fieldset class="card"><legend>Finalização</legend>${field('coupon', 'Cupom de desconto (opcional)', { value: coupon })}
  ${field('accept', raw(`Li e aceito o <a href="/e/${ev.slug}#regulamento" target="_blank">regulamento</a> (versão ${ev.regulation_version}) e a política de cancelamento do evento`), { type: 'checkbox', required: true })}
  <p class="muted">Ao continuar, sua vaga e estoque ficam reservados por ${ev.reservation_minutes} minutos enquanto você paga. A inscrição só é confirmada após validação do pagamento.</p>
  <button class="btn btn-lg btn-block">Revisar e reservar</button></fieldset></form></section>`;
}
r.post('/e/:slug/inscricao', requireUser, async (req, res) => {
  const ev = await loadPublicEvent(req);
  const n = Math.max(1, Math.min(10, Number(req.query.n) || 1));
  const raw0 = Array.isArray(req.body.p) ? req.body.p : Object.values(req.body.p || {});
  const parts = raw0.slice(0, n).map((p, i) => ({ ...p, self: i === 0, modality_id: Number(p.modality_id) || null, kit_id: Number(p.kit_id) || null, answers: p.answers || {} }));
  const extras = Object.entries(req.body.x || {}).map(([variant_id, qty]) => ({ variant_id: Number(String(variant_id).replace(/^v/, '')), qty: Number(qty) })).filter((x) => x.qty > 0);
  try {
    const order = await createOrder({ user: req.user, eventId: ev.id, participants: parts, extras, couponCode: req.body.coupon, acceptRegulation: !!req.body.accept, req });
    // atualiza perfil do atleta com dados informados para o participante 1 (se ausentes)
    const p0 = parts[0];
    await db.run('UPDATE users SET cpf=COALESCE(cpf,?), birth_date=COALESCE(birth_date,?), gender=COALESCE(gender,?) WHERE id=?', String(p0.cpf || '').replace(/\D/g, '') || null, p0.birth_date || null, p0.gender || null, req.user.id);
    res.redirect(303, `/pedido/${order.code}`);
  } catch (e) {
    if (!e.expose) throw e;
    res.status(e.status || 400).page({ title: `Inscrição — ${ev.name}`, body: await inscricaoForm(req, ev, n, { values: parts, extrasV: req.body.x || {}, errors: e.fields || [e.message], coupon: req.body.coupon }) });
  }
});

async function loadOrder(req) {
  const o = await db.one('SELECT * FROM orders WHERE code=?', req.params.code);
  if (!o || o.user_id !== req.user.id) throw new NotFound('Pedido não encontrado.');
  return o;
}
r.get('/pedido/:code', requireUser, async (req, res) => {
  await db.tx(async () => await expireStale());
  const o = await loadOrder(req);
  const ev = await db.one('SELECT * FROM events WHERE id=?', o.event_id);
  const regs = await db.all('SELECT g.*, m.name modality, c.name category, k.name kit, l.name lot FROM registrations g JOIN modalities m ON m.id=g.modality_id LEFT JOIN categories c ON c.id=g.category_id LEFT JOIN kits k ON k.id=g.kit_id LEFT JOIN lots l ON l.id=g.lot_id WHERE order_id=?', o.id);
  const items = await db.all('SELECT i.*, v.label, p.name FROM order_items i JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id WHERE i.order_id=?', o.id);
  const pays = await db.all('SELECT * FROM payments WHERE order_id=? ORDER BY id DESC', o.id);
  const st = ORDER_STATUS[o.status];
  res.page({ title: `Pedido ${o.code}`, body: html`<section class="card"><p><a href="/minha-conta">← Minhas inscrições</a></p><h1>Pedido ${o.code}</h1><p>${ev.name} · ${fmtDate(ev.start_utc, ev.timezone)}</p>
  <p>${badge(st[0], st[1])} ${o.kind === 'change' ? badge('Alteração de inscrição', 'info') : ''}</p>
  ${o.status === 'pending' ? html`<div class="alert alert-warn" role="status">Reserva válida até <strong>${fmtDateTime(o.expires_at, ev.timezone)}</strong> <span data-countdown="${o.expires_at}"></span>. Após esse horário, a vaga e o estoque são liberados.</div>` : ''}
  ${o.status === 'exception' ? html`<div class="alert alert-error">Seu pagamento foi recebido, mas precisa de análise (${o.exception_note}). O organizador entrará em contato; se não houver vaga, o valor será reembolsado.</div>` : ''}
  ${table(['Participante', 'Modalidade', 'Lote', 'Categoria', 'Kit', 'Valor', 'Situação'], regs.map((g) => [g.name, g.modality, g.lot || '—', g.category || '—', `${g.kit || '—'} ${g.kit_size || ''}`, brl(g.price_cents), g.status === 'confirmed' ? badge('Confirmada', 'ok') : g.status === 'reserved' ? badge('Reservada', 'warn') : badge(g.status, 'muted')]), { emptyMsg: o.kind === 'change' ? 'Pedido de alteração.' : 'Sem inscrições neste pedido.' })}
  ${items.length ? table(['Produto', 'Qtd.', 'Valor'], items.map((i) => [`${i.name} (${i.label})`, String(i.qty), brl(i.unit_price_cents * i.qty)])) : ''}
  <dl class="totals"><dt>Subtotal</dt><dd>${brl(o.subtotal_cents)}</dd>${o.discount_cents ? html`<dt>Desconto</dt><dd>− ${brl(o.discount_cents)}</dd>` : ''}${o.fee_cents ? html`<dt>Taxa de serviço</dt><dd>${brl(o.fee_cents)}</dd>` : ''}<dt>Total</dt><dd><strong>${brl(o.total_cents)}</strong></dd></dl>
  ${o.status === 'pending' && o.total_cents > 0 ? payBox(req, o) : ''}
  ${pays.length ? html`<h2>Pagamentos</h2>${table(['Transação', 'Meio', 'Valor', 'Situação', 'Atualizado'], pays.map((p) => [p.provider_payment_id, payments.METHOD_LABEL[p.method] || p.method || '—', brl(p.amount_cents), payments.PAY_LABEL[p.status] || p.status, fmtDateTime(p.updated_at, ev.timezone)]))}` : ''}
  ${['paid', 'free'].includes(o.status) ? html`<p><a class="btn" href="/minha-conta">Ver comprovante e QR Code do kit</a> <button class="btn btn-ghost" data-print>Imprimir comprovante</button></p>` : ''}</section>` });
});
const MODE_TAG = { simulator: 'Demonstração', test: 'Ambiente de testes', live: null };
function payBox(req, o) {
  const methods = payments.availableMethods();
  if (!methods.length) return html`<div class="alert alert-warn">Pagamentos ainda não estão habilitados nesta plataforma.</div>`;
  const current = methods.find((m) => o.provider === m.key || String(o.provider_ref || '').startsWith(`sim-${m.key}-`))?.key || methods[0].key;
  return html`<form method="post" action="/pedido/${o.code}/pagar" class="pay-box">${csrf(req)}
    <fieldset class="pay-methods"><legend>Como você quer pagar?</legend>
    ${methods.map((m) => html`<label class="pay-option pay-${m.key}"><input type="radio" name="meio" value="${m.key}" ${m.key === current ? 'checked' : ''}>
      <span class="pay-logo" aria-hidden="true">${m.label}</span><span class="pay-text"><strong>${m.label}</strong><small>${m.detail}</small></span>
      ${MODE_TAG[m.mode] ? html`<span class="badge badge-warn">${MODE_TAG[m.mode]}</span>` : ''}</label>`)}
    </fieldset>
    <button class="btn btn-lg btn-block">Pagar ${brl(o.total_cents)}</button>
    <p class="muted">Você será levado ao ambiente seguro do meio escolhido. A inscrição é confirmada assim que o pagamento for aprovado.</p></form>`;
}
r.post('/pedido/:code/pagar', requireUser, async (req, res) => {
  await db.tx(async () => await expireStale());
  const o = await loadOrder(req);
  if (o.status !== 'pending') throw new UserError('Este pedido não está aguardando pagamento.');
  const url = await payments.startCheckout(o, req.body.meio ? String(req.body.meio) : undefined);
  res.redirect(303, url);
});

// Retorno do PayPal após a aprovação: captura a ordem e aplica o estado lido no PayPal.
r.get('/pagamento/paypal/retorno', async (req, res) => {
  const token = String(req.query.token || '');
  const o = token && await db.one("SELECT * FROM orders WHERE provider='paypal' AND provider_ref=?", token);
  if (!o) throw new UserError('Pagamento do PayPal não encontrado.', 404);
  try {
    const captureId = await payments.providers.paypal.capture(token);
    if (captureId) await payments.processPayment('paypal', captureId);
  } catch (e) {
    console.error('[paypal] falha na captura', o.code, e.message);
    res.flash('warn', 'Recebemos o retorno do PayPal, mas a confirmação ainda está em andamento. Atualize esta página em instantes.');
  }
  res.redirect(303, `/pedido/${o.code}`);
});

// QR Code do kit: o conteúdo é um token aleatório, sem dados pessoais.
r.get('/k/:token', async (req, res) => {
  const g = await db.one('SELECT id, event_id FROM registrations WHERE qr_token=?', req.params.token);
  if (req.user && g) {
    const ev = await db.one('SELECT org_id FROM events WHERE id=?', g.event_id);
    const m = await require('../lib/orgs').membership(req.user.id, ev.org_id);
    if (m && require('../lib/orgs').can(m, 'kits', g.event_id)) return res.redirect(303, `/contexto/org:${ev.org_id}?volta=${encodeURIComponent(`/organizador/eventos/${g.event_id}/checkin?q=${req.params.token}`)}`);
  }
  res.page({ title: 'Código de retirada', body: html`<section class="card narrow"><h1>Código de retirada de kit</h1><p>Apresente este QR Code ao operador no ponto de retirada. A conferência é feita pela equipe autorizada do evento.</p></section>` });
});
module.exports = r;
module.exports.ORDER_STATUS = ORDER_STATUS;
