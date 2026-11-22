'use strict';
const fs = require('node:fs');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { html, raw, brl, fmtDateTime, json, UserError, NotFound, nowIso } = require('../lib/util');
const { fmtCnpj, orgDoc } = require('../lib/docs');
const { ORG_STATUS, ownerOf, refreshStatus } = require('../lib/orgs');
const { publicStatus, PUBLIC_STATUS } = require('../lib/events');
const { MODE_LABEL } = require('../lib/payments');
const { audit, sendMail, settings, DEFAULT_SETTINGS } = require('../lib/core');
const { requireAdmin, privatePath } = require('../lib/guards');
const { csrf, field, badge, table, tip } = require('../views/layout');

const r = express.Router();
r.use(requireAdmin);
const nav = (active) => html`<h1>Administração</h1><nav class="subnav" aria-label="Administração">${[['/admin', 'Visão geral'], ['/admin/organizadores', 'Organizadores'], ['/admin/usuarios', 'Usuários'], ['/admin/eventos', 'Eventos'], ['/admin/suporte', 'Suporte'], ['/admin/parametros', 'Parâmetros'], ['/admin/integracoes', 'Integrações'], ['/admin/mensagens', 'Mensagens'], ['/admin/auditoria', 'Auditoria']].map(([h, l]) => html`<a href="${h}" ${active === h ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;

r.get('/', async (req, res) => {
  const c = await db.one(`SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM organizations) orgs, (SELECT COUNT(*) FROM organizations WHERE status='verification_pending') pending,
    (SELECT COUNT(*) FROM events WHERE status='published') published, (SELECT COUNT(*) FROM registrations WHERE status='confirmed') regs, (SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status IN ('paid','partially_refunded')) gross,
    (SELECT COUNT(*) FROM support_tickets WHERE status='open') tickets, (SELECT COUNT(*) FROM payment_exceptions WHERE status='open') exc`);
  res.page({ title: 'Administração', wide: true, body: html`${nav('/admin')}<section class="kpis">${[['Usuários', c.users], ['Organizadores', c.orgs], ['Verificações pendentes', c.pending], ['Eventos publicados', c.published], ['Inscrições confirmadas', c.regs], ['Volume confirmado', brl(c.gross)], ['Suporte aberto', c.tickets], ['Exceções de pagamento', c.exc]].map(([l, v]) => html`<div class="kpi"><span>${l}</span><strong>${String(v)}</strong></div>`)}</section>
  ${c.pending ? html`<p><a class="btn" href="/admin/organizadores?status=verification_pending">Analisar ${c.pending} verificação(ões)</a></p>` : ''}` });
});

r.get('/organizadores', async (req, res) => {
  const st = req.query.status;
  const orgs = await db.all(`SELECT o.*, (SELECT COUNT(*) FROM documents d WHERE d.org_id=o.id AND d.status='submitted') docs FROM organizations o ${st ? 'WHERE o.status=?' : ''} ORDER BY o.id DESC`, ...(st ? [st] : []));
  res.page({ title: 'Organizadores', wide: true, body: html`${nav('/admin/organizadores')}<form class="inline-filters filters">${field('status', 'Situação', { value: st, options: [['', 'Todas'], ...Object.entries(ORG_STATUS).map(([k, v]) => [k, v.label])] })}<button class="btn">Filtrar</button></form>
  ${table(['Organizador', 'Documento', 'Origem dos dados', 'Situação', 'Docs a analisar', 'Recebimento', ''], orgs.map((o) => [o.trade_name || o.legal_name || '—', orgDoc(o), o.cnpj_source === 'manual' ? badge('Manual', 'warn') : badge('Consulta cadastral', 'info'), badge(ORG_STATUS[o.status].label, ORG_STATUS[o.status].tone), String(o.docs), o.mp_status, html`<a href="/admin/organizadores/${o.id}">Analisar</a>`]))}` });
});
r.get('/organizadores/:id', async (req, res) => {
  const o = await db.one('SELECT * FROM organizations WHERE id=?', Number(req.params.id)); if (!o) throw new NotFound();
  const owner = await ownerOf(o.id); const a = json(o.address, {});
  const docs = await db.all('SELECT d.*, u.name reviewer FROM documents d LEFT JOIN users u ON u.id=d.reviewed_by WHERE org_id=? ORDER BY id DESC', o.id);
  const reqs = await db.all("SELECT a.*, u.name, u.email FROM org_access_requests a JOIN users u ON u.id=a.user_id WHERE a.org_id=? AND a.status='pending'", o.id);
  const hist = await db.all("SELECT l.*, u.name FROM audit_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.org_id=? AND (l.action ILIKE 'admin.%' OR l.action ILIKE 'document.%') ORDER BY l.id DESC LIMIT 30", o.id);
  res.page({ title: o.trade_name, wide: true, body: html`${nav('/admin/organizadores')}<section class="card"><h2>${o.trade_name} ${badge(ORG_STATUS[o.status].label, ORG_STATUS[o.status].tone)}</h2>
  <dl class="defs"><dt>${o.person_type === 'pf' ? 'Nome completo' : 'Razão social'}</dt><dd>${o.legal_name}</dd><dt>${o.person_type === 'pf' ? 'Tipo' : 'Documento'}</dt><dd>${o.person_type === 'pf' ? 'Pessoa física — ' : ''}${orgDoc(o)} — ${o.cnpj_source === 'manual' ? 'informado manualmente: conferir em fonte oficial' : `${o.cnpj_source} em ${fmtDateTime(o.cnpj_checked_at)}`}${o.cnpj_status ? ` · ${o.cnpj_status}` : ''}</dd>
  <dt>Endereço</dt><dd>${a.street || ''} ${a.number || ''} ${a.district || ''} ${a.city}/${a.state} ${a.zip || ''}</dd><dt>Responsável</dt><dd>${owner?.name} — ${owner?.email} ${owner?.email_verified_at ? badge('e-mail confirmado', 'ok') : badge('e-mail pendente', 'warn')}</dd>
  <dt>Atendimento</dt><dd>${o.support_email} · ${o.support_phone}</dd></dl></section>
  <section class="card"><h2>Documentos (acesso registrado)</h2>${tip('Abrir um documento gera registro de auditoria. "Enviado" não é "verificado": marque como verificado somente após conferência.')}
  ${table(['Tipo', 'Arquivo', 'Situação', 'Análise', ''], docs.map((d) => [d.kind === 'identity' ? 'Documento do responsável' : 'Comprovante de vínculo', html`<a href="/admin/documentos/${d.id}" target="_blank" rel="noopener">${d.original_name}</a>`, d.status, d.reviewed_at ? `${d.reviewer} em ${fmtDateTime(d.reviewed_at)}${d.review_note ? ` — ${d.review_note}` : ''}` : '—',
    html`<form method="post" action="/admin/documentos/${d.id}" class="inline">${csrf(req)}<input name="note" placeholder="Observação" aria-label="Observação"> <button name="decisao" value="verified" class="btn btn-sm">Verificado</button> <button name="decisao" value="rejected" class="btn btn-sm btn-ghost">Recusar</button></form>`]))}</section>
  <section class="card"><h2>Decisão sobre a conta</h2><form method="post" action="/admin/organizadores/${o.id}/decisao">${csrf(req)}${field('note', 'Justificativa / orientação ao organizador', { type: 'textarea' })}
  <button name="decisao" value="active" class="btn">Aprovar (ativar)</button> <button name="decisao" value="correction_requested" class="btn btn-ghost">Solicitar correção</button> <button name="decisao" value="suspended" class="btn btn-danger">Suspender</button> ${o.status === 'suspended' ? html`<button name="decisao" value="reactivate" class="btn btn-ghost">Reativar</button>` : ''}</form>
  ${o.mp_status !== 'live' && config.mp.mode === 'mp_live' ? html`<form method="post" action="/admin/organizadores/${o.id}/recebimento" class="inline">${csrf(req)}<button class="btn btn-ghost btn-sm">Habilitar recebimento em produção (contrato confirmado)</button></form>` : ''}</section>
  ${reqs.length ? html`<section class="card"><h2>Solicitações de acesso</h2>${table(['Pessoa', 'Mensagem', ''], reqs.map((x) => [`${x.name} (${x.email})`, x.message, html`<form method="post" action="/admin/acessos/${x.id}" class="inline">${csrf(req)}<button name="decisao" value="approve" class="btn btn-sm">Aprovar como colaborador</button> <button name="decisao" value="transfer" class="btn btn-sm btn-ghost">Tornar responsável</button> <button name="decisao" value="deny" class="btn btn-sm btn-ghost">Recusar</button></form>`]))}</section>` : ''}
  <section class="card"><h2>Histórico de decisões</h2>${table(['Data', 'Quem', 'Ação', 'Detalhe'], hist.map((h) => [fmtDateTime(h.created_at), h.name || '—', h.action, h.detail || '']))}</section>` });
});
r.get('/documentos/:id', async (req, res) => {
  const d = await db.one('SELECT * FROM documents WHERE id=?', Number(req.params.id)); if (!d) throw new NotFound();
  const p = privatePath(d.storage_key);
  if (!fs.existsSync(p)) throw new NotFound('Arquivo indisponível.');
  await audit(req, 'document.viewed', { orgId: d.org_id, entity: 'document', entityId: d.id });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `inline; filename="documento-${d.id}${p.slice(p.lastIndexOf('.'))}"`);
  res.type(d.mime).send(fs.readFileSync(p));
});
r.post('/documentos/:id', async (req, res) => {
  const d = await db.one('SELECT * FROM documents WHERE id=?', Number(req.params.id)); if (!d) throw new NotFound();
  const st = req.body.decisao === 'verified' ? 'verified' : 'rejected';
  await db.run('UPDATE documents SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?', st, req.user.id, nowIso(), req.body.note || null, d.id);
  await audit(req, `document.${st}`, { orgId: d.org_id, entity: 'document', entityId: d.id, detail: { note: req.body.note } });
  res.redirect(303, `/admin/organizadores/${d.org_id}`);
});
r.post('/organizadores/:id/decisao', async (req, res) => {
  const o = await db.one('SELECT * FROM organizations WHERE id=?', Number(req.params.id)); if (!o) throw new NotFound();
  const d = req.body.decisao; const note = req.body.note || null;
  const owner = await ownerOf(o.id);
  if (d === 'active') {
    if (!owner?.email_verified_at) throw new UserError('O responsável ainda não confirmou o e-mail.');
    if ((await settings()).require_identity_document && !await db.one("SELECT 1 FROM documents WHERE org_id=? AND kind='identity' AND status='verified'", o.id)) throw new UserError('Marque o documento do responsável como verificado antes de aprovar.');
    await db.run("UPDATE organizations SET status='active', status_note=? WHERE id=?", note, o.id);
  } else if (d === 'correction_requested') { if (!note) throw new UserError('Explique o que precisa ser corrigido.'); await db.run("UPDATE organizations SET status='correction_requested', status_note=? WHERE id=?", note, o.id); }
  else if (d === 'suspended') { await db.run("UPDATE organizations SET status='suspended', status_note=? WHERE id=?", note, o.id); }
  else if (d === 'reactivate') { await db.run("UPDATE organizations SET status='verification_pending', status_note=? WHERE id=?", note, o.id); await refreshStatus(o.id); }
  else throw new UserError('Decisão inválida.');
  await audit(req, `admin.org_${d}`, { orgId: o.id, entity: 'organization', entityId: o.id, detail: { note } });
  if (owner) await sendMail(owner.email, `Situação da conta de organizador: ${ORG_STATUS[d === 'reactivate' ? 'verification_pending' : d].label}`, `${o.trade_name}: ${ORG_STATUS[d === 'reactivate' ? 'verification_pending' : d].label}. ${note || ''}`);
  res.redirect(303, `/admin/organizadores/${o.id}`);
});
r.post('/organizadores/:id/recebimento', async (req, res) => {
  if (config.mp.mode !== 'mp_live') throw new UserError('Produção do Mercado Pago não habilitada.');
  await db.run("UPDATE organizations SET mp_status='live', mp_configured_at=? WHERE id=?", nowIso(), Number(req.params.id));
  await audit(req, 'admin.org_payments_live', { orgId: Number(req.params.id) });
  res.redirect(303, `/admin/organizadores/${req.params.id}`);
});
r.post('/acessos/:id', async (req, res) => {
  const a = await db.one("SELECT * FROM org_access_requests WHERE id=? AND status='pending'", Number(req.params.id)); if (!a) throw new NotFound();
  const d = req.body.decisao;
  await db.tx(async () => {
    await db.run('UPDATE org_access_requests SET status=?, decided_by=?, decided_at=? WHERE id=?', d === 'deny' ? 'denied' : 'approved', req.user.id, nowIso(), a.id);
    if (d === 'approve') await db.run("INSERT INTO org_members(org_id,user_id,role,permissions) VALUES(?,?,'collaborator','[]') ON CONFLICT DO NOTHING", a.org_id, a.user_id);
    if (d === 'transfer') { await db.run("UPDATE org_members SET role='collaborator', permissions='[]' WHERE org_id=? AND role='owner'", a.org_id); await db.run("INSERT INTO org_members(org_id,user_id,role) VALUES(?,?,'owner') ON CONFLICT (org_id,user_id) DO UPDATE SET role='owner'", a.org_id, a.user_id); }
  });
  await audit(req, `admin.access_${d}`, { orgId: a.org_id, entity: 'access_request', entityId: a.id });
  res.redirect(303, `/admin/organizadores/${a.org_id}`);
});

