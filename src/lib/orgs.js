'use strict';
const db = require('../db');
const config = require('../config');
const { settings } = require('./core');
const { json, Forbidden, NotFound } = require('./util');

const ORG_STATUS = {
  onboarding: { label: 'Cadastro em andamento', tone: 'info' },
  email_pending: { label: 'E-mail pendente de confirmação', tone: 'warn' },
  verification_pending: { label: 'Verificação pendente', tone: 'warn' },
  correction_requested: { label: 'Correção solicitada', tone: 'danger' },
  active: { label: 'Ativo', tone: 'ok' },
  suspended: { label: 'Suspenso', tone: 'danger' },
};
const PERMS = {
  events: 'Eventos (criar e editar)',
  registrations: 'Inscritos e atendimento',
  finance: 'Financeiro e exportações',
  kits: 'Entrega de kits e check-in',
  timing: 'Cronometragem e resultados',
  communication: 'Comunicação com inscritos',
};

function ownerOf(orgId) { return db.one("SELECT u.* FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND m.role='owner'", orgId); }

/** Recalcula a situação da conta a partir dos fatos (e-mail, verificação). Não reativa suspensos. */
function refreshStatus(orgId) {
  const org = db.one('SELECT * FROM organizations WHERE id=?', orgId);
  if (!org || ['onboarding', 'suspended', 'correction_requested', 'active'].includes(org.status)) return org?.status;
  const owner = ownerOf(orgId);
  const next = !owner?.email_verified_at ? 'email_pending' : 'verification_pending';
  if (next !== org.status) db.run('UPDATE organizations SET status=? WHERE id=?', next, orgId);
  return next;
}

function memberships(userId) {
  return db.all('SELECT m.*, o.trade_name, o.legal_name, o.status org_status FROM org_members m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? ORDER BY m.created_at', userId);
}
function membership(userId, orgId) {
  const m = db.one('SELECT * FROM org_members WHERE user_id=? AND org_id=?', userId, orgId);
  if (!m) return null;
  return { ...m, permissions: m.role === 'owner' ? Object.keys(PERMS) : json(m.permissions, []), eventIds: m.event_ids ? json(m.event_ids, []) : null };
}
function can(member, perm, eventId) {
  if (!member) return false;
  if (member.role === 'owner') return true;
  if (!member.permissions.includes(perm)) return false;
  if (eventId != null && member.eventIds && !member.eventIds.includes(Number(eventId))) return false;
  return true;
}
function assertCan(member, perm, eventId) { if (!can(member, perm, eventId)) throw new Forbidden('Seu perfil não tem permissão para esta função neste evento.'); }

/** Busca evento garantindo o isolamento por organizador. */
function eventForOrg(eventId, orgId) {
  const ev = db.one('SELECT * FROM events WHERE id=? AND org_id=?', eventId, orgId);
  if (!ev) throw new NotFound('Evento não encontrado nesta organização.');
  return ev;
}

/** Requisitos de ativação para publicar / receber. */
function activation(org) {
  const s = settings();
  const owner = ownerOf(org.id);
  const docs = db.all('SELECT kind, status FROM documents WHERE org_id=?', org.id);
  const items = {
    email: !!owner?.email_verified_at,
    company: !!(org.legal_name && org.support_email && org.support_phone),
    documents: !s.require_identity_document || docs.some((d) => d.kind === 'identity'),
    verified: org.status === 'active',
    payments: org.mp_status === 'test' || org.mp_status === 'live',
  };
  const canPublish = org.status !== 'suspended' && items.email && items.company && (!s.publish_requires_active || items.verified);
  const canReceive = canPublish && items.payments && config.mp.canCharge && org.status === 'active';
  return { items, canPublish, canReceive };
}

module.exports = { ORG_STATUS, PERMS, ownerOf, refreshStatus, memberships, membership, can, assertCan, eventForOrg, activation };
