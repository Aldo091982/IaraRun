'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { html, json, UserError, nowIso } = require('../lib/util');
const { isCnpj, digits, fmtCnpj, isEmail, isPhone, isUrl } = require('../lib/docs');
const cnpjProvider = require('../lib/cnpjProvider');
const { audit, LEGAL, recordConsent, hasConsent, sendMail, settings } = require('../lib/core');
const { refreshStatus, ownerOf } = require('../lib/orgs');
const { upload, checkFile, store, csrfAfterMultipart } = require('../lib/guards');
const { page, csrf, field, steps, errorsBox, tip, badge } = require('../views/layout');

const r = express.Router();
const STEPS = ['Boas-vindas e conta', 'Empresa e documentação', 'Contatos e confirmações', 'Revisão e conclusão'];
const IMG = ['image/png', 'image/jpeg', 'image/webp'], DOC = ['application/pdf', 'image/png', 'image/jpeg'];
const LINK_ROLES = [['', 'Selecione'], ['titular_mei', 'Titular do MEI'], ['socio', 'Sócio(a) ou administrador(a)'], ['procurador', 'Procurador(a) com procuração'], ['representante', 'Representante autorizado(a)']];

async function draft(userId) {
  let d = await db.one('SELECT * FROM onboarding_drafts WHERE user_id=?', userId);
  if (!d) { await db.run('INSERT INTO onboarding_drafts(user_id) VALUES(?)', userId); d = await db.one('SELECT * FROM onboarding_drafts WHERE user_id=?', userId); }
  return { ...d, data: json(d.data, {}) };
}
async function saveDraft(userId, patch) {
  const d = await draft(userId);
  await db.run('UPDATE onboarding_drafts SET step=COALESCE(?,step), data=?, org_id=COALESCE(?,org_id), updated_at=? WHERE user_id=?', patch.step ?? null, JSON.stringify({ ...d.data, ...(patch.data || {}) }), patch.org_id ?? null, nowIso(), userId);
}
const stepLinks = (maxReached) => STEPS.map((label, i) => ({ label, href: i + 1 <= maxReached ? `/organizador/cadastro?etapa=${i + 1}` : null }));
const nav = (step, { next = 'Avançar' } = {}) => html`<div class="wizard-nav">
  ${step > 1 ? html`<a class="btn btn-ghost" href="/organizador/cadastro?etapa=${step - 1}">Voltar</a>` : raw0()}
  <button class="btn btn-ghost" name="acao" value="salvar">Salvar e continuar depois</button>
  <button class="btn" name="acao" value="avancar">${next}</button></div>`;
const raw0 = () => '';

async function docsOf(orgId) { return orgId ? await db.all('SELECT * FROM documents WHERE org_id=? ORDER BY id DESC', orgId) : []; }
const DOC_STATUS = { submitted: ['Enviado — aguardando análise', 'warn'], verified: ['Verificado', 'ok'], rejected: ['Recusado', 'danger'] };