r.get('/usuarios', async (req, res) => {
  const q = req.query.q;
  const us = await db.all(`SELECT * FROM users ${q ? 'WHERE name ILIKE ? OR email ILIKE ?' : ''} ORDER BY id DESC LIMIT 200`, ...(q ? [`%${q}%`, `%${q}%`] : []));
  res.page({ title: 'Usuários', wide: true, body: html`${nav('/admin/usuarios')}<form class="inline-filters filters">${field('q', 'Nome ou e-mail', { value: q })}<button class="btn">Buscar</button></form>
  ${table(['Nome', 'E-mail', 'Confirmado', 'Perfis', 'Situação', ''], await Promise.all(us.map(async (u) => [u.name + (u.is_demo ? ' (demo)' : ''), u.email, u.email_verified_at ? 'Sim' : 'Não', [u.is_admin ? 'Admin' : '', (await db.one('SELECT COUNT(*) n FROM org_members WHERE user_id=?', u.id)).n ? 'Organizador' : '', 'Atleta'].filter(Boolean).join(', '), u.status,
    u.id === req.user.id ? html`<span class="muted">Você</span>` : html`<div class="row-actions">
      <form method="post" action="/admin/usuarios/${u.id}" class="inline">${csrf(req)}<button name="acao" value="${u.status === 'active' ? 'suspend' : 'activate'}" class="btn btn-sm btn-ghost">${u.status === 'active' ? 'Suspender' : 'Reativar'}</button></form>
      ${u.is_demo ? '' : u.is_admin
    ? html`<form method="post" action="/admin/usuarios/${u.id}" class="inline" data-confirm="Remover o acesso de administração de ${u.name}?">${csrf(req)}<button name="acao" value="revoke_admin" class="btn btn-sm btn-ghost">Remover administrador</button></form>`
    : html`<form method="post" action="/admin/usuarios/${u.id}" class="inline" data-confirm="Dar acesso total de administração a ${u.name} (${u.email})?">${csrf(req)}<button name="acao" value="grant_admin" class="btn btn-sm" ${u.status === 'active' ? '' : 'disabled'}>Tornar administrador</button></form>`}</div>`])))}
  <p class="muted">Para cadastrar outro administrador: a pessoa cria a conta em <a href="/cadastro">/cadastro</a>, depois você a procura aqui e clica em <strong>Tornar administrador</strong>. O e-mail dela é marcado como confirmado e a mudança fica registrada na auditoria.</p>` });
});
r.post('/usuarios/:id', async (req, res) => {
  const id = Number(req.params.id); if (id === req.user.id) throw new UserError('Não é possível alterar a própria conta.');
  const target = await db.one('SELECT id, name, email, status, is_admin, is_demo FROM users WHERE id=?', id);
  if (!target) throw new UserError('Usuário não encontrado.', 404);
  if (req.body.acao === 'grant_admin' || req.body.acao === 'revoke_admin') {
    const grant = req.body.acao === 'grant_admin';
    if (target.is_demo) throw new UserError('Contas de demonstração não podem ser administradoras.');
    if (grant && target.status !== 'active') throw new UserError('Reative a conta antes de torná-la administradora.');
    await db.tx(async () => {
      if (!grant && (await db.one("SELECT COUNT(*) n FROM users WHERE is_admin=1 AND status='active' AND id<>?", id)).n === 0) throw new UserError('A plataforma precisa de pelo menos um administrador ativo.');
      await db.run('UPDATE users SET is_admin=?, email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?', grant ? 1 : 0, new Date().toISOString(), id);
      if (!grant) await db.run('DELETE FROM sessions WHERE user_id=?', id); // sai de todas as sessões e entra de novo sem o perfil de administração
    });
    await audit(req, grant ? 'admin.granted' : 'admin.revoked', { entity: 'user', entityId: id, detail: { email: target.email } });
    res.flash('success', grant ? `${target.name} agora é administrador. Ao entrar, basta escolher o perfil "Administração" no menu.` : `${target.name} não é mais administrador.`);
    return res.redirect(303, '/admin/usuarios');
  }
  const st = req.body.acao === 'suspend' ? 'suspended' : 'active';
  if (st === 'suspended' && target.is_admin && (await db.one("SELECT COUNT(*) n FROM users WHERE is_admin=1 AND status='active' AND id<>?", id)).n === 0) throw new UserError('Não é possível suspender o último administrador ativo.');
  await db.run('UPDATE users SET status=? WHERE id=?', st, id);
  if (st === 'suspended') await db.run('DELETE FROM sessions WHERE user_id=?', id);
  await audit(req, `admin.user_${st}`, { entity: 'user', entityId: id });
  res.redirect(303, '/admin/usuarios');
});
r.get('/eventos', async (req, res) => {
  const evs = await db.all('SELECT e.*, o.trade_name FROM events e JOIN organizations o ON o.id=e.org_id ORDER BY e.id DESC LIMIT 300');
  const exc = await db.all("SELECT x.*, o.code, e.name FROM payment_exceptions x JOIN orders o ON o.id=x.order_id JOIN events e ON e.id=o.event_id WHERE x.status='open'");
  res.page({ title: 'Eventos', wide: true, body: html`${nav('/admin/eventos')}${table(['Evento', 'Organizador', 'Data', 'Situação'], await Promise.all(evs.map(async (e) => [html`<a href="/e/${e.slug}">${e.name}</a>${e.is_demo ? ' (demo)' : ''}`, e.trade_name, fmtDateTime(e.start_utc, e.timezone), badge(PUBLIC_STATUS[await publicStatus(e)].label, PUBLIC_STATUS[await publicStatus(e)].tone)])))}
  <h2>Exceções de pagamento abertas</h2>${table(['Pedido', 'Evento', 'Motivo'], exc.map((x) => [x.code, x.name, x.reason]), { emptyMsg: 'Nenhuma.' })}` });
});
r.get('/suporte', async (req, res) => {
  const t = await db.all('SELECT t.*, u.name, u.email, o.trade_name FROM support_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN organizations o ON o.id=t.org_id ORDER BY t.status=\'open\' DESC, t.id DESC');
  res.page({ title: 'Suporte', wide: true, body: html`${nav('/admin/suporte')}${table(['Data', 'De', 'Assunto', 'Mensagem', 'Resposta'], t.map((x) => [fmtDateTime(x.created_at), `${x.name}${x.trade_name ? ` · ${x.trade_name}` : ''}`, x.subject, x.body, x.status === 'open' ? html`<form method="post" action="/admin/suporte/${x.id}" class="inline">${csrf(req)}<input name="response" required aria-label="Resposta"> <button class="btn btn-sm">Responder</button></form>` : x.response]), { emptyMsg: 'Nenhuma solicitação.' })}` });
});
r.post('/suporte/:id', async (req, res) => {
  const t = await db.one('SELECT t.*, u.email FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?', Number(req.params.id)); if (!t) throw new NotFound();
  await db.run("UPDATE support_tickets SET status='answered', response=? WHERE id=?", String(req.body.response).slice(0, 4000), t.id);
  await sendMail(t.email, `Resposta do suporte: ${t.subject}`, String(req.body.response));
  await audit(req, 'admin.support_answered', { orgId: t.org_id, entity: 'ticket', entityId: t.id });
  res.redirect(303, '/admin/suporte');
});
r.get('/parametros', async (req, res) => {
  const s = await settings();
  res.page({ title: 'Parâmetros', body: html`${nav('/admin/parametros')}<section class="card"><form method="post" action="/admin/parametros">${csrf(req)}
  ${tip('Não há valores comerciais pré-definidos. Configure conforme o contrato da plataforma. A taxa vale para eventos criados após a alteração.')}
  ${field('platform_fee_percent', 'Taxa de serviço padrão (%)', { type: 'number', value: s.platform_fee_percent, attrs: 'step="0.01" min="0" max="50"' })}
  ${field('free_events_fee_percent', 'Taxa para eventos gratuitos (%)', { type: 'number', value: s.free_events_fee_percent, attrs: 'step="0.01" min="0"' })}
  ${field('default_fee_payer', 'Quem paga a taxa por padrão', { value: s.default_fee_payer, options: [['athlete', 'Atleta'], ['organizer', 'Organizador']] })}
  ${field('reservation_minutes', 'Tempo padrão de reserva (min)', { type: 'number', value: s.reservation_minutes, attrs: 'min="5" max="120"' })}
  ${field('publish_requires_active', 'Publicar exige organizador verificado (ativo)', { type: 'checkbox', value: s.publish_requires_active })}
  ${field('require_identity_document', 'Exigir documento oficial do responsável', { type: 'checkbox', value: s.require_identity_document })}
  ${field('commercial_conditions', 'Condições comerciais exibidas na página para organizadores', { type: 'textarea', value: s.commercial_conditions })}
  <button class="btn">Salvar parâmetros</button></form></section>` });
});
r.post('/parametros', async (req, res) => {
  const b = req.body; const before = await settings();
  const fee = Number(b.platform_fee_percent); if (!(fee >= 0 && fee <= 50)) throw new UserError('Taxa inválida.');
  await db.setSetting('platform_fee_percent', fee);
  await db.setSetting('free_events_fee_percent', Math.max(0, Number(b.free_events_fee_percent) || 0));
  await db.setSetting('default_fee_payer', b.default_fee_payer === 'organizer' ? 'organizer' : 'athlete');
  await db.setSetting('reservation_minutes', Math.max(5, Math.min(120, Number(b.reservation_minutes) || DEFAULT_SETTINGS.reservation_minutes)));
  await db.setSetting('publish_requires_active', !!b.publish_requires_active);
  await db.setSetting('require_identity_document', !!b.require_identity_document);
  await db.setSetting('commercial_conditions', String(b.commercial_conditions || DEFAULT_SETTINGS.commercial_conditions).slice(0, 2000));
  await audit(req, 'admin.settings_changed', { detail: { before, after: await settings() } });
  res.flash('success', 'Parâmetros salvos.');
  res.redirect(303, '/admin/parametros');
});
// ---------- Integrações: configuradas pela própria tela ----------
const integrations = require('../lib/integrations');
const delivery = require('../lib/delivery');

