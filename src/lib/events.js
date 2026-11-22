'use strict';
const db = require('../db');
const config = require('../config');
const { activation } = require('./orgs');
const { nowIso } = require('./util');

const ACTIVE_REG = "('reserved','confirmed')";

/** Libera reservas vencidas (vagas, estoque de kits e produtos). Chamado dentro de transações. */
function expireStale(now = nowIso()) {
  const stale = db.all("SELECT id FROM orders WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= ?", now);
  for (const o of stale) {
    db.run("UPDATE orders SET status='expired', updated_at=? WHERE id=?", now, o.id);
    db.run("UPDATE registrations SET status='expired' WHERE order_id=? AND status='reserved'", o.id);
    db.run("UPDATE order_items SET status='expired' WHERE order_id=? AND status='reserved'", o.id);
  }
  return stale.length;
}

const counts = {
  event: (eventId, excludeOrder = 0) => db.one(`SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status IN ${ACTIVE_REG} AND order_id<>?`, eventId, excludeOrder).n,
  modality: (mid, excludeOrder = 0) => db.one(`SELECT COUNT(*) n FROM registrations WHERE modality_id=? AND status IN ${ACTIVE_REG} AND order_id<>?`, mid, excludeOrder).n,
  lot: (lid, excludeOrder = 0) => db.one(`SELECT COUNT(*) n FROM registrations WHERE lot_id=? AND status IN ${ACTIVE_REG} AND order_id<>?`, lid, excludeOrder).n,
  size: (kitId, size, excludeOrder = 0) => db.one(`SELECT COUNT(*) n FROM registrations WHERE kit_id=? AND kit_size=? AND status IN ${ACTIVE_REG} AND order_id<>?`, kitId, size, excludeOrder).n,
  variant: (vid, excludeOrder = 0) => db.one("SELECT COALESCE(SUM(qty),0) n FROM order_items WHERE variant_id=? AND status IN ('reserved','paid') AND order_id<>?", vid, excludeOrder).n,
};

/** Lote vigente para a modalidade: primeiro por ordem cujo período cobre agora e que não esgotou. */
function currentLot(eventId, modalityId, now = nowIso()) {
  const lots = db.all('SELECT * FROM lots WHERE event_id=? AND (modality_id IS NULL OR modality_id=?) ORDER BY sort, id', eventId, modalityId);
  for (const l of lots) {
    if (l.starts_utc && l.starts_utc > now) continue;
    if (l.ends_utc && l.ends_utc <= now) continue;
    if (l.quantity != null && counts.lot(l.id) >= l.quantity) continue;
    return l;
  }
  return null;
}
function nextLot(eventId, now = nowIso()) {
  return db.one('SELECT * FROM lots WHERE event_id=? AND starts_utc > ? ORDER BY starts_utc LIMIT 1', eventId, now);
}

const PUBLIC_STATUS = {
  draft: { label: 'Rascunho privado', tone: 'muted' },
  open: { label: 'Inscrições abertas', tone: 'ok' },
  soon: { label: 'Inscrições em breve', tone: 'info' },
  closed: { label: 'Inscrições encerradas', tone: 'muted' },
  soldout: { label: 'Esgotado', tone: 'danger' },
  cancelled: { label: 'Evento cancelado', tone: 'danger' },
  completed: { label: 'Evento concluído', tone: 'muted' },
};
function publicStatus(ev, now = nowIso()) {
  if (ev.status === 'draft') return 'draft';
  if (ev.status === 'cancelled') return 'cancelled';
  if (ev.status === 'completed' || (ev.start_utc && ev.start_utc < new Date(Date.now() - 86400000).toISOString())) return 'completed';
  if (ev.status === 'closed') return 'closed';
  if (ev.capacity != null && counts.event(ev.id) >= ev.capacity) return 'soldout';
  const mods = db.all('SELECT * FROM modalities WHERE event_id=?', ev.id);
  const anyLot = mods.some((m) => currentLot(ev.id, m.id, now) && (m.capacity == null || counts.modality(m.id) < m.capacity));
  if (anyLot) return 'open';
  if (nextLot(ev.id, now)) return 'soon';
  const allModsFull = mods.length && mods.every((m) => m.capacity != null && counts.modality(m.id) >= m.capacity);
  const lotsLeft = db.all('SELECT * FROM lots WHERE event_id=? AND (ends_utc IS NULL OR ends_utc > ?)', ev.id, now);
  if (allModsFull || (lotsLeft.length && lotsLeft.every((l) => l.quantity != null && counts.lot(l.id) >= l.quantity))) return 'soldout';
  return 'closed';
}

