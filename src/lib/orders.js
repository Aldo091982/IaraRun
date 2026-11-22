'use strict';
const db = require('../db');
const { expireStale, counts, currentLot, publicStatus } = require('./events');
const { isCpf, digits, isEmail } = require('./docs');
const { UserError, randomToken, code, nowIso, addMinutes, ageAt, json } = require('./util');
const { sendMail, audit } = require('./core');

function assignCategory(eventId, modalityId, gender, birth, eventStartUtc) {
  const age = ageAt(birth, eventStartUtc);
  const cats = db.all('SELECT * FROM categories WHERE event_id=? AND (modality_id IS NULL OR modality_id=?) ORDER BY (min_age IS NULL), (modality_id IS NULL), id', eventId, modalityId);
  return cats.find((c) => (c.gender === 'any' || c.gender === gender) && (c.min_age == null || (age != null && age >= c.min_age)) && (c.max_age == null || (age != null && age <= c.max_age))) || null;
}

function questionsFor(eventId, modalityId) {
  return db.all('SELECT * FROM questions WHERE event_id=? AND active=1 AND (modality_id IS NULL OR modality_id=?) ORDER BY sort, id', eventId, modalityId);
}

function validateParticipant(ev, p, idx) {
  const label = `Participante ${idx + 1}`;
  const errs = [];
  if (!p.name || p.name.trim().length < 3) errs.push(`${label}: informe o nome completo.`);
  if (!isCpf(p.cpf)) errs.push(`${label}: CPF inválido.`);
  if (!p.birth_date || !/^\d{4}-\d{2}-\d{2}$/.test(p.birth_date)) errs.push(`${label}: informe a data de nascimento.`);
  if (!['M', 'F'].includes(p.gender)) errs.push(`${label}: informe o sexo para classificação por categoria.`);
  if (p.email && !isEmail(p.email)) errs.push(`${label}: e-mail inválido.`);
  const age = ageAt(p.birth_date, ev.start_utc);
  if (age != null && (age < 0 || age > 110)) errs.push(`${label}: data de nascimento inválida.`);
  if (age != null && age < 18) {
    if (!p.guardian_name || p.guardian_name.trim().length < 3) errs.push(`${label}: menor de idade — informe o nome do responsável legal.`);
    if (!isCpf(p.guardian_cpf)) errs.push(`${label}: menor de idade — informe CPF válido do responsável.`);
  }
  return errs;
}

/**
 * Cria pedido com reserva temporária de vagas e estoque.
 * Executa em transação serializada: impede venda acima da capacidade sob concorrência.
 */