function integrationStatus(id) {
  const m = config;
  switch (id) {
    case 'mercadopago': return [MODE_LABEL[m.mp.mode], m.mp.mode === 'mp_live' ? 'ok' : m.mp.mode === 'mp_test' ? 'info' : m.mp.mode === 'simulator' ? 'warn' : 'danger'];
    case 'paypal': return [{ simulator: 'Simulador local (demonstração)', test: 'Sandbox (testes)', live: 'Produção', blocked_undecided: 'Bloqueado: defina quem recebe o dinheiro', disabled: 'Não configurado' }[m.paypal.mode], m.paypal.mode === 'live' ? 'ok' : m.paypal.mode === 'test' ? 'info' : 'warn'];
    case 'picpay': return [{ simulator: 'Simulador local (demonstração)', live: 'Produção', blocked_undecided: 'Bloqueado: defina quem recebe o dinheiro', disabled: 'Não configurado' }[m.picpay.mode], m.picpay.mode === 'live' ? 'ok' : 'warn'];
    case 'payment_methods': return [m.paymentMethods.length ? m.paymentMethods.map((x) => ({ mercadopago: 'Mercado Pago', paypal: 'PayPal', picpay: 'PicPay' }[x])).join(', ') : 'Nenhum meio selecionado', m.paymentMethods.length ? 'ok' : 'danger'];
    case 'mail': return m.mail.mode === 'smtp' ? [`Enviando por ${m.mail.smtpHost}`, 'ok'] : ['Não configurado: e-mails ficam só registrados', 'warn'];
    case 'messaging': return m.messaging.mode === 'twilio' ? ['Twilio ativo', 'ok'] : ['Desativado', 'muted'];
    case 'google': return [{ live: 'Ativo', simulator: 'Simulador local (demonstração)', disabled: 'Desativado: botão do Google oculto' }[m.google.mode], m.google.mode === 'live' ? 'ok' : 'warn'];
    case 'cnpj': return m.cnpj.provider === 'http' && m.cnpj.url ? [`Fornecedor: ${m.cnpj.name}`, 'ok'] : ['Manual: dados ficam pendentes de verificação', 'warn'];
    case 'analytics': return m.analytics.ga || m.analytics.metaPixel ? ['Configurado (só com consentimento)', 'ok'] : ['Não configurado', 'muted'];
    default: return ['—', 'muted'];
  }
}