function isPaidEvent(eventId) {
  return !!db.one('SELECT 1 FROM lots WHERE event_id=? AND price_cents>0 UNION SELECT 1 FROM kits WHERE event_id=? AND extra_price_cents>0 UNION SELECT 1 FROM products WHERE event_id=? AND active=1', eventId, eventId, eventId);
}

/** Pendências que bloqueiam a publicação, com link de correção. */
function publishChecklist(ev, org) {
  const base = `/organizador/eventos/${ev.id}/editar`;
  const p = [];
  const add = (ok, msg, step) => { if (!ok) p.push({ msg, href: `${base}?etapa=${step}` }); };
  add(ev.name && ev.description && ev.description.length >= 30, 'Informe nome e descrição (mínimo 30 caracteres).', 1);
  add(ev.start_local && ev.start_utc, 'Informe data, horário e fuso do evento.', 1);
  add(ev.start_utc && ev.start_utc > nowIso(), 'A data do evento precisa estar no futuro.', 1);
  add(ev.city && ev.state && ev.address, 'Informe endereço, cidade e estado.', 2);
  const mods = db.all('SELECT * FROM modalities WHERE event_id=?', ev.id);
  add(mods.length > 0, 'Cadastre ao menos uma modalidade/distância.', 2);
  add(db.one('SELECT COUNT(*) n FROM categories WHERE event_id=?', ev.id).n > 0, 'Cadastre ao menos uma categoria (ex.: Geral).', 3);
  const lots = db.all('SELECT * FROM lots WHERE event_id=?', ev.id);
  add(lots.length > 0, 'Cadastre ao menos um lote com preço e período.', 4);
  for (const m of mods) add(lots.some((l) => l.modality_id == null || l.modality_id === m.id), `A modalidade "${m.name}" não possui lote.`, 4);
  for (const k of db.all('SELECT * FROM kits WHERE event_id=? AND has_shirt=1', ev.id)) add(db.one('SELECT COUNT(*) n FROM kit_sizes WHERE kit_id=? AND stock>0', k.id).n > 0, `O kit "${k.name}" não tem estoque de camisetas.`, 5);
  add(ev.regulation && ev.regulation.length >= 50, 'Adicione o regulamento (mínimo 50 caracteres).', 6);
  add(ev.cancel_policy, 'Informe a política de cancelamento e reembolso.', 6);
  add(ev.kit_pickup_info, 'Informe local e horário de retirada dos kits.', 7);
  add(ev.support_email && ev.support_phone, 'Informe e-mail e telefone de atendimento do evento.', 7);
  const act = activation(org);
  if (!act.canPublish) p.push({ msg: 'A conta do organizador ainda não atende aos requisitos de ativação para publicar.', href: '/organizador' });
  if (isPaidEvent(ev.id)) {
    if (!act.items.payments) p.push({ msg: 'Evento pago: configure o recebimento pelo Mercado Pago.', href: '/organizador/recebimentos' });
    else if (!config.mp.canCharge) p.push({ msg: 'Recebimentos indisponíveis neste ambiente (credenciais ou modelo de recebimento pendentes).', href: '/organizador/recebimentos' });
  }
  return p;
}

function eventStats(eventId) {
  return db.one(`SELECT
    (SELECT COUNT(*) FROM registrations WHERE event_id=@e AND status='confirmed') confirmed,
    (SELECT COUNT(*) FROM registrations WHERE event_id=@e AND status='reserved') reserved,
    (SELECT COUNT(*) FROM registrations WHERE event_id=@e AND status IN ('cancelled','refunded')) cancelled,
    (SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE event_id=@e AND status IN ('paid','refunded','partially_refunded')) gross,
    (SELECT COUNT(*) FROM requests r JOIN registrations g ON g.id=r.registration_id WHERE g.event_id=@e AND r.status='open') open_requests,
    (SELECT COUNT(*) FROM kit_pickups k JOIN registrations g ON g.id=k.registration_id WHERE g.event_id=@e) kits_delivered`, { e: eventId });
}

module.exports = { expireStale, counts, currentLot, nextLot, publicStatus, PUBLIC_STATUS, isPaidEvent, publishChecklist, eventStats, ACTIVE_REG };