async function render(req, res, step, { errors = [], fieldErr = {}, notice, lookup } = {}) {
  const d = await draft(req.user.id);
  const org = d.org_id ? await db.one('SELECT * FROM organizations WHERE id=?', d.org_id) : null;
  const max = Math.max(d.step, step);
  let body;
  if (step === 1) {
    body = html`<h2>Bem-vindo(a)! Vamos começar.</h2>
    <p>Nesta versão, o cadastro de organizadores é feito com <strong>CNPJ</strong> — incluindo <strong>MEI</strong>. Você levará cerca de 10 minutos e pode parar e retomar quando quiser: o progresso fica salvo na sua conta.</p>
    <ul class="checklist"><li>Conta do responsável: <strong>${req.user.name}</strong> (${req.user.email}) ${req.user.email_verified_at ? badge('E-mail confirmado', 'ok') : badge('E-mail pendente', 'warn')}</li>
    <li>Tenha em mãos: CNPJ, logomarca, documento oficial com foto e comprovação de vínculo com a empresa.</li></ul>
    ${req.user.email_verified_at ? '' : html`<div class="alert alert-warn">Confirme seu e-mail pelo link enviado. Você pode continuar o cadastro enquanto isso. <form method="post" action="/reenviar-confirmacao" class="inline">${csrf(req)}<button class="linklike">Reenviar link</button></form></div>`}
    <p class="muted">Não é você? <a href="/entrar?volta=/organizador/cadastro">Entrar com outra conta</a>. Esta conta continuará valendo para inscrições como atleta.</p>
    <form method="post" action="/organizador/cadastro/1">${csrf(req)}${nav(1, { next: 'Começar' })}</form>`;
  } else if (step === 2) {
    const v = { ...(org || {}), ...(lookup?.data || {}), ...json(org?.address, {}), ...(lookup?.data?.address || {}), ...d.data, ...(req.body?.cnpj ? req.body : {}) };
    const fromProvider = (lookup?.ok) || (org && org.cnpj_source.startsWith('provider:'));
    const docs = await docsOf(org?.id);
    const s = await settings();
    body = html`<h2>Empresa e documentação</h2>
    ${errorsBox(errors)}${notice || ''}
    <form method="post" action="/organizador/cadastro/2" enctype="multipart/form-data" novalidate>${csrf(req)}
    <fieldset><legend>CNPJ</legend><div class="row">${field('cnpj', 'CNPJ da empresa ou MEI', { value: v.cnpj ? fmtCnpj(v.cnpj) : '', required: true, error: fieldErr.cnpj, attrs: 'inputmode="numeric" data-mask="cnpj"', hint: 'Somente números ou com pontuação.' })}
      <button class="btn btn-ghost" name="acao" value="buscar" formnovalidate>Buscar empresa</button></div>
      ${config.cnpj.provider ? tip(`Consulta cadastral realizada pelo fornecedor de dados: ${config.cnpj.name}. Não é uma validação direta junto à Receita Federal.`) : tip('Consulta cadastral automática não configurada neste ambiente: preencha os dados manualmente. Eles ficarão como "pendente de verificação" até a análise da equipe.')}</fieldset>
    <fieldset><legend>Dados da empresa ${fromProvider ? badge('Preenchido pela consulta cadastral', 'info') : badge('Preenchimento manual — pendente de verificação', 'warn')}</legend>
      ${field('legal_name', 'Razão social', { value: v.legal_name, required: true, error: fieldErr.legal_name })}
      ${field('trade_name', 'Nome fantasia (exibido aos atletas)', { value: v.trade_name, required: true, error: fieldErr.trade_name })}
      ${fromProvider ? html`<p>Situação cadastral: <strong>${v.cnpj_status || 'não informada'}</strong></p>` : ''}
      <div class="row">${field('zip', 'CEP', { value: v.zip })}${field('street', 'Logradouro', { value: v.street })}${field('number', 'Número', { value: v.number })}</div>
      <div class="row">${field('district', 'Bairro', { value: v.district })}${field('city', 'Cidade', { value: v.city, required: true, error: fieldErr.city })}${field('state', 'UF', { value: v.state, required: true, error: fieldErr.state, options: [['', '—'], ...require('../lib/util').UF] })}</div></fieldset>
    <fieldset><legend>Logomarca</legend>${org?.logo_path ? html`<img src="/media/${org.logo_path}" alt="Logomarca atual" class="org-logo">` : ''}
      <div class="field"><label for="logo">Arquivo da logomarca</label><input type="file" id="logo" name="logo" accept="image/png,image/jpeg,image/webp" data-preview="logo-prev" aria-describedby="logo-hint"><small id="logo-hint" class="hint">PNG, JPG ou WEBP até 2 MB. Recomendado: quadrada, mínimo 400×400 px, fundo transparente ou branco.</small><img id="logo-prev" class="org-logo" alt="Prévia da logomarca" hidden></div></fieldset>
    <fieldset><legend>Responsável e vínculo com a empresa</legend>
      ${field('link_role', 'Seu vínculo com a empresa', { value: v.link_role, options: LINK_ROLES, required: true, error: fieldErr.link_role })}
      <div class="field"><label for="identity">Documento oficial com foto do responsável${s.require_identity_document ? ' *' : ''}</label><input type="file" id="identity" name="identity" accept="application/pdf,image/png,image/jpeg"><small class="hint">RG, CNH ou passaporte. PDF, JPG ou PNG até 5 MB. Armazenado em área privada, acessível apenas à equipe de verificação.</small>${fieldErr.identity ? html`<small class="err">${fieldErr.identity}</small>` : ''}</div>
      <div class="field"><label for="link_doc">Comprovante de vínculo (contrato social, certificado MEI ou procuração)</label><input type="file" id="link_doc" name="link_doc" accept="application/pdf,image/png,image/jpeg"><small class="hint">PDF, JPG ou PNG até 5 MB.</small></div>
      ${docs.length ? html`<ul class="doc-list">${docs.map((x) => html`<li>${x.kind === 'identity' ? 'Documento do responsável' : 'Comprovante de vínculo'} — ${x.original_name} ${badge(...DOC_STATUS[x.status])}</li>`)}</ul><p class="muted">"Enviado" não significa identidade verificada: a verificação é feita pela equipe da plataforma.</p>` : ''}
    </fieldset>${nav(2)}</form>`;
  } else if (step === 3) {
    const v = { ...(org || {}), ...d.data };
    const accepted = async (k) => await hasConsent(req.user.id, k);
    body = html`<h2>Contatos e confirmações</h2>${errorsBox(errors)}
    <form method="post" action="/organizador/cadastro/3" novalidate>${csrf(req)}
    <div class="info-split"><div><h3>Públicos (aparecem na página dos eventos)</h3><p>Nome fantasia, logomarca, site, apresentação, e-mail e telefone de atendimento.</p></div><div><h3>Internos (somente plataforma)</h3><p>Razão social, endereço, documentos, dados do responsável e informações de recebimento.</p></div></div>
    ${field('support_email', 'E-mail de atendimento aos atletas', { type: 'email', value: v.support_email, required: true, error: fieldErr.support_email })}
    ${field('support_phone', 'Telefone/WhatsApp de atendimento', { type: 'tel', value: v.support_phone, required: true, error: fieldErr.support_phone, hint: 'Com DDD.' })}
    ${field('website', 'Site oficial (opcional)', { type: 'url', value: v.website, error: fieldErr.website, placeholder: 'https://' })}
    ${field('bio', 'Apresentação da empresa (opcional)', { type: 'textarea', value: v.bio, attrs: 'maxlength="800"' })}
    <fieldset><legend>Documentos e aceites</legend>
      ${field('accept_terms', html`Li e aceito os <a href="/legal/terms" target="_blank">Termos de Uso</a> (v. ${LEGAL.terms.version})`, { type: 'checkbox', value: await accepted('terms') || v.accept_terms, error: fieldErr.accept_terms })}
      ${field('accept_privacy', html`Li e aceito a <a href="/legal/privacy" target="_blank">Política de Privacidade</a> (v. ${LEGAL.privacy.version})`, { type: 'checkbox', value: await accepted('privacy') || v.accept_privacy, error: fieldErr.accept_privacy })}
      ${field('accept_organizer', html`Li e aceito os <a href="/legal/organizer" target="_blank">Termos do Organizador</a> (v. ${LEGAL.organizer.version}), incluindo responsabilidade pelas informações dos eventos`, { type: 'checkbox', value: await accepted('organizer') || v.accept_organizer, error: fieldErr.accept_organizer })}
      <p class="muted">Registramos usuário, versão do documento e data de cada aceite.</p>
      ${field('marketing', 'Aceito receber comunicações promocionais da plataforma (opcional, separado dos aceites acima)', { type: 'checkbox', value: req.user.marketing_opt_in })}</fieldset>
    ${nav(3)}</form>`;
  } else {
    const docs = await docsOf(org?.id); const addr = json(org?.address, {});
    const problems = await completeness(req.user, org, d);
    body = html`<h2>Revisão e conclusão</h2>${errorsBox(errors.length ? errors : problems.length ? problems.map((p) => p.msg) : [])}
    <dl class="review">
      <dt>Responsável</dt><dd>${req.user.name} — ${req.user.email} ${req.user.email_verified_at ? badge('confirmado', 'ok') : badge('e-mail pendente', 'warn')} <a href="/minha-conta/perfil">editar</a></dd>
      <dt>Empresa</dt><dd>${org ? html`${org.trade_name} (${org.legal_name}) — CNPJ ${fmtCnpj(org.cnpj)}<br>${addr.street || ''} ${addr.number || ''} ${addr.district || ''} ${addr.city}/${addr.state}<br>Origem dos dados: ${org.cnpj_source === 'manual' ? 'preenchimento manual (pendente de verificação)' : org.cnpj_source.replace('provider:', 'consulta cadastral — ')}` : 'não informada'} <a href="/organizador/cadastro?etapa=2">editar</a></dd>
      <dt>Documentos</dt><dd>${docs.length ? docs.map((x) => html`${x.kind === 'identity' ? 'Documento do responsável' : 'Comprovante de vínculo'}: ${DOC_STATUS[x.status][0]}<br>`) : 'nenhum enviado'} <a href="/organizador/cadastro?etapa=2">editar</a></dd>
      <dt>Atendimento</dt><dd>${org?.support_email || '—'} · ${org?.support_phone || '—'}${org?.website ? html` · ${org.website}` : ''} <a href="/organizador/cadastro?etapa=3">editar</a></dd>
      <dt>Aceites</dt><dd>${await Promise.all(['terms', 'privacy', 'organizer'].map(async (k) => html`${LEGAL[k].title}: ${await hasConsent(req.user.id, k) ? 'aceito' : 'pendente'}<br>`))}</dd></dl>
    <form method="post" action="/organizador/cadastro/4">${csrf(req)}<div class="wizard-nav"><a class="btn btn-ghost" href="/organizador/cadastro?etapa=3">Voltar</a><button class="btn btn-ghost" name="acao" value="salvar">Salvar e continuar depois</button><button class="btn" name="acao" value="concluir" ${problems.length ? 'disabled' : ''}>Concluir cadastro</button></div></form>
    <p class="muted">Após concluir, o painel abre com a situação da conta. Você poderá preparar eventos em rascunho enquanto a verificação estiver pendente.</p>`;
  }
  res.status(errors.length ? 400 : 200).send(page(req, { title: 'Cadastro do organizador', body: html`<section class="card wizard"><h1>Cadastro do organizador</h1>${steps(stepLinks(max), step)}${body}</section>` }));
}