function integrationField(f) {
  const id = `f-${f.name}`;
  const hint = f.hint ? html`<small class="hint">${f.hint}</small>` : '';
  const envNote = f.fromEnv ? html`<small class="hint">Usando o valor padrão do servidor. Preencha aqui para substituir.</small>` : '';
  if (f.type === 'secret') {
    const state = f.unreadable ? badge('Salvo, mas ilegível: informe de novo', 'danger') : f.isSet ? badge(f.fromEnv ? 'Configurado no servidor (.env)' : 'Configurado', 'ok') : badge('Não configurado', 'muted');
    return html`<div class="field"><label for="${id}">${f.label} ${state}</label>
      <input type="password" id="${id}" name="${f.name}" autocomplete="new-password" placeholder="${f.isSet ? 'Deixe em branco para manter o atual' : ''}">${hint}
      ${f.savedSet ? html`<label class="inline-check"><input type="checkbox" name="${f.name}__remover" value="1"> Remover o valor salvo</label>` : ''}</div>`;
  }
  if (f.type === 'checkboxes') {
    const cur = Array.isArray(f.value) && f.value.length ? f.value : f.effective || [];
    return html`<fieldset class="check-group"><legend>${f.label}</legend>${f.options.map(([v, l]) => html`<label class="inline-check"><input type="checkbox" name="${f.name}" value="${v}" ${cur.includes(v) ? 'checked' : ''}> ${l}</label>`)}${hint}</fieldset>`;
  }
  if (f.type === 'select') {
    const cur = f.value !== '' ? f.value : (f.effective ?? '');
    return html`<div class="field"><label for="${id}">${f.label}</label><select id="${id}" name="${f.name}">${f.options.map(([v, l]) => html`<option value="${v}" ${String(cur) === v ? 'selected' : ''}>${l}</option>`)}</select>${hint}${envNote}</div>`;
  }
  return html`<div class="field"><label for="${id}">${f.label}</label><input type="${f.type === 'number' ? 'number' : 'text'}" id="${id}" name="${f.name}" value="${f.value ?? ''}" placeholder="${f.fromEnv ? String(f.effective ?? '') : f.placeholder || ''}" autocomplete="off">${hint}${envNote}</div>`;
}

