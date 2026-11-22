'use strict';
const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const { html, raw, brl, fmtDateTime, fmtDate, json, UserError, nowIso, toCsv, slugify, randomToken } = require('../lib/util');
const { fmtCnpj, isEmail, isPhone, isUrl, orgDoc } = require('../lib/docs');
const { ORG_STATUS, PERMS, activation, assertCan, can, eventForOrg, ownerOf, refreshStatus } = require('../lib/orgs');
const { publicStatus, PUBLIC_STATUS, eventStats } = require('../lib/events');
const { MODE_LABEL, reconciliation, PAY_LABEL } = require('../lib/payments');
const { audit, sendMail, sha256 } = require('../lib/core');
const { requireOrg, perm } = require('../lib/guards');
const { csrf, field, badge, table, empty, tip } = require('../views/layout');

const r = express.Router();
r.use((req, res, next) => (req.path.startsWith('/cadastro') ? next('router') : next()));
r.use(requireOrg);

const visibleEvents = async (req) => {
  const evs = await db.all('SELECT * FROM events WHERE org_id=? ORDER BY COALESCE(start_utc, created_at) DESC', req.org.id);
  return req.member.eventIds ? evs.filter((e) => req.member.eventIds.includes(e.id)) : evs;
};
const sub = (req, active) => html`<nav class="subnav" aria-label="Organizador">${[['/organizador', 'Painel'], ['/organizador/eventos', 'Eventos'], ['/organizador/financeiro', 'Financeiro'], ['/organizador/equipe', 'Equipe'], ['/organizador/empresa', 'Empresa'], ['/organizador/recebimentos', 'Recebimentos'], ['/organizador/suporte', 'Suporte']].map(([h, l]) => html`<a href="${h}" ${active === h ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
const orgHeader = (req, active) => html`<div class="org-head"><div><p class="muted">Organizador</p><h1>${req.org.trade_name || req.org.legal_name}</h1></div>${badge(ORG_STATUS[req.org.status].label, ORG_STATUS[req.org.status].tone)}</div>${sub(req, active)}`;
r.locals = { orgHeader, visibleEvents };

r.get('/', async (req, res) => {
  const org = req.org; const act = await activation(org); const owner = await ownerOf(org.id);
  const evs = await visibleEvents(req);
  const first = evs[evs.length - 1];
  const hasMods = first && (await db.one('SELECT COUNT(*) n FROM modalities WHERE event_id=?', first.id)).n > 0 && (await db.one('SELECT COUNT(*) n FROM lots WHERE event_id=?', first.id)).n > 0;
  const tasks = [
    [act.items.email, 'Confirmar e-mail', owner?.email_verified_at ? null : '/minha-conta', 'Enviamos um link para o e-mail do responsável.'],
    [act.items.company && act.items.documents, 'Completar empresa e documentação', '/organizador/empresa', 'Dados da empresa, contatos e documentos.'],
    [act.items.verified, 'Resolver verificação', '/organizador/empresa', org.status === 'correction_requested' ? `Correção solicitada: ${org.status_note || ''}` : 'Nossa equipe analisa os dados e documentos.'],
    [act.items.payments, 'Configurar recebimento pelo Mercado Pago', '/organizador/recebimentos', 'Necessário apenas para eventos pagos.'],
    [!!first, 'Criar primeiro evento', '/organizador/eventos/novo', 'Nome, data, local e descrição.'],
    [!!hasMods, 'Configurar modalidades, categorias, lotes, vagas e kits', first ? `/organizador/eventos/${first.id}/editar?etapa=2` : '/organizador/eventos/novo', ''],
    [!!(first?.regulation), 'Adicionar regulamento e informações obrigatórias', first ? `/organizador/eventos/${first.id}/editar?etapa=6` : '/organizador/eventos/novo', ''],
    [!!evs.find((e) => e.status !== 'draft'), 'Revisar e publicar', first ? `/organizador/eventos/${first.id}/editar?etapa=9` : '/organizador/eventos/novo', ''],
  ];
  const done = tasks.filter((t) => t[0]).length;
  const totals = { c: 0, g: 0, p: 0, x: 0, req: 0 };
  for (const e of evs) { const s = await eventStats(e.id); totals.c += s.confirmed; totals.g += s.gross; totals.p += s.reserved; totals.x += s.cancelled; totals.req += s.open_requests; }
  res.page({ title: 'Painel do organizador', wide: true, body: html`${orgHeader(req, '/organizador')}
  ${org.status === 'correction_requested' ? html`<div class="alert alert-error"><strong>Correção solicitada pela equipe de verificação:</strong> ${org.status_note || ''} <a href="/organizador/empresa">Corrigir agora</a></div>` : ''}
  ${org.status === 'suspended' ? html`<div class="alert alert-error">Conta suspensa: publicação e recebimentos bloqueados. ${org.status_note || ''} Fale com o suporte.</div>` : ''}
  <section class="card"><div class="section-head"><h2>Primeiros passos</h2><span>${done} de ${tasks.length} concluídas</span></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${tasks.length}" aria-valuenow="${done}"><span style="width:${Math.round((done / tasks.length) * 100)}%"></span></div>
    <ol class="tasks">${tasks.map(([ok, label, href, hint], i) => html`<li class="${ok ? 'done' : ''}"><span class="tick" aria-hidden="true">${ok ? '✓' : i + 1}</span><div>${ok || !href ? html`<strong>${label}</strong>` : html`<a href="${href}"><strong>${label}</strong></a>`}${ok ? html` <span class="sr-only">(concluída)</span>` : ''}${hint ? html`<br><small class="muted">${hint}</small>` : ''}</div></li>`)}</ol>
    ${tip('Você pode preparar eventos em rascunho enquanto há pendências. Publicar exige conta verificada; vender eventos pagos exige também o recebimento configurado.')}</section>
  <section class="kpis" aria-label="Indicadores"><div class="kpi"><span>Inscrições confirmadas</span><strong>${totals.c}</strong></div><div class="kpi"><span>Receita confirmada (bruta)</span><strong>${brl(totals.g)}</strong></div><div class="kpi"><span>Reservas aguardando pagamento</span><strong>${totals.p}</strong></div><div class="kpi"><span>Cancelamentos/reembolsos</span><strong>${totals.x}</strong></div><div class="kpi"><span>Solicitações abertas</span><strong>${totals.req}</strong></div></section>
  <p class="muted">Indicadores calculados no momento do carregamento (${fmtDateTime(nowIso())}). Atualize a página para recalcular.</p>
  <section class="card"><div class="section-head"><h2>Eventos</h2>${can(req.member, 'events') ? html`<a class="btn" href="/organizador/eventos/novo">Criar evento</a>` : ''}</div>${eventsTable(req, evs)}</section>` });
});

async function eventsTable(req, evs) {
  return table(['Evento', 'Data', 'Situação', 'Inscritos', 'Ações'], await Promise.all(evs.map(async (e) => {
    const s = await eventStats(e.id); const ps = PUBLIC_STATUS[await publicStatus(e)];
    return [html`<a href="/organizador/eventos/${e.id}">${e.name}</a>`, e.start_utc ? fmtDate(e.start_utc, e.timezone) : '—', badge(ps.label, ps.tone), String(s.confirmed),
      html`<a href="/organizador/eventos/${e.id}">Gerenciar</a>${can(req.member, 'events', e.id) ? html` · <a href="/organizador/eventos/${e.id}/editar">Editar</a>` : ''}`];
  })), { emptyMsg: 'Nenhum evento ainda. Crie o primeiro — ele fica em rascunho até você publicar.' });
}
r.get('/eventos', async (req, res) => res.page({ title: 'Eventos', wide: true, body: html`${orgHeader(req, '/organizador/eventos')}<section class="card"><div class="section-head"><h2>Eventos</h2>${can(req.member, 'events') ? html`<a class="btn" href="/organizador/eventos/novo">Criar evento</a>` : ''}</div>${eventsTable(req, await visibleEvents(req))}</section>` }));

// Empresa: edição e reenvio para verificação
r.get('/empresa', async (req, res) => {
  const o = req.org; const a = json(o.address, {});
  const docs = await db.all('SELECT * FROM documents WHERE org_id=? ORDER BY id DESC', o.id);
  const isOwner = req.member.role === 'owner';
  res.page({ title: 'Empresa', wide: true, body: html`${orgHeader(req, '/organizador/empresa')}
  <section class="card"><h2>${o.person_type === 'pf' ? 'Dados do organizador' : 'Dados da empresa'}</h2><p>${orgDoc(o)} · Origem: ${o.cnpj_source === 'manual' ? 'preenchimento manual (pendente de verificação)' : o.cnpj_source.replace('provider:', 'consulta cadastral — ')}${o.cnpj_status ? ` · Situação cadastral: ${o.cnpj_status}` : ''}</p>
  ${isOwner ? html`<form method="post" action="/organizador/empresa">${csrf(req)}
    <div class="row">${field('legal_name', 'Razão social', { value: o.legal_name, required: true })}${field('trade_name', 'Nome fantasia', { value: o.trade_name, required: true })}</div>
    <div class="row">${field('city', 'Cidade', { value: a.city, required: true })}${field('state', 'UF', { value: a.state, required: true })}${field('street', 'Endereço', { value: a.street })}</div>
    <div class="row">${field('support_email', 'E-mail de atendimento', { type: 'email', value: o.support_email, required: true })}${field('support_phone', 'Telefone de atendimento', { value: o.support_phone, required: true })}${field('website', 'Site', { value: o.website })}</div>
    ${field('bio', 'Apresentação', { type: 'textarea', value: o.bio })}
    <button class="btn">Salvar${['correction_requested'].includes(o.status) ? ' e reenviar para verificação' : ''}</button></form>` : html`<p class="muted">Somente o responsável pode alterar dados da empresa.</p>`}</section>
  <section class="card"><h2>Documentos</h2>${table(['Tipo', 'Arquivo', 'Situação', 'Enviado em'], docs.map((d) => [d.kind === 'identity' ? 'Documento do responsável' : 'Comprovante de vínculo', d.original_name, badge(...({ submitted: ['Enviado — aguardando análise', 'warn'], verified: ['Verificado', 'ok'], rejected: [`Recusado${d.review_note ? `: ${d.review_note}` : ''}`, 'danger'] })[d.status]), fmtDateTime(d.created_at)]), { emptyMsg: 'Nenhum documento enviado.' })}
  ${isOwner ? html`<p><a class="btn btn-ghost" href="/organizador/empresa/documentos">Enviar novo documento ou logomarca</a></p>` : ''}
  ${isOwner ? html`<form method="post" action="/organizador/api-key" data-confirm="Gerar nova chave revoga a anterior. Continuar?">${csrf(req)}<button class="btn btn-ghost btn-sm">Gerar chave de API</button> <a href="/api/docs">Documentação da API</a></form>` : ''}
  <p class="muted">Documentos ficam em área privada. Nem a equipe do organizador consegue baixá-los por aqui; apenas a equipe de verificação, com registro de acesso.</p></section>` });
});
r.post('/empresa', async (req, res) => {
  if (req.member.role !== 'owner') throw new UserError('Somente o responsável pode alterar dados da empresa.', 403);
  const b = req.body; const o = req.org;
  if (!b.legal_name || !b.trade_name || !b.city || !b.state) throw new UserError('Preencha razão social, nome fantasia, cidade e UF.');
  if (!isEmail(b.support_email) || !isPhone(b.support_phone)) throw new UserError('Informe e-mail e telefone de atendimento válidos.');
  if (b.website && !isUrl(b.website)) throw new UserError('Site inválido: use https://');
  const a = { ...json(o.address, {}), city: b.city, state: b.state, street: b.street };
  const legalChanged = b.legal_name.trim() !== o.legal_name;
  await db.run('UPDATE organizations SET legal_name=?, trade_name=?, address=?, support_email=?, support_phone=?, website=?, bio=?, cnpj_source=CASE WHEN ? THEN \'manual\' ELSE cnpj_source END WHERE id=?',
    b.legal_name.trim(), b.trade_name.trim(), JSON.stringify(a), b.support_email.trim(), b.support_phone.trim(), b.website || null, b.bio || null, legalChanged ? 1 : 0, o.id);
  if (o.status === 'correction_requested') { await db.run("UPDATE organizations SET status='verification_pending', status_note=NULL WHERE id=?", o.id); await refreshStatus(o.id); }
  await audit(req, 'org.updated', { orgId: o.id, entity: 'organization', entityId: o.id, detail: { legalChanged } });
  res.flash('success', o.status === 'correction_requested' ? 'Dados salvos e reenviados para verificação.' : 'Dados salvos.');
  res.redirect(303, '/organizador/empresa');
});
r.get('/empresa/documentos', (req, res) => res.page({ title: 'Documentos', body: html`<section class="card"><h1>Enviar documentos</h1>
  <form method="post" action="/organizador/empresa/documentos" enctype="multipart/form-data">${csrf(req)}
  <div class="field"><label for="logo">Logomarca (PNG/JPG/WEBP até 2 MB)</label><input type="file" id="logo" name="logo" accept="image/*" data-preview="lp"><img id="lp" class="org-logo" alt="Prévia" hidden></div>
  <div class="field"><label for="identity">Documento oficial do responsável (PDF/JPG/PNG até 5 MB)</label><input type="file" id="identity" name="identity"></div>
  <div class="field"><label for="link_doc">Comprovante de vínculo (PDF/JPG/PNG até 5 MB)</label><input type="file" id="link_doc" name="link_doc"></div>
  <button class="btn">Enviar</button> <a href="/organizador/empresa">Cancelar</a></form></section>` }));
r.post('/empresa/documentos', require('../lib/guards').upload(5).fields([{ name: 'logo' }, { name: 'identity' }, { name: 'link_doc' }]), require('../lib/guards').csrfAfterMultipart, async (req, res) => {
  if (req.member.role !== 'owner') throw new UserError('Somente o responsável pode enviar documentos.', 403);
  const { checkFile, store } = require('../lib/guards');
  const logo = checkFile(req.files?.logo?.[0], ['image/png', 'image/jpeg', 'image/webp'], 'Logomarca');
  if (logo && logo.size > 2 * 1024 * 1024) throw new UserError('Logomarca acima de 2 MB.');
  if (logo) await db.run('UPDATE organizations SET logo_path=? WHERE id=?', store(logo, { isPrivate: false }), req.org.id);
  for (const [kind, name] of [['identity', 'identity'], ['link_proof', 'link_doc']]) {
    const f = checkFile(req.files?.[name]?.[0], ['application/pdf', 'image/png', 'image/jpeg'], 'Documento');
    if (!f) continue;
    await db.run('INSERT INTO documents(org_id,user_id,kind,storage_key,original_name,mime,size) VALUES(?,?,?,?,?,?,?)', req.org.id, req.user.id, kind, store(f, { isPrivate: true }), f.originalname.slice(0, 120), f.mimetype, f.size);
    await audit(req, 'document.uploaded', { orgId: req.org.id, entity: 'document', detail: { kind } });
  }
  res.flash('success', 'Arquivos enviados.');
  res.redirect(303, '/organizador/empresa');
});

// Recebimentos
r.get('/recebimentos', (req, res) => {
  const o = req.org;
  const model = { undecided: 'Não decidido — pendência de negócio registrada', platform: 'Valores recebidos pela conta da plataforma e repassados ao organizador', organizer: 'Valores recebidos diretamente na conta Mercado Pago do organizador' }[config.mp.receiverModel];
  res.page({ title: 'Recebimentos', wide: true, body: html`${orgHeader(req, '/organizador/recebimentos')}
  <section class="card"><h2>Recebimento pelo Mercado Pago</h2>
  <dl class="defs"><dt>Ambiente de pagamento</dt><dd>${MODE_LABEL[config.mp.mode]}</dd><dt>Modelo de recebimento</dt><dd>${model}</dd>
  <dt>Situação da sua conta</dt><dd>${{ none: badge('Não configurado', 'warn'), test: badge('Configurado em ambiente de testes', 'info'), live: badge('Habilitado em produção', 'ok') }[o.mp_status]}${o.mp_configured_at ? ` desde ${fmtDateTime(o.mp_configured_at)}` : ''}</dd></dl>
  ${['simulator', 'mp_test'].includes(config.mp.mode) ? html`<p>Neste ambiente, as cobranças são de teste. Ative para criar e testar eventos pagos de ponta a ponta. Nenhum valor real será movimentado.</p>
    ${req.member.role === 'owner' && o.mp_status === 'none' ? html`<form method="post" action="/organizador/recebimentos/teste">${csrf(req)}<button class="btn">Ativar recebimento em ambiente de testes</button></form>` : ''}` : ''}
  ${config.mp.mode === 'mp_live' ? html`<p>Para habilitar recebimentos reais, a equipe da plataforma confirma o contrato e o modelo de recebimento. ${config.mp.receiverModel === 'organizer' ? 'A conexão da sua conta usa o fluxo de autorização oficial do Mercado Pago (OAuth) — configuração externa pendente.' : ''}</p>` : ''}
  ${['blocked_undecided', 'disabled'].includes(config.mp.mode) ? html`<div class="alert alert-warn">Recebimentos reais ainda não estão habilitados nesta plataforma. Eventos gratuitos podem ser publicados normalmente.</div>` : ''}
  ${tip('Pix e cartão são oferecidos conforme disponibilidade do produto Mercado Pago integrado. Parcelamento, repasse imediato e divisão automática de valores não são prometidos nesta versão.')}</section>` });
});
r.post('/recebimentos/teste', async (req, res) => {
  if (req.member.role !== 'owner') throw new UserError('Somente o responsável pode configurar recebimentos.', 403);
  if (!['simulator', 'mp_test'].includes(config.mp.mode)) throw new UserError('Ambiente de testes indisponível.');
  await db.run("UPDATE organizations SET mp_status='test', mp_configured_at=? WHERE id=?", nowIso(), req.org.id);
  await audit(req, 'org.payments_test_enabled', { orgId: req.org.id });
  res.flash('success', 'Recebimento configurado em ambiente de testes.');
  res.redirect(303, '/organizador/recebimentos');
});

// Equipe e colaboradores
r.get('/equipe', async (req, res) => {
  const members = await db.all('SELECT m.*, u.name, u.email FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=?', req.org.id);
  const reqs = await db.all("SELECT a.*, u.name, u.email FROM org_access_requests a JOIN users u ON u.id=a.user_id WHERE a.org_id=? AND a.status='pending'", req.org.id);
  const evs = await db.all('SELECT id, name FROM events WHERE org_id=?', req.org.id);
  const isOwner = req.member.role === 'owner';
  res.page({ title: 'Equipe', wide: true, body: html`${orgHeader(req, '/organizador/equipe')}
  <section class="card"><h2>Colaboradores</h2>${table(['Nome', 'E-mail', 'Papel', 'Funções', 'Eventos', ''], members.map((m) => [m.name, m.email, m.role === 'owner' ? 'Responsável' : 'Colaborador', m.role === 'owner' ? 'Todas' : json(m.permissions, []).map((p) => PERMS[p]).join(', '), m.event_ids ? json(m.event_ids, []).map((id) => evs.find((e) => e.id === id)?.name).join(', ') : 'Todos',
    isOwner && m.role !== 'owner' ? html`<form method="post" action="/organizador/equipe/remover" class="inline">${csrf(req)}<input type="hidden" name="user_id" value="${m.user_id}"><button class="linklike danger">Remover</button></form>` : '']))}</section>
  ${isOwner ? html`<section class="card"><h2>Adicionar ou atualizar colaborador</h2>${tip('O colaborador precisa ter uma conta na plataforma (gratuita). Se ainda não tiver, enviaremos um convite para criá-la.')}
  <form method="post" action="/organizador/equipe">${csrf(req)}${field('email', 'E-mail do colaborador', { type: 'email', required: true })}
  <fieldset><legend>Funções autorizadas</legend>${Object.entries(PERMS).map(([k, l]) => field(`perm_${k}`, l, { type: 'checkbox' }))}</fieldset>
  <fieldset><legend>Eventos (deixe vazio para todos)</legend>${evs.map((e) => field(`ev_${e.id}`, e.name, { type: 'checkbox' }))}</fieldset>
  <button class="btn">Salvar colaborador</button></form></section>
  <section class="card"><h2>Solicitações de acesso à empresa</h2>${table(['Pessoa', 'Mensagem', 'Data', ''], reqs.map((a) => [`${a.name} (${a.email})`, a.message, fmtDateTime(a.created_at), html`<form method="post" action="/organizador/equipe/solicitacao" class="inline">${csrf(req)}<input type="hidden" name="id" value="${a.id}"><button name="decisao" value="approve" class="btn btn-sm">Aprovar como colaborador (sem funções)</button> <button name="decisao" value="deny" class="btn btn-sm btn-ghost">Recusar</button></form>`]), { emptyMsg: 'Nenhuma solicitação pendente.' })}</section>` : ''}` });
});
r.post('/equipe', async (req, res) => {
  if (req.member.role !== 'owner') throw new UserError('Somente o responsável gerencia a equipe.', 403);
  const email = String(req.body.email || '').trim();
  const u = await db.one('SELECT * FROM users WHERE email=?', email);
  if (!u) { if (isEmail(email)) await sendMail(email, `Convite para a equipe de ${req.org.trade_name}`, `Você foi convidado(a) para colaborar com ${req.org.trade_name}. Crie sua conta em ${config.baseUrl}/cadastro e avise o responsável para concluir a inclusão.`); res.flash('info', 'Pessoa sem conta: enviamos convite por e-mail. Após o cadastro, adicione-a novamente.'); return res.redirect(303, '/organizador/equipe'); }
  const permsSel = Object.keys(PERMS).filter((k) => req.body[`perm_${k}`]);
  const evIds = (await db.all('SELECT id FROM events WHERE org_id=?', req.org.id)).map((e) => e.id).filter((id) => req.body[`ev_${id}`]);
  const existing = await db.one('SELECT * FROM org_members WHERE org_id=? AND user_id=?', req.org.id, u.id);
  if (existing?.role === 'owner') throw new UserError('O responsável já possui acesso total.');
  if (existing) await db.run('UPDATE org_members SET permissions=?, event_ids=? WHERE org_id=? AND user_id=?', JSON.stringify(permsSel), evIds.length ? JSON.stringify(evIds) : null, req.org.id, u.id);
  else await db.run("INSERT INTO org_members(org_id,user_id,role,permissions,event_ids) VALUES(?,?,'collaborator',?,?)", req.org.id, u.id, JSON.stringify(permsSel), evIds.length ? JSON.stringify(evIds) : null);
  await audit(req, 'org.member_saved', { orgId: req.org.id, entity: 'user', entityId: u.id, detail: { permsSel, evIds } });
  await sendMail(u.email, `Acesso à equipe de ${req.org.trade_name}`, `Você agora colabora com ${req.org.trade_name}. Selecione o perfil da empresa no menu do seu painel.`);
  res.flash('success', 'Colaborador salvo.');
  res.redirect(303, '/organizador/equipe');
});
r.post('/equipe/remover', async (req, res) => {
  if (req.member.role !== 'owner') throw new UserError('Somente o responsável gerencia a equipe.', 403);
  await db.run("DELETE FROM org_members WHERE org_id=? AND user_id=? AND role<>'owner'", req.org.id, Number(req.body.user_id));
  await db.run("UPDATE sessions SET context='athlete' WHERE user_id=? AND context=?", Number(req.body.user_id), `org:${req.org.id}`);
  await audit(req, 'org.member_removed', { orgId: req.org.id, entity: 'user', entityId: req.body.user_id });
  res.redirect(303, '/organizador/equipe');
});
r.post('/equipe/solicitacao', async (req, res) => {
  if (req.member.role !== 'owner') throw new UserError('Somente o responsável decide.', 403);
  const a = await db.one("SELECT * FROM org_access_requests WHERE id=? AND org_id=? AND status='pending'", Number(req.body.id), req.org.id);
  if (!a) throw new UserError('Solicitação não encontrada.');
  const ok = req.body.decisao === 'approve';
  await db.run('UPDATE org_access_requests SET status=?, decided_by=?, decided_at=? WHERE id=?', ok ? 'approved' : 'denied', req.user.id, nowIso(), a.id);
  if (ok) await db.run("INSERT INTO org_members(org_id,user_id,role,permissions) VALUES(?,?,'collaborator','[]') ON CONFLICT DO NOTHING", req.org.id, a.user_id);
  await audit(req, 'org.access_request_decided', { orgId: req.org.id, entity: 'access_request', entityId: a.id, detail: { ok } });
  res.redirect(303, '/organizador/equipe');
});

// Financeiro
async function finance(eventIds) {
  if (!eventIds.length) return [];
  const ph = eventIds.map(() => '?').join(',');
  return await db.all(`SELECT e.id, e.name,
    COALESCE(SUM(CASE WHEN o.status IN ('paid','refunded','partially_refunded') THEN o.subtotal_cents END),0) gross,
    COALESCE(SUM(CASE WHEN o.status IN ('paid','refunded','partially_refunded') THEN o.discount_cents END),0) discounts,
    COALESCE(SUM(CASE WHEN o.status IN ('paid','refunded','partially_refunded') THEN o.fee_cents + o.organizer_fee_cents END),0) fees,
    COALESCE(SUM(CASE WHEN o.status IN ('paid','refunded','partially_refunded') THEN o.organizer_fee_cents END),0) fees_org,
    COALESCE((SELECT SUM(p.refunded_cents) FROM payments p JOIN orders o2 ON o2.id=p.order_id WHERE o2.event_id=e.id),0) refunds,
    COALESCE(SUM(CASE WHEN o.status='pending' THEN o.total_cents END),0) predicted,
    COUNT(CASE WHEN o.status='exception' THEN 1 END) exceptions
    FROM events e LEFT JOIN orders o ON o.event_id=e.id WHERE e.id IN (${ph}) GROUP BY e.id ORDER BY e.start_utc DESC`, ...eventIds);
}
r.get('/financeiro', perm('finance'), async (req, res) => {
  const evs = (await visibleEvents(req)).filter((e) => can(req.member, 'finance', e.id));
  const rows = await finance(evs.map((e) => e.id));
  const net = (x) => x.gross - x.discounts - x.fees_org - x.refunds;
  const rec = (await reconciliation(evs.map((e) => e.id))).slice(0, 100);
  res.page({ title: 'Financeiro', wide: true, body: html`${orgHeader(req, '/organizador/financeiro')}
  <section class="card"><div class="section-head"><h2>Resumo por evento</h2><a class="btn btn-ghost" href="/organizador/financeiro.csv">Exportar CSV</a></div>
  ${tip('Previsto = pedidos aguardando pagamento. Confirmado = pagamentos aprovados e validados. Disponível para saque é informado pelo Mercado Pago e depende do modelo de recebimento; consulte o painel do provedor.')}
  ${table(['Evento', 'Vendas brutas', 'Descontos', 'Taxas (organizador)', 'Reembolsos', 'Líquido confirmado', 'Previsto (pendente)', 'Exceções'], rows.map((x) => [x.name, brl(x.gross), brl(x.discounts), brl(x.fees_org), brl(x.refunds), html`<strong>${brl(net(x))}</strong>`, brl(x.predicted), x.exceptions ? badge(String(x.exceptions), 'danger') : '0']))}</section>
  <section class="card"><h2>Conciliação com o provedor</h2>${table(['Pedido', 'Situação do pedido', 'Valor', 'Transação', 'Situação no provedor', 'Reembolsado', 'Conferência'], rec.map((x) => [x.code, x.order_status, brl(x.total_cents), x.provider_payment_id ? `${x.provider} · ${x.provider_payment_id}` : '—', x.pay_status ? PAY_LABEL[x.pay_status] : '—', brl(x.refunded_cents), x.check_result === 'OK' ? badge('OK', 'ok') : badge(x.check_result, 'danger')]), { emptyMsg: 'Sem transações.' })}
  <p class="muted">Pedidos pendentes sem transação aparecem como "Pedido sem pagamento" enquanto aguardam o atleta.</p></section>` });
});
r.get('/financeiro.csv', perm('finance'), async (req, res) => {
  const evs = (await visibleEvents(req)).filter((e) => can(req.member, 'finance', e.id));
  const rows = await finance(evs.map((e) => e.id));
  await audit(req, 'export.finance', { orgId: req.org.id });
  res.type('text/csv').attachment('financeiro.csv').send(toCsv(rows, [{ label: 'Evento', key: 'name' }, { label: 'Vendas brutas', value: (x) => (x.gross / 100).toFixed(2) }, { label: 'Descontos', value: (x) => (x.discounts / 100).toFixed(2) }, { label: 'Taxas organizador', value: (x) => (x.fees_org / 100).toFixed(2) }, { label: 'Reembolsos', value: (x) => (x.refunds / 100).toFixed(2) }, { label: 'Líquido', value: (x) => ((x.gross - x.discounts - x.fees_org - x.refunds) / 100).toFixed(2) }, { label: 'Previsto', value: (x) => (x.predicted / 100).toFixed(2) }]));
});

// Suporte
r.get('/suporte', async (req, res) => {
  const t = await db.all('SELECT * FROM support_tickets WHERE org_id=? ORDER BY id DESC', req.org.id);
  res.page({ title: 'Suporte', wide: true, body: html`${orgHeader(req, '/organizador/suporte')}<section class="card"><h2>Solicitar suporte</h2><form method="post" action="/organizador/suporte">${csrf(req)}${field('subject', 'Assunto', { required: true })}${field('body', 'Descreva o que precisa', { type: 'textarea', required: true })}<button class="btn">Enviar</button></form></section>
  <section class="card"><h2>Minhas solicitações</h2>${table(['Assunto', 'Situação', 'Resposta', 'Data'], t.map((x) => [x.subject, x.status === 'open' ? badge('Aberta', 'warn') : badge('Respondida', 'ok'), x.response || '—', fmtDateTime(x.created_at)]), { emptyMsg: 'Nenhuma solicitação.' })}</section>` });
});
r.post('/suporte', async (req, res) => {
  if (!req.body.subject || !req.body.body) throw new UserError('Informe assunto e descrição.');
  await db.run('INSERT INTO support_tickets(user_id,org_id,subject,body) VALUES(?,?,?,?)', req.user.id, req.org.id, req.body.subject.slice(0, 200), req.body.body.slice(0, 4000));
  res.flash('success', 'Solicitação enviada à equipe da plataforma.');
  res.redirect(303, '/organizador/suporte');
});

// Chave de API (escopo: esta organização)
r.post('/api-key', async (req, res) => {
  if (req.member.role !== 'owner') throw new UserError('Somente o responsável gera chaves.', 403);
  const key = `org_${req.org.id}_${randomToken(24)}`;
  await db.run('UPDATE organizations SET api_key_hash=? WHERE id=?', sha256(key), req.org.id);
  await audit(req, 'org.api_key_rotated', { orgId: req.org.id });
  res.page({ title: 'Chave de API', body: html`<section class="card"><h1>Nova chave de API</h1><p>Copie agora; ela não será exibida novamente. A chave anterior foi revogada.</p><pre class="code">${key}</pre><a class="btn" href="/api/docs">Ver documentação</a></section>` });
});

module.exports = r;
module.exports.orgHeader = orgHeader;
module.exports.visibleEvents = visibleEvents;