async function completeness(user, org, d) {
  const p = [];
  if (!org) { p.push({ msg: 'Informe e salve os dados da empresa (etapa 2).' }); return p; }
  if (!org.legal_name || !org.trade_name) p.push({ msg: 'Razão social e nome fantasia (etapa 2).' });
  if (!json(org.address, {}).city) p.push({ msg: 'Cidade e UF da empresa (etapa 2).' });
  if (!d.data.link_role) p.push({ msg: 'Seu vínculo com a empresa (etapa 2).' });
  if ((await settings()).require_identity_document && !await db.one("SELECT 1 FROM documents WHERE org_id=? AND kind='identity'", org.id)) p.push({ msg: 'Documento oficial do responsável (etapa 2).' });
  if (!isEmail(org.support_email) || !isPhone(org.support_phone)) p.push({ msg: 'E-mail e telefone de atendimento (etapa 3).' });
  for (const k of ['terms', 'privacy', 'organizer']) if (!await hasConsent(user.id, k)) p.push({ msg: `Aceite: ${LEGAL[k].title} (etapa 3).` });
  return p;
}

r.get('/cadastro', async (req, res) => {
  if (!req.user) return res.redirect(303, '/cadastro?perfil=organizador');
  const d = await draft(req.user.id);
  if (d.org_id) { const o = await db.one('SELECT status FROM organizations WHERE id=?', d.org_id); if (o && o.status !== 'onboarding') return res.redirect(303, `/contexto/org:${d.org_id}?volta=/organizador`); }
  const step = Math.min(4, Math.max(1, Number(req.query.etapa) || d.step));
  render(req, res, Math.min(step, d.step)); // não permite pular etapas ainda não alcançadas
});