function createOrder({ user, eventId, participants, extras = [], couponCode, acceptRegulation, req }) {
  return db.tx(() => {
    expireStale();
    const ev = db.one('SELECT * FROM events WHERE id=?', eventId);
    if (!ev || publicStatus(ev) !== 'open') throw new UserError('As inscrições deste evento não estão abertas.');
    if (!acceptRegulation) throw new UserError('É necessário ler e aceitar o regulamento.');
    if (!participants.length && !extras.length) throw new UserError('Selecione ao menos uma inscrição.');
    if (participants.length > 10) throw new UserError('Máximo de 10 inscrições por pedido.');
    const errs = participants.flatMap((p, i) => validateParticipant(ev, p, i));
    const cpfs = participants.map((p) => digits(p.cpf));
    if (!ev.allow_duplicate && new Set(cpfs).size !== cpfs.length) errs.push('O mesmo CPF aparece mais de uma vez no pedido.');
    if (errs.length) throw new UserError(errs.join(' '), 400, errs);

    const now = nowIso();
    const order = { code: code('P'), subtotal: 0 };
    const r = db.run('INSERT INTO orders(code,user_id,event_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?)',
      order.code, user.id, ev.id, 'pending', addMinutes(ev.reservation_minutes || 15), now);
    const orderId = Number(r.lastInsertRowid);
    let regSubtotal = 0;

    participants.forEach((p, i) => {
      const label = `Participante ${i + 1}`;
      const mod = db.one('SELECT * FROM modalities WHERE id=? AND event_id=?', p.modality_id, ev.id);
      if (!mod) throw new UserError(`${label}: modalidade inválida.`);
      if (ev.capacity != null && counts.event(ev.id) >= ev.capacity) throw new UserError('Vagas do evento esgotadas.', 409);
      if (mod.capacity != null && counts.modality(mod.id) >= mod.capacity) throw new UserError(`Vagas esgotadas para ${mod.name}.`, 409);
      const lot = currentLot(ev.id, mod.id, now);
      if (!lot) throw new UserError(`Não há lote disponível para ${mod.name}.`, 409);
      if (!ev.allow_duplicate) {
        const dup = db.one("SELECT 1 FROM registrations WHERE event_id=? AND cpf=? AND status IN ('reserved','confirmed')", ev.id, digits(p.cpf));
        if (dup) throw new UserError(`${label}: já existe inscrição ativa ou reservada para este CPF neste evento.`, 409);
      }
      let kit = null;
      if (p.kit_id) {
        kit = db.one('SELECT * FROM kits WHERE id=? AND event_id=?', p.kit_id, ev.id);
        if (!kit) throw new UserError(`${label}: kit inválido.`);
        if (kit.has_shirt) {
          const sz = db.one('SELECT * FROM kit_sizes WHERE kit_id=? AND size=?', kit.id, p.kit_size || '');
          if (!sz) throw new UserError(`${label}: escolha o tamanho da camiseta.`);
          if (counts.size(kit.id, sz.size) >= sz.stock) throw new UserError(`${label}: camiseta tamanho ${sz.size} esgotada para o kit ${kit.name}.`, 409);
        }
      } else if (db.one('SELECT COUNT(*) n FROM kits WHERE event_id=?', ev.id).n > 0) {
        throw new UserError(`${label}: escolha o kit.`);
      }
      // Questionário: valida obrigatórias e preserva a versão respondida
      const qs = questionsFor(ev.id, mod.id);
      const answers = {};
      for (const q of qs) {
        const v = p.answers?.[`q${q.id}`] ?? p.answers?.[q.id];
        const empty = v == null || v === '' || (q.type === 'checkbox' && v !== 'sim');
        if (q.required && empty) throw new UserError(`${label}: responda "${q.label}".`);
        if (q.type === 'select' && v && !json(q.options, []).includes(v)) throw new UserError(`${label}: opção inválida em "${q.label}".`);
        if (!empty) answers[q.id] = { label: q.label, version: q.version, value: String(v).slice(0, 500) };
      }
      const cat = assignCategory(ev.id, mod.id, p.gender, p.birth_date, ev.start_utc);
      const price = lot.price_cents + (kit?.extra_price_cents || 0);
      regSubtotal += price;
      db.run(`INSERT INTO registrations(order_id,event_id,modality_id,lot_id,category_id,kit_id,kit_size,user_id,buyer_user_id,name,email,cpf,birth_date,gender,guardian_name,guardian_cpf,team_name,price_cents,status,qr_token,regulation_version,regulation_accepted_at,answers)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?)`,
        orderId, ev.id, mod.id, lot.id, cat?.id ?? null, kit?.id ?? null, kit?.has_shirt ? p.kit_size : null, p.self ? user.id : (p.user_id ?? null), user.id,
        p.name.trim(), (p.email || (p.self ? user.email : '')).trim() || null, digits(p.cpf), p.birth_date, p.gender, p.guardian_name || null, p.guardian_cpf ? digits(p.guardian_cpf) : null,
        p.team_name?.trim() || null, price, randomToken(18), ev.regulation_version, now, JSON.stringify(answers));
    });

    let extrasSubtotal = 0;
    for (const x of extras) {
      const qty = Math.max(0, Math.min(10, Number(x.qty) || 0));
      if (!qty) continue;
      const v = db.one('SELECT v.*, p.price_cents, p.name FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=? AND p.event_id=? AND p.active=1', x.variant_id, ev.id);
      if (!v) throw new UserError('Produto inválido.');
      if (counts.variant(v.id) + qty > v.stock) throw new UserError(`Estoque insuficiente de ${v.name} (${v.label}).`, 409);
      extrasSubtotal += v.price_cents * qty;
      db.run("INSERT INTO order_items(order_id,variant_id,qty,unit_price_cents,status) VALUES(?,?,?,?,'reserved')", orderId, v.id, qty, v.price_cents);
    }

    // Cupom (aplicado sobre inscrições)
    let discount = 0, couponId = null;
    if (couponCode) {
      const c = db.one('SELECT * FROM coupons WHERE event_id=? AND code=? AND active=1', ev.id, couponCode.trim());
      if (!c) throw new UserError('Cupom inválido ou inativo.');
      if (participants.length < c.min_group) throw new UserError(`Este cupom exige no mínimo ${c.min_group} inscrições no mesmo pedido.`);
      const used = db.one("SELECT COUNT(*) n FROM orders WHERE coupon_id=? AND status IN ('pending','paid','free') AND id<>?", c.id, orderId).n;
      if (c.max_uses != null && used >= c.max_uses) throw new UserError('Este cupom atingiu o limite de usos.');
      discount = c.percent_off ? Math.round(regSubtotal * c.percent_off / 100) : Math.min(regSubtotal, c.amount_off_cents || 0);
      couponId = c.id;
    }
    const subtotal = regSubtotal + extrasSubtotal;
    const base = subtotal - discount;
    const fee = Math.round(base * (ev.fee_percent || 0) / 100);
    const total = base + (ev.fee_payer === 'athlete' ? fee : 0);
    db.run('UPDATE orders SET subtotal_cents=?, discount_cents=?, fee_cents=?, organizer_fee_cents=?, total_cents=?, coupon_id=? WHERE id=?',
      subtotal, discount, ev.fee_payer === 'athlete' ? fee : 0, ev.fee_payer === 'organizer' ? fee : 0, total, couponId, orderId);
    audit(req, 'order.created', { entity: 'order', entityId: orderId, detail: { code: order.code, total } });
    if (total === 0) confirmOrder(orderId, { free: true });
    return db.one('SELECT * FROM orders WHERE id=?', orderId);
  });
}