r.get('/integracoes', async (req, res) => {
  const open = String(req.query.abrir || '');
  const groups = [...new Set(integrations.SPEC.map((s) => s.group))];
  const cards = {};
  for (const s of integrations.SPEC) {
    const fields = await integrations.formState(s.id);
    const [label, tone] = integrationStatus(s.id);
    const tests = s.id === 'mail' ? html`<form method="post" action="/admin/integracoes/mail/teste" class="test-form">${csrf(req)}<label for="t-mail">Enviar e-mail de teste para</label><div class="test-row"><input type="email" id="t-mail" name="to" value="${req.user.email}" required><button class="btn btn-ghost">Enviar teste</button></div></form>`
      : s.id === 'messaging' ? html`<form method="post" action="/admin/integracoes/messaging/teste" class="test-form">${csrf(req)}<label for="t-phone">Enviar mensagem de teste para</label><div class="test-row"><input type="tel" id="t-phone" name="to" placeholder="(11) 99999-0000" required><select name="channel" aria-label="Canal"><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select><button class="btn btn-ghost">Enviar teste</button></div></form>` : '';
    cards[s.id] = html`<details class="card integration" id="int-${s.id}" ${open === s.id ? 'open' : ''}>
      <summary><span class="int-title">${s.title}</span>${badge(label, tone)}</summary>
      <p class="muted">${s.help.replaceAll('{BASE}', config.baseUrl)}</p>
      <form method="post" action="/admin/integracoes/${s.id}" autocomplete="off">${csrf(req)}${fields.map(integrationField)}<button class="btn">Salvar ${s.title}</button></form>
      ${tests}</details>`;
  }
  const wh = await db.all('SELECT * FROM webhook_events ORDER BY id DESC LIMIT 30');
  res.page({ title: 'Integrações', wide: true, body: html`${nav('/admin/integracoes')}
  ${tip('Senhas, tokens e chaves ficam criptografados no banco e nunca aparecem de volta na tela. As alterações valem na hora, sem reiniciar o site, e ficam registradas na auditoria.')}
  ${groups.map((g) => html`<h2 class="int-group">${g}</h2>${integrations.SPEC.filter((s) => s.group === g).map((s) => cards[s.id])}`)}
  <section class="card"><h2>Últimos webhooks recebidos</h2>${table(['Data', 'Provedor', 'Recurso', 'Assinatura', 'Resultado'], wh.map((w) => [fmtDateTime(w.received_at), w.provider, w.resource_id, w.signature_ok ? 'válida' : 'inválida', w.result || '—']))}</section>` });
});