async function afterSave(req, res, step, acao) {
  if (acao === 'salvar') { res.flash('success', 'Progresso salvo. Retome quando quiser em "Para organizadores" › Começar cadastro.'); return res.redirect(303, '/minha-conta'); }
  await saveDraft(req.user.id, { step: Math.max((await draft(req.user.id)).step, step + 1) });
  res.redirect(303, `/organizador/cadastro?etapa=${step + 1}`);
}

r.post('/cadastro/1', async (req, res) => { if (!req.user) return res.redirect(303, '/cadastro?perfil=organizador'); await afterSave(req, res, 1, req.body.acao); });

r.post('/cadastro/2', upload(5).fields([{ name: 'logo', maxCount: 1 }, { name: 'identity', maxCount: 1 }, { name: 'link_doc', maxCount: 1 }]), csrfAfterMultipart, async (req, res) => {
  if (!req.user) return res.redirect(303, '/entrar');
  const b = req.body; const d = await draft(req.user.id);
  const cnpj = digits(b.cnpj);
  let org = d.org_id ? await db.one('SELECT * FROM organizations WHERE id=?', d.org_id) : null;
  if (!isCnpj(cnpj)) return render(req, res, 2, { errors: ['CNPJ inválido. Confira os 14 dígitos.'], fieldErr: { cnpj: 'CNPJ inválido' } });
  const existing = await db.one('SELECT * FROM organizations WHERE cnpj=?', cnpj);
  if (existing && existing.id !== org?.id) {
    const isMember = await db.one('SELECT 1 FROM org_members WHERE org_id=? AND user_id=?', existing.id, req.user.id);
    if (isMember) return res.redirect(303, `/contexto/org:${existing.id}?volta=/organizador`);
    const pending = await db.one("SELECT * FROM org_access_requests WHERE org_id=? AND user_id=? AND status='pending'", existing.id, req.user.id);
    return render(req, res, 2, { errors: ['Esta empresa já está cadastrada na plataforma. Por segurança, não é possível assumir a conta apenas com o CNPJ.'],
      notice: html`<div class="card callout"><h3>Solicitar acesso à empresa já cadastrada</h3>${pending ? html`<p>${badge('Solicitação enviada', 'info')} Aguarde a aprovação do responsável atual ou da equipe da plataforma.</p>` : html`<p>Enviaremos sua solicitação ao responsável atual e à equipe de verificação, que confirmarão seu vínculo.</p>
      <form method="post" action="/organizador/cadastro/solicitar-acesso">${csrf(req)}<input type="hidden" name="org_id" value="${existing.id}">${field('message', 'Explique seu vínculo com a empresa', { type: 'textarea', required: true })}<button class="btn">Solicitar acesso</button></form>`}</div>` });
  }
  if (b.acao === 'buscar') {
    const lk = await cnpjProvider.lookup(cnpj);
    const notice = lk.ok ? html`<div class="alert alert-success">Empresa encontrada. Confira os dados abaixo antes de avançar.</div>` : html`<div class="alert alert-${lk.error === 'invalid' ? 'error' : 'warn'}">${lk.message}</div>`;
    if (lk.ok) await saveDraft(req.user.id, { data: { lookup: { ...lk.data, source: lk.source, cnpj, at: nowIso() } } });
    return render(req, res, 2, { notice, lookup: lk });
  }
  const errors = [], fieldErr = {};
  const lookupData = d.data.lookup?.cnpj === cnpj ? d.data.lookup : null;
  if (!b.legal_name?.trim()) fieldErr.legal_name = 'Obrigatório';
  if (!b.trade_name?.trim()) fieldErr.trade_name = 'Obrigatório';
  if (!b.city?.trim()) fieldErr.city = 'Obrigatório';
  if (!b.state) fieldErr.state = 'Obrigatório';
  if (!b.link_role) fieldErr.link_role = 'Obrigatório';
  let files;
  try {
    files = { logo: checkFile(req.files?.logo?.[0], IMG, 'Logomarca'), identity: checkFile(req.files?.identity?.[0], DOC, 'Documento do responsável'), link_doc: checkFile(req.files?.link_doc?.[0], DOC, 'Comprovante de vínculo') };
    if (files.logo && files.logo.size > 2 * 1024 * 1024) throw new UserError('Logomarca acima de 2 MB.');
  } catch (e) { errors.push(e.message); files = {}; }
  const strict = b.acao !== 'salvar';
  if (strict && Object.keys(fieldErr).length) errors.push('Preencha os campos obrigatórios destacados.');
  if (errors.length) return render(req, res, 2, { errors, fieldErr });

  const address = JSON.stringify({ zip: b.zip || '', street: b.street || '', number: b.number || '', district: b.district || '', city: b.city || '', state: b.state || '' });
  const source = lookupData ? lookupData.source : 'manual';
  await db.tx(async () => {
    if (!org) {
      const id = Number((await db.run('INSERT INTO organizations(cnpj,legal_name,trade_name,cnpj_status,address,cnpj_source,cnpj_checked_at,status) VALUES(?,?,?,?,?,?,?,?)', cnpj, b.legal_name?.trim(), b.trade_name?.trim(), lookupData?.cnpj_status || null, address, source, lookupData?.at || null, 'onboarding')).lastInsertRowid);
      await db.run("INSERT INTO org_members(org_id,user_id,role) VALUES(?,?,'owner')", id, req.user.id);
      await saveDraft(req.user.id, { org_id: id });
      org = await db.one('SELECT * FROM organizations WHERE id=?', id);
      await audit(req, 'org.created', { orgId: id, entity: 'organization', entityId: id, detail: { source } });
    } else {
      // Se os dados vieram do fornecedor e o usuário alterou a razão social, passa a ser manual
      const src = lookupData && lookupData.legal_name === b.legal_name?.trim() ? source : (org.cnpj_source !== 'manual' && org.legal_name === b.legal_name?.trim() && org.cnpj === cnpj ? org.cnpj_source : 'manual');
      await db.run('UPDATE organizations SET cnpj=?, legal_name=?, trade_name=?, address=?, cnpj_source=?, cnpj_status=COALESCE(?,cnpj_status) WHERE id=?', cnpj, b.legal_name?.trim(), b.trade_name?.trim(), address, src, lookupData?.cnpj_status || null, org.id);
      await audit(req, 'org.updated', { orgId: org.id, entity: 'organization', entityId: org.id });
    }
    if (files.logo) await db.run('UPDATE organizations SET logo_path=? WHERE id=?', store(files.logo, { isPrivate: false }), org.id);
    for (const [kind, f] of [['identity', files.identity], ['link_proof', files.link_doc]]) {
      if (!f) continue;
      const key = store(f, { isPrivate: true });
      await db.run('INSERT INTO documents(org_id,user_id,kind,storage_key,original_name,mime,size) VALUES(?,?,?,?,?,?,?)', org.id, req.user.id, kind, key, f.originalname.slice(0, 120), f.mimetype, f.size);
      await audit(req, 'document.uploaded', { orgId: org.id, entity: 'document', detail: { kind } });
    }
    await saveDraft(req.user.id, { data: { link_role: b.link_role } });
  });
  if (strict && (await settings()).require_identity_document && !await db.one("SELECT 1 FROM documents WHERE org_id=? AND kind='identity'", org.id)) return render(req, res, 2, { errors: ['Envie o documento oficial com foto do responsável.'], fieldErr: { identity: 'Obrigatório' } });
  await afterSave(req, res, 2, b.acao);
});