function assignBib(reg) {
  const max = db.one("SELECT MAX(CAST(bib AS INTEGER)) m FROM registrations WHERE event_id=? AND bib GLOB '[0-9]*'", reg.event_id).m || 0;
  db.run('UPDATE registrations SET bib=? WHERE id=?', String(max + 1), reg.id);
}

/**
 * Confirma pedido após pagamento validado no servidor (ou fluxo gratuito). Idempotente.
 * Pagamento aprovado após expiração: tenta recuperar a vaga sem ultrapassar capacidade;
 * se não houver, registra exceção para resolução (ex.: reembolso).
 */
function confirmOrder(orderId, { free = false } = {}) {
  return db.tx(() => {
    const o = db.one('SELECT * FROM orders WHERE id=?', orderId);
    if (!o) return { ok: false, reason: 'not_found' };
    if (['paid', 'free'].includes(o.status)) return { ok: true, already: true };
    if (['refunded', 'cancelled', 'exception'].includes(o.status)) return { ok: false, reason: o.status };
    const now = nowIso();
    if (o.kind === 'change') return applyChange(o);
    const late = o.status === 'expired' || (o.expires_at && o.expires_at <= now);
    if (late) {
      const ev = db.one('SELECT * FROM events WHERE id=?', o.event_id);
      const regs = db.all('SELECT * FROM registrations WHERE order_id=?', o.id);
      const items = db.all('SELECT * FROM order_items WHERE order_id=?', o.id);
      const problems = [];
      if (ev.capacity != null && counts.event(ev.id, o.id) + regs.length > ev.capacity) problems.push('capacidade do evento');
      for (const g of regs) {
        const m = db.one('SELECT * FROM modalities WHERE id=?', g.modality_id);
        if (m.capacity != null && counts.modality(m.id, o.id) + regs.filter((x) => x.modality_id === m.id).length > m.capacity) problems.push(`vagas de ${m.name}`);
        const l = db.one('SELECT * FROM lots WHERE id=?', g.lot_id);
        if (l?.quantity != null && counts.lot(l.id, o.id) + regs.filter((x) => x.lot_id === l.id).length > l.quantity) problems.push(`lote ${l.name}`);
        if (g.kit_size) { const s = db.one('SELECT stock FROM kit_sizes WHERE kit_id=? AND size=?', g.kit_id, g.kit_size); if (counts.size(g.kit_id, g.kit_size, o.id) + 1 > s.stock) problems.push(`camiseta ${g.kit_size}`); }
        if (!ev.allow_duplicate && db.one("SELECT 1 FROM registrations WHERE event_id=? AND cpf=? AND status IN ('reserved','confirmed') AND order_id<>?", ev.id, g.cpf, o.id)) problems.push('CPF já inscrito');
      }
      for (const it of items) { const v = db.one('SELECT stock FROM product_variants WHERE id=?', it.variant_id); if (counts.variant(it.variant_id, o.id) + it.qty > v.stock) problems.push('estoque de produto'); }
      if (problems.length) {
        const note = `Pagamento aprovado após expiração da reserva; sem disponibilidade: ${[...new Set(problems)].join(', ')}.`;
        db.run("UPDATE orders SET status='exception', exception_note=?, updated_at=? WHERE id=?", note, now, o.id);
        db.run('INSERT INTO payment_exceptions(order_id,reason) VALUES(?,?)', o.id, note);
        audit(null, 'order.exception', { entity: 'order', entityId: o.id, detail: { note } });
        return { ok: false, reason: 'exception' };
      }
    }
    db.run('UPDATE orders SET status=?, paid_at=?, updated_at=? WHERE id=?', free ? 'free' : 'paid', now, now, o.id);
    db.run("UPDATE registrations SET status='confirmed', confirmed_at=? WHERE order_id=? AND status IN ('reserved','expired')", now, o.id);
    db.run("UPDATE order_items SET status='paid' WHERE order_id=? AND status IN ('reserved','expired')", o.id);
    for (const g of db.all('SELECT * FROM registrations WHERE order_id=? AND bib IS NULL', o.id)) assignBib(g);
    const u = db.one('SELECT * FROM users WHERE id=?', o.user_id);
    const ev = db.one('SELECT name FROM events WHERE id=?', o.event_id);
    sendMail(u.email, `Inscrição confirmada — ${ev.name}`, `Olá, ${u.name}! Seu pedido ${o.code} foi confirmado${free ? ' (evento gratuito)' : ' após validação do pagamento'}. Acesse Minhas inscrições para ver o comprovante e o QR Code de retirada do kit.`);
    audit(null, 'order.confirmed', { entity: 'order', entityId: o.id, userId: o.user_id, detail: { free, late: !!late } });
    return { ok: true };
  });
}