r.post('/integracoes/mail/teste', async (req, res) => {
  const to = String(req.body.to || '').trim();
  try { await delivery.testEmail(to); res.flash('success', `E-mail de teste enviado para ${to}. Confira a caixa de entrada e o spam.`); }
  catch (e) { res.flash('error', `Falha no envio: ${String(e.message).slice(0, 200)}`); }
  await audit(req, 'integration.test', { entity: 'integration', entityId: 'mail' });
  res.redirect(303, '/admin/integracoes?abrir=mail#int-mail');
});
r.post('/integracoes/messaging/teste', async (req, res) => {
  const channel = req.body.channel === 'sms' ? 'sms' : 'whatsapp';
  try { await delivery.testMessage(channel, req.body.to); res.flash('success', `Mensagem de teste enviada por ${channel === 'sms' ? 'SMS' : 'WhatsApp'}.`); }
  catch (e) { res.flash('error', `Falha no envio: ${String(e.message).slice(0, 200)}`); }
  await audit(req, 'integration.test', { entity: 'integration', entityId: `messaging:${channel}` });
  res.redirect(303, '/admin/integracoes?abrir=messaging#int-messaging');
});
r.post('/integracoes/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!integrations.byId[id]) throw new NotFound();
  const summary = await integrations.save(id, req.body);
  await audit(req, 'integration.updated', { entity: 'integration', entityId: id, detail: summary });
  res.flash('success', `${integrations.byId[id].title}: configuração salva e aplicada.`);
  res.redirect(303, `/admin/integracoes?abrir=${encodeURIComponent(id)}#int-${id}`);
});

