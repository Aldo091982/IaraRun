'use strict';
const db = require('../db');
const { counts } = require('./events');
const { UserError } = require('./util');

/** Itens que a plataforma costuma entregar no kit (tênis fica de fora). */
const SUGGESTED_ITEMS = ['Número de peito', 'Chip de cronometragem', 'Medalha de participação', 'Boné', 'Viseira', 'Sacola/Ecobag', 'Squeeze/Garrafa', 'Meia', 'Toalha', 'Barra ou gel energético'];
const MOVE_KIND = { in: 'Entrada', out: 'Saída/perda', set: 'Definir total', add: 'Item adicionado', remove: 'Item removido' };

const MAX_STOCK = 1000000;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
function assertNotShoe(name) { if (norm(name).includes('tenis')) throw new UserError(`"${name}" não pode entrar no kit: tênis não faz parte do kit. Cadastre camiseta, boné, medalha e outros itens.`); }

/** "Nome:quantidade" separado por vírgula. Com optional, "Nome" sem quantidade vira [nome, null] (sem controle de estoque). */
const parsePairs = (s, { max = 20, label = 'Tamanho:Quantidade', optional = false } = {}) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
  const i = x.lastIndexOf(':'); const k = (i < 0 ? x : x.slice(0, i)).trim(); const n = i < 0 ? null : x.slice(i + 1).trim();
  if (optional && k && (n == null || n === '')) return [k.slice(0, max), null];
  if (!k || n == null || !(Number(n) >= 0)) throw new UserError(`Formato inválido em "${x}". Use ${label}.`);
  if (Number(n) > MAX_STOCK) throw new UserError(`Quantidade muito alta em "${x}".`);
  return [k.slice(0, max), Math.floor(Number(n))];
});

/** Itens do formulário: texto livre + sugestões marcadas (item_s0..item_s9). Sem duplicados e sem tênis. */
function parseKitItems(b) {
  const list = parsePairs(b.items, { max: 60, label: 'Nome:quantidade (ex.: Boné:100)', optional: true });
  SUGGESTED_ITEMS.forEach((name, i) => { if (b[`item_s${i}`]) list.push([name, null]); });
  const seen = new Set(); const out = [];
  for (const [name, stock] of list) { assertNotShoe(name); const k = norm(name); if (seen.has(k)) continue; seen.add(k); out.push([name, stock]); }
  return out;
}

/** Item com estoque controlado que impede vender mais `add` kits (limits_sales=1), ou null. */
async function kitBlockingItem(kitId, add = 1, excludeOrder = 0) {
  const items = await db.all('SELECT * FROM kit_items WHERE kit_id=? AND stock IS NOT NULL AND limits_sales=1 ORDER BY sort, id', kitId);
  if (!items.length) return null;
  const used = await counts.kit(kitId, excludeOrder);
  return items.find((it) => used + add > it.stock) || null;
}

const level = (row) => (row.available == null ? null : row.available <= 0 ? ['Esgotado', 'danger'] : row.available < row.stock * 0.1 ? ['Estoque baixo', 'warn'] : null);

/** Linhas de estoque por kit: camisetas por tamanho e itens. */
async function stockRows(eventId) {
  const out = [];
  for (const k of await db.all('SELECT * FROM kits WHERE event_id=? ORDER BY id', eventId)) {
    const q = async (extra, ...p) => (await db.one(`SELECT COUNT(*) n FROM registrations g WHERE g.kit_id=? AND g.status='confirmed' ${extra}`, k.id, ...p)).n;
    const given = (extra, ...p) => q(`${extra} AND EXISTS (SELECT 1 FROM kit_pickups x WHERE x.registration_id=g.id)`, ...p);
    const rows = [];
    for (const s of await db.all('SELECT * FROM kit_sizes WHERE kit_id=? ORDER BY id', k.id)) {
      const used = await counts.size(k.id, s.size); const conf = await q('AND g.kit_size=?', s.size); const gv = await given('AND g.kit_size=?', s.size);
      rows.push({ kind: 'size', id: s.id, label: `Camiseta ${s.size}`, stock: s.stock, used, given: gv, pending: conf - gv, available: s.stock - used, limits: true });
    }
    const items = await db.all('SELECT * FROM kit_items WHERE kit_id=? ORDER BY sort, id', k.id);
    if (items.length) {
      const used = await counts.kit(k.id); const conf = await q(''); const gv = await given('');
      for (const it of items) rows.push({ kind: 'item', id: it.id, label: it.name, stock: it.stock, used, given: gv, pending: conf - gv, available: it.stock == null ? null : it.stock - used, limits: !!it.limits_sales });
    }
    for (const r of rows) r.level = level(r);
    out.push({ kit: k, rows, soldOut: !!await kitBlockingItem(k.id) });
  }
  return out;
}

module.exports = { MAX_STOCK, SUGGESTED_ITEMS, MOVE_KIND, norm, assertNotShoe, parsePairs, parseKitItems, kitBlockingItem, stockRows, level };