r.post('/cadastro/solicitar-acesso', async (req, res) => {
  if (!req.user) return res.redirect(303, '/entrar');
  const org = await db.one('SELECT * FROM organizations WHERE id=?', Number(req.body.org_id));
  if (!org) throw new UserError('Empresa não encontrada.');
  if (!req.body.message || req.body.message.trim().length < 10) throw new UserError('Descreva seu vínculo com a empresa (mínimo 10 caracteres).');
  if (!await db.one("SELECT 1 FROM org_access_requests WHERE org_id=? AND user_id=? AND status='pending'", org.id, req.user.id)) {
    await db.run('INSERT INTO org_access_requests(org_id,user_id,message) VALUES(?,?,?)', org.id, req.user.id, req.body.message.trim().slice(0, 1000));
    const owner = await ownerOf(org.id);
    if (owner) await sendMail(owner.email, 'Solicitação de acesso à sua empresa', `${req.user.name} (${req.user.email}) solicitou acesso à empresa ${org.trade_name}. Revise em Painel do organizador › Equipe. Se não reconhecer, recuse a solicitação.`);
    await audit(req, 'org.access_requested', { orgId: org.id, entity: 'organization', entityId: org.id });
  }
  res.flash('success', 'Solicitação enviada. Você será avisado(a) por e-mail.');
  res.redirect(303, '/minha-conta');
});