// Mensagens enviadas: só destinatário, assunto e situação (o conteúdo pode ter links de acesso pessoais)
r.get('/mensagens', async (req, res) => {
  const mails = await db.all('SELECT id, to_email, subject, category, status, attempts, error, created_at, sent_at FROM outbox ORDER BY id DESC LIMIT 100');
  const msgs = await db.all('SELECT id, channel, to_phone, category, status, error, created_at, sent_at FROM message_log ORDER BY id DESC LIMIT 100');
  const ST = { local: ['Só registrado (sem SMTP)', 'muted'], queued: ['Na fila', 'info'], sending: ['Enviando', 'info'], retry: ['Nova tentativa', 'warn'], sent: ['Enviado', 'ok'], failed: ['Falhou', 'danger'] };
  const st = (s) => badge(...(ST[s] || [s, 'muted']));
  const maskPhone = (p) => String(p || '').replace(/(\+\d{2})(\d{2})\d+(\d{4})$/, '$1 $2 •••• $3');
  res.page({ title: 'Mensagens', wide: true, body: html`${nav('/admin/mensagens')}
  <section class="card"><h2>E-mails</h2>${table(['Data', 'Para', 'Assunto', 'Tipo', 'Situação', 'Tentativas', 'Erro'], mails.map((m) => [fmtDateTime(m.created_at), m.to_email, m.subject, m.category, st(m.status), String(m.attempts), m.error || '—']), { emptyMsg: 'Nenhum e-mail registrado.' })}
  ${mails.some((m) => m.status === 'failed') ? html`<form method="post" action="/admin/mensagens/reenviar">${csrf(req)}<button class="btn btn-ghost">Tentar de novo os que falharam</button></form>` : ''}</section>
  <section class="card"><h2>SMS e WhatsApp</h2>${table(['Data', 'Canal', 'Para', 'Tipo', 'Situação', 'Erro'], msgs.map((m) => [fmtDateTime(m.created_at), m.channel === 'sms' ? 'SMS' : 'WhatsApp', maskPhone(m.to_phone), m.category, st(m.status), m.error || '—']), { emptyMsg: 'Nenhuma mensagem registrada.' })}</section>` });
});
r.post('/mensagens/reenviar', async (req, res) => {
  const r1 = await db.run("UPDATE outbox SET status='retry', attempts=0 WHERE status='failed'");
  await db.run(`UPDATE message_log m SET status='queued', attempts=0 FROM users u WHERE u.id=m.user_id AND m.status='failed' AND COALESCE((u.notify_prefs::jsonb ->> m.channel), 'false') = 'true'`);
  delivery.kick();
  await audit(req, 'messages.retry', { detail: { emails: r1.changes } });
  res.flash('info', 'Mensagens com falha voltaram para a fila de envio.');
  res.redirect(303, '/admin/mensagens');
});
r.get('/auditoria', async (req, res) => {
  const q = req.query;
  const where = []; const p = [];
  if (q.acao) { where.push('l.action ILIKE ?'); p.push(`%${q.acao}%`); }
  if (q.org) { where.push('l.org_id=?'); p.push(Number(q.org)); }
  const logs = await db.all(`SELECT l.*, u.email FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT 300`, ...p);
  res.page({ title: 'Auditoria', wide: true, body: html`${nav('/admin/auditoria')}<form class="inline-filters filters">${field('acao', 'Ação contém', { value: q.acao })}${field('org', 'ID da organização', { value: q.org })}<button class="btn">Filtrar</button></form>
  ${table(['Data', 'Usuário', 'Org.', 'Ação', 'Entidade', 'Detalhe', 'IP'], logs.map((l) => [fmtDateTime(l.created_at), l.email || '—', l.org_id ?? '—', l.action, l.entity ? `${l.entity} ${l.entity_id || ''}` : '—', (l.detail || '').slice(0, 160), l.ip || '—']))}` });
});
module.exports = r;