/** Alteração paga (menu de serviços): só efetiva após confirmação; a inscrição original é preservada até lá. */
function applyChange(o) {
  const g = db.one('SELECT * FROM registrations WHERE id=?', o.related_registration_id);
  const ch = json(o.change_payload, {});
  const now = nowIso();
  const fail = (why) => {
    db.run("UPDATE orders SET status='exception', exception_note=?, updated_at=? WHERE id=?", why, now, o.id);
    db.run('INSERT INTO payment_exceptions(order_id,reason) VALUES(?,?)', o.id, why);
    return { ok: false, reason: 'exception' };
  };
  if (!g || g.status !== 'confirmed') return fail('Inscrição original não está confirmada.');
  if (ch.modality_id) {
    const m = db.one('SELECT * FROM modalities WHERE id=?', ch.modality_id);
    if (m.capacity != null && counts.modality(m.id) >= m.capacity) return fail(`Sem vagas em ${m.name} no momento da confirmação.`);
    const cat = assignCategory(g.event_id, m.id, g.gender, g.birth_date, db.one('SELECT start_utc FROM events WHERE id=?', g.event_id).start_utc);
    db.run('UPDATE registrations SET modality_id=?, lot_id=COALESCE(?,lot_id), category_id=? WHERE id=?', m.id, ch.lot_id ?? null, cat?.id ?? null, g.id);
  }
  if (ch.kit_size) {
    const s = db.one('SELECT stock FROM kit_sizes WHERE kit_id=? AND size=?', g.kit_id, ch.kit_size);
    if (!s || counts.size(g.kit_id, ch.kit_size) >= s.stock) return fail(`Camiseta ${ch.kit_size} sem estoque.`);
    db.run('UPDATE registrations SET kit_size=? WHERE id=?', ch.kit_size, g.id);
  }
  db.run("UPDATE orders SET status='paid', paid_at=?, updated_at=? WHERE id=?", now, now, o.id);
  audit(null, 'registration.changed', { entity: 'registration', entityId: g.id, detail: ch });
  return { ok: true };
}

/** Cancela inscrição (após decisão de reembolso ou cancelamento gratuito). Libera vaga e estoque. */
function cancelRegistration(regId, reason = 'cancelled') {
  return db.tx(() => {
    const g = db.one('SELECT * FROM registrations WHERE id=?', regId);
    if (!g || !['confirmed', 'reserved'].includes(g.status)) return false;
    db.run('UPDATE registrations SET status=?, cancelled_at=? WHERE id=?', reason === 'refunded' ? 'refunded' : 'cancelled', nowIso(), regId);
    const remaining = db.one("SELECT COUNT(*) n FROM registrations WHERE order_id=? AND status IN ('confirmed','reserved')", g.order_id).n;
    if (!remaining) db.run("UPDATE order_items SET status='cancelled' WHERE order_id=? AND status IN ('reserved','paid') AND picked_up_at IS NULL", g.order_id);
    return true;
  });
}

module.exports = { createOrder, confirmOrder, cancelRegistration, assignCategory, questionsFor, validateParticipant };