r.post('/cadastro/3', async (req, res) => {
  if (!req.user) return res.redirect(303, '/entrar');
  const b = req.body; const d = await draft(req.user.id);
  const org = d.org_id && await db.one('SELECT * FROM organizations WHERE id=?', d.org_id);
  if (!org) return res.redirect(303, '/organizador/cadastro?etapa=2');
  const fieldErr = {};
  if (!isEmail(b.support_email)) fieldErr.support_email = 'Informe um e-mail válido';
  if (!isPhone(b.support_phone)) fieldErr.support_phone = 'Informe telefone com DDD';
  if (b.website && !isUrl(b.website)) fieldErr.website = 'Use um endereço completo começando com https://';
  for (const k of ['terms', 'privacy', 'organizer']) if (!b[`accept_${k}`] && !await hasConsent(req.user.id, k)) fieldErr[`accept_${k}`] = 'Aceite obrigatório para concluir';
  await db.run('UPDATE organizations SET support_email=?, support_phone=?, website=?, bio=? WHERE id=?', b.support_email?.trim() || null, b.support_phone?.trim() || null, b.website && isUrl(b.website) ? b.website.trim() : null, b.bio?.trim().slice(0, 800) || null, org.id);
  for (const k of ['terms', 'privacy', 'organizer']) if (b[`accept_${k}`] && !await hasConsent(req.user.id, k)) await recordConsent(req, req.user.id, k, 'organizer_onboarding');
  const wants = b.marketing ? 1 : 0;
  if (wants !== req.user.marketing_opt_in) { await db.run('UPDATE users SET marketing_opt_in=? WHERE id=?', wants, req.user.id); await recordConsent(req, req.user.id, wants ? 'marketing' : 'marketing_revoked', 'organizer_onboarding'); }
  if (b.acao !== 'salvar' && Object.keys(fieldErr).length) return render(req, res, 3, { errors: Object.values(fieldErr).map((m, i) => `${['E-mail de atendimento', 'Telefone', 'Site', 'Aceite'][Math.min(i, 3)]}: ${m}`), fieldErr });
  await afterSave(req, res, 3, b.acao);
});

