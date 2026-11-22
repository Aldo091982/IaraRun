'use strict';
/**
 * API de integração (item 21.6) — v1 somente leitura, escopo = organização da chave.
 * Autenticação: Authorization: Bearer <chave gerada no painel>. Paginação por ?page & ?per_page (máx. 100).
 * Limite: 60 requisições/minuto por chave. Acessos registrados em auditoria.
 * Webhooks de saída (inscrição, pagamento, kit, resultados) com assinatura: etapa seguinte.
 */
const express = require('express');
const db = require('../db');
const { sha256, audit } = require('../lib/core');
const { maskCpf, html } = require('../lib/util');
const { currentPublished, versionRows } = require('../lib/results');

const r = express.Router();
const hits = new Map();

r.get('/docs', (req, res) => res.page({ title: 'API', body: html`<article class="card prose"><h1>API para integrações (v1)</h1>
<p>Somente leitura. Cada chave pertence a uma organização e acessa apenas os dados dela. Gere ou revogue a chave no painel do organizador (Empresa › Chave de API, apenas responsável).</p>
<h2>Autenticação</h2><pre class="code">Authorization: Bearer org_123_xxxxxxxx</pre>
<h2>Endpoints</h2><ul><li><code>GET /api/v1/events</code> — eventos da organização</li><li><code>GET /api/v1/events/{id}/registrations?page=1&amp;per_page=50&amp;status=confirmed</code> — inscrições (CPF mascarado)</li><li><code>GET /api/v1/events/{id}/results</code> — resultado publicado mais recente</li></ul>
<h2>Limites</h2><p>60 requisições por minuto por chave (HTTP 429 ao exceder). Respostas paginadas trazem <code>page</code>, <code>per_page</code> e <code>total</code>.</p>
<h2>Privacidade</h2><p>Documentos privados e dados de pagamento nunca são expostos pela API.</p>
<h2>Próximas etapas</h2><p>Webhooks de saída assinados (HMAC-SHA256) para inscrição, pagamento, kit e resultados, com repetição controlada e idempotência; endpoint de envio de tempos para cronometragem.</p></article>` }));

r.use('/v1', (req, res, next) => {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  const org = m && db.one('SELECT * FROM organizations WHERE api_key_hash=?', sha256(m[1]));
  if (!org) return res.status(401).json({ error: 'Chave de API inválida.' });
  if (org.status === 'suspended') return res.status(403).json({ error: 'Organização suspensa.' });
  const now = Date.now(); const h = hits.get(org.id) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 60) { hits.set(org.id, h); return res.status(429).json({ error: 'Limite de requisições excedido.' }); }
  hits.set(org.id, h);
  req.apiOrg = org;
  audit(req, 'api.request', { orgId: org.id, detail: { path: req.originalUrl.slice(0, 200) } });
  next();
});
const page = (req) => { const per = Math.min(100, Math.max(1, Number(req.query.per_page) || 50)); const p = Math.max(1, Number(req.query.page) || 1); return { per, p, off: (p - 1) * per }; };
const orgEvent = (req) => db.one('SELECT * FROM events WHERE id=? AND org_id=?', Number(req.params.id), req.apiOrg.id);

r.get('/v1/events', (req, res) => {
  const { per, p, off } = page(req);
  const total = db.one('SELECT COUNT(*) n FROM events WHERE org_id=?', req.apiOrg.id).n;
  const data = db.all('SELECT id, slug, name, status, start_utc, timezone, city, state FROM events WHERE org_id=? ORDER BY id DESC LIMIT ? OFFSET ?', req.apiOrg.id, per, off);
  res.json({ data, page: p, per_page: per, total });
});
r.get('/v1/events/:id/registrations', (req, res) => {
  const ev = orgEvent(req); if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { per, p, off } = page(req);
  const st = req.query.status ? String(req.query.status) : null;
  const total = db.one(`SELECT COUNT(*) n FROM registrations WHERE event_id=? ${st ? 'AND status=?' : ''}`, ev.id, ...(st ? [st] : [])).n;
  const rows = db.all(`SELECT g.id, g.bib, g.name, g.cpf, g.gender, g.status, g.kit_size, m.name modality, c.name category, g.confirmed_at FROM registrations g JOIN modalities m ON m.id=g.modality_id LEFT JOIN categories c ON c.id=g.category_id WHERE g.event_id=? ${st ? 'AND g.status=?' : ''} ORDER BY g.id LIMIT ? OFFSET ?`, ev.id, ...(st ? [st] : []), per, off);
  res.json({ data: rows.map((x) => ({ ...x, cpf: maskCpf(x.cpf) })), page: p, per_page: per, total });
});
r.get('/v1/events/:id/results', (req, res) => {
  const ev = orgEvent(req); if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const v = currentPublished(ev.id);
  if (!v) return res.json({ data: [], version: null });
  res.json({ version: v.version, status: v.status, data: versionRows(v.id).map((x) => ({ bib: x.bib, name: x.name, modality: x.modality_name, category: x.category_name, gun_s: x.gun_s, net_s: x.net_s, status: x.status, rank_overall: x.rank_overall, rank_category: x.rank_category })) });
});
module.exports = r;
