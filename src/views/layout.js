'use strict';
const config = require('../config');
const { html, raw, esc } = require('../lib/util');
const { MODE_LABEL } = require('../lib/payments');

const APP_NAME = process.env.APP_NAME || 'Largada';

function nav(req) {
  const u = req.user;
  const ctx = req.session?.context || 'athlete';
  const orgs = req.memberships || [];
  const links = [html`<a href="/eventos">Eventos</a>`, html`<a href="/organizadores">Para organizadores</a>`];
  if (!u) return html`${links}<a href="/entrar">Entrar</a><a class="btn btn-sm" href="/cadastro">Criar conta</a>`;
  const ctxOptions = [html`<option value="athlete" ${ctx === 'athlete' ? 'selected' : ''}>Atleta</option>`,
    ...orgs.map((m) => html`<option value="org:${m.org_id}" ${ctx === `org:${m.org_id}` ? 'selected' : ''}>Organizador · ${m.trade_name || m.legal_name || 'Empresa em cadastro'}</option>`),
    u.is_admin ? html`<option value="admin" ${ctx === 'admin' ? 'selected' : ''}>Administração</option>` : ''];
  const home = ctx === 'admin' ? '/admin' : ctx.startsWith('org:') ? '/organizador' : '/minha-conta';
  return html`${links}<a href="${home}">Meu painel</a>
    <form method="post" action="/contexto" class="ctx-switch">${csrf(req)}
      <label class="sr-only" for="ctx">Perfil em uso</label>
      <select id="ctx" name="context" onchange="this.form.submit()">${ctxOptions}</select>
      <noscript><button class="btn btn-sm">Trocar</button></noscript>
    </form>
    <form method="post" action="/sair">${csrf(req)}<button class="linklike">Sair</button></form>`;
}

const csrf = (req) => html`<input type="hidden" name="_csrf" value="${req.csrfToken || ''}">`;

function page(req, { title, body, wide = false, description }) {
  const flash = req.flash || [];
  const demoBanner = config.isProd ? '' : html`<div class="env-banner" role="note">Ambiente de ${config.env === 'test' ? 'testes' : 'desenvolvimento'} · Pagamentos: ${MODE_LABEL[config.mp.mode]} · E-mails vão para a <a href="/dev/caixa-de-saida">caixa de saída local</a></div>`;
  const consent = req.cookies?.cookie_consent;
  const analytics = consent === 'all' && (config.analytics.ga || config.analytics.metaPixel)
    ? raw(`${config.analytics.ga ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(config.analytics.ga)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${esc(config.analytics.ga)}');</script>` : ''}`)
    : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title ? `${title} · ${APP_NAME}` : APP_NAME)}</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap"><link rel="stylesheet" href="/static/css/app.css"><script src="/static/js/app.js" defer></script>${analytics}</head>
<body><a class="skip" href="#conteudo">Pular para o conteúdo</a>${demoBanner}
<header class="topbar"><div class="wrap topbar-in"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">▲</span>${APP_NAME}</a>
<button class="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button><nav id="menu" class="nav" aria-label="Principal">${nav(req)}</nav></div></header>
<main id="conteudo" class="${wide ? 'wrap wide' : 'wrap'}">${flash.map((f) => `<div class="alert alert-${esc(f.type)}" role="${f.type === 'error' ? 'alert' : 'status'}">${esc(f.msg)}</div>`).join('')}${body}</main>
<footer class="footer"><div class="wrap"><p><strong>${APP_NAME}</strong> — plataforma de eventos esportivos.</p>
<p><a href="/legal/terms">Termos de Uso</a> · <a href="/legal/privacy">Política de Privacidade</a> · <a href="/legal/organizer">Termos do Organizador</a> · <a href="/api/docs">API</a></p></div></footer>
${consent ? '' : `<div class="cookie" role="dialog" aria-label="Preferências de privacidade"><p>Usamos cookies essenciais para login e segurança. Cookies de medição (Google Analytics/Meta Pixel) só são ativados com sua autorização.</p><form method="post" action="/privacidade/cookies"><input type="hidden" name="_csrf" value="${esc(req.csrfToken || '')}"><button name="choice" value="essential" class="btn btn-ghost btn-sm">Somente essenciais</button> <button name="choice" value="all" class="btn btn-sm">Aceitar medição</button></form></div>`}
</body></html>`;
}

// ---------- componentes ----------
const badge = (label, tone = 'muted') => html`<span class="badge badge-${tone}">${label}</span>`;
function field(name, label, { value = '', type = 'text', required, hint, error, attrs = '', options, rows, placeholder, id } = {}) {
  const fid = id || `f-${name.replace(/[^a-z0-9_-]/gi, '-')}`;
  const describedBy = [hint ? `${fid}-hint` : '', error ? `${fid}-err` : ''].filter(Boolean).join(' ');
  const common = `id="${esc(fid)}" name="${esc(name)}" ${required ? 'required' : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''} ${error ? 'aria-invalid="true"' : ''} ${placeholder ? `placeholder="${esc(placeholder)}"` : ''} ${attrs}`;
  let input;
  if (options) input = `<select ${common}>${options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  else if (type === 'textarea') input = `<textarea ${common} rows="${rows || 4}">${esc(value)}</textarea>`;
  else if (type === 'checkbox') return raw(`<div class="field field-check"><input type="checkbox" ${common} value="1" ${value ? 'checked' : ''}><label for="${esc(fid)}">${label instanceof require('../lib/util').Raw ? label : esc(label)}</label>${hint ? `<small id="${fid}-hint" class="hint">${esc(hint)}</small>` : ''}${error ? `<small id="${fid}-err" class="err">${esc(error)}</small>` : ''}</div>`);
  else input = `<input type="${type}" ${common} value="${esc(value)}">`;
  return raw(`<div class="field${error ? ' has-error' : ''}"><label for="${esc(fid)}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>${input}${hint ? `<small id="${fid}-hint" class="hint">${esc(hint)}</small>` : ''}${error ? `<small id="${fid}-err" class="err">${esc(error)}</small>` : ''}</div>`);
}
const empty = (msg, action) => html`<div class="empty"><p>${msg}</p>${action || ''}</div>`;
const tip = (msg) => html`<p class="tip" role="note"><span aria-hidden="true">💡</span> ${msg}</p>`;
function steps(list, current) {
  return html`<ol class="steps" aria-label="Etapas">${list.map((s, i) => html`<li class="${i + 1 === current ? 'current' : i + 1 < current ? 'done' : ''}" ${i + 1 === current ? raw('aria-current="step"') : ''}>${s.href && i + 1 !== current ? html`<a href="${s.href}">${s.label}</a>` : s.label}</li>`)}</ol>
    <p class="steps-label">Etapa ${current} de ${list.length}: <strong>${list[current - 1].label}</strong></p>`;
}
function table(headers, rows, { emptyMsg = 'Nenhum registro.' } = {}) {
  if (!rows.length) return empty(emptyMsg);
  return html`<div class="table-wrap"><table><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}
const errorsBox = (errs) => (errs && errs.length ? html`<div class="alert alert-error" role="alert"><strong>Corrija os itens abaixo para continuar:</strong><ul>${errs.map((e) => html`<li>${e}</li>`)}</ul></div>` : '');

module.exports = { page, csrf, badge, field, empty, tip, steps, table, errorsBox, APP_NAME };