r.post('/cadastro/4', async (req, res) => {
  if (!req.user) return res.redirect(303, '/entrar');
  if (req.body.acao === 'salvar') return await afterSave(req, res, 4, 'salvar');
  const d = await draft(req.user.id);
  const org = d.org_id && await db.one('SELECT * FROM organizations WHERE id=?', d.org_id);
  const problems = await completeness(req.user, org, d);
  if (problems.length) return render(req, res, 4, { errors: problems.map((p) => p.msg) });
  await db.run("UPDATE organizations SET status='email_pending' WHERE id=? AND status='onboarding'", org.id);
  const st = await refreshStatus(org.id);
  await db.run('UPDATE sessions SET context=? WHERE id=?', `org:${org.id}`, req.session.id);
  await audit(req, 'org.onboarding_completed', { orgId: org.id, entity: 'organization', entityId: org.id, detail: { status: st } });
  await sendMail(req.user.email, 'Cadastro de organizador concluído', `O cadastro da ${org.trade_name} foi concluído. Situação: ${st === 'email_pending' ? 'confirme seu e-mail' : 'verificação em análise'}. Você já pode preparar seu primeiro evento em rascunho.`);
  res.flash('success', 'Cadastro concluído! Veja abaixo as próximas tarefas.');
  res.redirect(303, '/organizador');
});
module.exports = r;
