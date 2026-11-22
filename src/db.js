'use strict';
/**
 * Acesso ao PostgreSQL (driver pg).
 * - Consultas escritas com "?"; convertidas para $1, $2... antes de enviar.
 * - db.tx(fn): transação com trava consultiva (pg_advisory_xact_lock) que serializa as escritas
 *   críticas (vagas, estoque, pagamentos) entre requisições e entre instâncias do app.
 *   Consultas dentro de fn usam automaticamente a conexão da transação (AsyncLocalStorage).
 * - Datas gravadas como texto ISO 8601 em UTC (mesmo formato do JavaScript), comparáveis como texto.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const pg = require('pg');
const config = require('./config');

// BIGINT e NUMERIC chegam como texto no pg; aqui viram number (os valores do app cabem com folga)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const TX_LOCK = 724100; // chave da trava consultiva das transações do app
const migrations = [
// 001 núcleo
[
  `CREATE EXTENSION IF NOT EXISTS citext`,
  `CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified_at TEXT,
  is_admin BIGINT NOT NULL DEFAULT 0,
  cpf TEXT,
  birth_date TEXT,
  gender TEXT,
  phone TEXT,
  city TEXT,
  state TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  shirt_size TEXT,
  marketing_opt_in BIGINT NOT NULL DEFAULT 0,
  notify_prefs TEXT NOT NULL DEFAULT '{}',
  public_results BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  is_demo BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  context TEXT NOT NULL DEFAULT 'athlete',
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
)`,
  `CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
)`,
  `CREATE TABLE outbox (
  id BIGSERIAL PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'transactional',
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE settings (
  "key" TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  org_id BIGINT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE INDEX audit_org ON audit_log(org_id, created_at)`,
  `CREATE TABLE consents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  doc_key TEXT NOT NULL,
  version TEXT NOT NULL,
  context TEXT,
  accepted_at TEXT NOT NULL DEFAULT (${NOW}),
  ip TEXT
)`,
  `CREATE TABLE organizations (
  id BIGSERIAL PRIMARY KEY,
  cnpj TEXT NOT NULL UNIQUE,
  legal_name TEXT,
  trade_name TEXT,
  cnpj_status TEXT,
  address TEXT NOT NULL DEFAULT '{}',
  cnpj_source TEXT NOT NULL DEFAULT 'manual',
  cnpj_checked_at TEXT,
  logo_path TEXT,
  website TEXT,
  support_phone TEXT,
  support_email TEXT,
  bio TEXT,
  status TEXT NOT NULL DEFAULT 'onboarding',
  status_note TEXT,
  mp_status TEXT NOT NULL DEFAULT 'none',
  mp_user_id TEXT,
  mp_configured_at TEXT,
  api_key_hash TEXT,
  is_demo BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE org_members (
  org_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  role TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  event_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY (org_id, user_id)
)`,
  `CREATE TABLE org_access_requests (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by BIGINT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE onboarding_drafts (
  user_id BIGINT PRIMARY KEY,
  step BIGINT NOT NULL DEFAULT 1,
  data TEXT NOT NULL DEFAULT '{}',
  org_id BIGINT,
  updated_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE documents (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT,
  user_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  reviewed_by BIGINT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sport TEXT NOT NULL DEFAULT 'Corrida de rua',
  start_local TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  start_utc TEXT,
  venue TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  route_info TEXT,
  route_url TEXT,
  cover_path TEXT,
  regulation TEXT,
  regulation_version BIGINT NOT NULL DEFAULT 0,
  change_policy TEXT,
  cancel_policy TEXT,
  change_deadline_utc TEXT,
  allow_transfer BIGINT NOT NULL DEFAULT 0,
  allow_modality_change BIGINT NOT NULL DEFAULT 1,
  allow_shirt_change BIGINT NOT NULL DEFAULT 1,
  change_fee_cents BIGINT NOT NULL DEFAULT 0,
  kit_pickup_info TEXT,
  support_phone TEXT,
  support_email TEXT,
  fee_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  fee_payer TEXT NOT NULL DEFAULT 'athlete',
  reservation_minutes BIGINT NOT NULL DEFAULT 15,
  allow_duplicate BIGINT NOT NULL DEFAULT 0,
  capacity BIGINT,
  ranking_basis TEXT NOT NULL DEFAULT 'net',
  review_days BIGINT NOT NULL DEFAULT 3,
  allow_third_party_pickup BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  wizard_step BIGINT NOT NULL DEFAULT 1,
  published_at TEXT,
  is_demo BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT
)`,
  `CREATE INDEX events_org ON events(org_id)`,
  `CREATE TABLE modalities (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  distance_km DOUBLE PRECISION,
  capacity BIGINT,
  start_time TEXT,
  sort BIGINT NOT NULL DEFAULT 0
)`,
  `CREATE TABLE categories (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  modality_id BIGINT,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'any',
  min_age BIGINT,
  max_age BIGINT
)`,
  `CREATE TABLE lots (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  modality_id BIGINT,
  name TEXT NOT NULL,
  price_cents BIGINT NOT NULL DEFAULT 0,
  starts_utc TEXT,
  ends_utc TEXT,
  quantity BIGINT,
  sort BIGINT NOT NULL DEFAULT 0
)`,
  `CREATE TABLE kits (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  extra_price_cents BIGINT NOT NULL DEFAULT 0,
  has_shirt BIGINT NOT NULL DEFAULT 1
)`,
  `CREATE TABLE kit_sizes (
  id BIGSERIAL PRIMARY KEY,
  kit_id BIGINT NOT NULL,
  size TEXT NOT NULL,
  stock BIGINT NOT NULL DEFAULT 0,
  UNIQUE(kit_id, size)
)`,
  `CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_cents BIGINT NOT NULL,
  active BIGINT NOT NULL DEFAULT 1
)`,
  `CREATE TABLE product_variants (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL,
  label TEXT NOT NULL,
  stock BIGINT NOT NULL DEFAULT 0
)`,
  `CREATE TABLE questions (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  modality_id BIGINT,
  label TEXT NOT NULL,
  purpose TEXT,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '[]',
  required BIGINT NOT NULL DEFAULT 0,
  active BIGINT NOT NULL DEFAULT 1,
  version BIGINT NOT NULL DEFAULT 1,
  sort BIGINT NOT NULL DEFAULT 0
)`,
  `CREATE TABLE coupons (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  code CITEXT NOT NULL,
  percent_off DOUBLE PRECISION,
  amount_off_cents BIGINT,
  max_uses BIGINT,
  min_group BIGINT NOT NULL DEFAULT 1,
  active BIGINT NOT NULL DEFAULT 1,
  UNIQUE(event_id, code)
)`,
  `CREATE TABLE teams (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'equipe',
  owner_user_id BIGINT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE team_members (
  team_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  PRIMARY KEY(team_id, user_id)
)`,
  `CREATE TABLE favorites (
  user_id BIGINT NOT NULL,
  event_id BIGINT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY(user_id, event_id)
)`,
  `CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL,
  event_id BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'registration',
  status TEXT NOT NULL DEFAULT 'pending',
  subtotal_cents BIGINT NOT NULL DEFAULT 0,
  discount_cents BIGINT NOT NULL DEFAULT 0,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL DEFAULT 0,
  organizer_fee_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  coupon_id BIGINT,
  expires_at TEXT,
  provider TEXT,
  provider_ref TEXT,
  checkout_url TEXT,
  paid_at TEXT,
  exception_note TEXT,
  related_registration_id BIGINT,
  change_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT
)`,
  `CREATE INDEX orders_event ON orders(event_id, status)`,
  `CREATE TABLE registrations (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  event_id BIGINT NOT NULL,
  modality_id BIGINT NOT NULL,
  lot_id BIGINT,
  category_id BIGINT,
  kit_id BIGINT,
  kit_size TEXT,
  user_id BIGINT,
  buyer_user_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  email CITEXT,
  cpf TEXT,
  birth_date TEXT,
  gender TEXT,
  guardian_name TEXT,
  guardian_cpf TEXT,
  team_name TEXT,
  price_cents BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  bib TEXT,
  qr_token TEXT NOT NULL UNIQUE,
  regulation_version BIGINT,
  regulation_accepted_at TEXT,
  answers TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  confirmed_at TEXT,
  cancelled_at TEXT
)`,
  `CREATE INDEX reg_event ON registrations(event_id, status)`,
  `CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  registration_id BIGINT,
  variant_id BIGINT NOT NULL,
  qty BIGINT NOT NULL,
  unit_price_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  picked_up_at TEXT,
  picked_up_by BIGINT
)`,
  `CREATE TABLE payments (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  provider TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT,
  method TEXT,
  amount_cents BIGINT,
  currency TEXT,
  refunded_cents BIGINT NOT NULL DEFAULT 0,
  provider_updated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE(provider, provider_payment_id)
)`,
  `CREATE TABLE webhook_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  topic TEXT,
  resource_id TEXT,
  signature_ok BIGINT NOT NULL,
  result TEXT,
  received_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE sim_payments (
  id TEXT PRIMARY KEY,
  order_code TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  method TEXT,
  refunded_cents BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`,
  `CREATE TABLE requests (
  id BIGSERIAL PRIMARY KEY,
  registration_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  decided_by BIGINT,
  decided_at TEXT,
  refund_cents BIGINT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE payment_exceptions (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE pickup_points (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  name TEXT NOT NULL
)`,
  `CREATE TABLE kit_pickups (
  id BIGSERIAL PRIMARY KEY,
  registration_id BIGINT NOT NULL UNIQUE,
  operator_id BIGINT NOT NULL,
  point_id BIGINT,
  third_party_name TEXT,
  third_party_doc TEXT,
  picked_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE checkins (
  id BIGSERIAL PRIMARY KEY,
  registration_id BIGINT NOT NULL UNIQUE,
  operator_id BIGINT NOT NULL,
  point_id BIGINT,
  at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE result_versions (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  version BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  note TEXT,
  created_by BIGINT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE(event_id, version)
)`,
  `CREATE TABLE results (
  id BIGSERIAL PRIMARY KEY,
  version_id BIGINT NOT NULL,
  event_id BIGINT NOT NULL,
  registration_id BIGINT,
  bib TEXT,
  name TEXT,
  modality_id BIGINT,
  category_id BIGINT,
  gender TEXT,
  gun_s BIGINT,
  net_s BIGINT,
  status TEXT NOT NULL,
  pace_s_km BIGINT,
  rank_overall BIGINT,
  rank_gender BIGINT,
  rank_category BIGINT
)`,
  `CREATE INDEX results_version ON results(version_id)`,
  `CREATE TABLE result_reviews (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  registration_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  responded_by BIGINT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE athlete_records (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  event_name TEXT NOT NULL,
  date TEXT,
  distance_km DOUBLE PRECISION NOT NULL,
  time_s BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'athlete',
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE TABLE support_tickets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  org_id BIGINT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE INDEX sessions_user ON sessions(user_id)`,
  `CREATE INDEX modalities_event ON modalities(event_id)`,
  `CREATE INDEX categories_event ON categories(event_id)`,
  `CREATE INDEX lots_event ON lots(event_id)`,
  `CREATE INDEX kits_event ON kits(event_id)`,
  `CREATE INDEX products_event ON products(event_id)`,
  `CREATE INDEX variants_product ON product_variants(product_id)`,
  `CREATE INDEX questions_event ON questions(event_id)`,
  `CREATE INDEX reg_order ON registrations(order_id)`,
  `CREATE INDEX reg_user ON registrations(user_id)`,
  `CREATE INDEX items_order ON order_items(order_id)`,
  `CREATE INDEX payments_order ON payments(order_id)`,
  `CREATE INDEX orders_user ON orders(user_id)`,
  `CREATE INDEX results_event ON results(event_id)`,
  `CREATE INDEX docs_org ON documents(org_id)`,
  `CREATE INDEX outbox_to ON outbox(to_email)`,
  `CREATE INDEX sim_order ON sim_payments(order_code)`,
],
// 002 login com provedores externos (Google)
[
  `CREATE TABLE user_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  last_login_at TEXT,
  UNIQUE(provider, subject)
)`,
  `CREATE INDEX user_identities_user ON user_identities(user_id)`,
],
// 003 organizador pessoa física, foto de perfil, envio real de e-mail, SMS e WhatsApp
[
  `ALTER TABLE organizations ALTER COLUMN cnpj DROP NOT NULL`,
  `ALTER TABLE organizations ADD COLUMN person_type TEXT NOT NULL DEFAULT 'pj'`,
  `ALTER TABLE organizations ADD COLUMN cpf TEXT`,
  `CREATE UNIQUE INDEX organizations_cpf_unique ON organizations(cpf) WHERE cpf IS NOT NULL`,
  `ALTER TABLE users ADD COLUMN avatar_path TEXT`,
  `ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE outbox ADD COLUMN attempts BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE outbox ADD COLUMN sent_at TEXT`,
  `ALTER TABLE outbox ADD COLUMN error TEXT`,
  `CREATE INDEX outbox_status ON outbox(status)`,
  `CREATE TABLE message_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  channel TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'transactional',
  status TEXT NOT NULL DEFAULT 'queued',
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  sent_at TEXT
)`,
  `CREATE INDEX message_log_user ON message_log(user_id)`,
],
// 004 fila de envio: reserva com horário (várias instâncias) e tentativas de SMS/WhatsApp
[
  `ALTER TABLE outbox ADD COLUMN claimed_at TEXT`,
  `ALTER TABLE message_log ADD COLUMN claimed_at TEXT`,
  `ALTER TABLE message_log ADD COLUMN attempts BIGINT NOT NULL DEFAULT 0`,
],
// 005 estoque dos itens do kit (camiseta continua em kit_sizes) e histórico de movimentações
[
  `CREATE TABLE kit_items (
  id BIGSERIAL PRIMARY KEY,
  kit_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  stock BIGINT,
  limits_sales BIGINT NOT NULL DEFAULT 1,
  sort BIGINT NOT NULL DEFAULT 0,
  UNIQUE(kit_id, name)
)`,
  `CREATE TABLE kit_stock_moves (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL,
  kit_id BIGINT NOT NULL,
  item_id BIGINT,
  size TEXT,
  label TEXT,
  kind TEXT NOT NULL,
  delta BIGINT NOT NULL,
  new_stock BIGINT,
  reason TEXT NOT NULL,
  user_id BIGINT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
)`,
  `CREATE INDEX kit_stock_moves_event ON kit_stock_moves(event_id, id)`,
],
];

let pool = null;
let opening = null;
const als = new AsyncLocalStorage();

/** Converte "?" em $n, ignorando "?" dentro de textos entre aspas. */
const cache = new Map();
function toPg(sql) {
  let out = cache.get(sql);
  if (out) return out;
  let n = 0; let q = null; out = '';
  for (const ch of sql) {
    if (q) { if (ch === q) q = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  if (cache.size < 2000) cache.set(sql, out);
  return out;
}

function adminUrl() {
  const u = new URL(config.db.url);
  const name = decodeURIComponent(u.pathname.slice(1));
  u.pathname = '/postgres';
  return { url: u.toString(), name: name.replace(/"/g, '') };
}

/** Abre o pool, cria o banco se não existir e aplica as migrações pendentes. */
async function open() {
  if (pool) return pool;
  if (opening) return opening;
  opening = (async () => {
    if (config.db.createDatabase) {
      const { url, name } = adminUrl();
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
      if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8'`);
      await admin.end();
    }
    const p = new pg.Pool({ connectionString: config.db.url, max: config.db.poolSize, ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined });
    p.on('error', (e) => console.error('[db] conexão ociosa com erro', e.message));
    pool = p;
    await migrate();
    return p;
  })();
  try { return await opening; } catch (e) { pool = null; throw e; } finally { opening = null; }
}

async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [TX_LOCK + 1]); // evita duas instâncias migrando juntas
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const { rows: [row] } = await c.query('SELECT COALESCE(MAX(version),0) v FROM schema_migrations');
    for (const [i, stmts] of migrations.entries()) {
      const v = i + 1;
      if (v <= row.v) continue;
      await c.query('BEGIN'); // DDL é transacional no PostgreSQL: a migração entra inteira ou não entra
      try {
        for (const sql of stmts) await c.query(sql);
        await c.query('INSERT INTO schema_migrations VALUES ($1, $2)', [v, new Date().toISOString()]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [TX_LOCK + 1]).catch(() => {});
    c.release();
  }
}

const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
async function exec(sql, params) {
  if (!pool) await open();
  const conn = als.getStore()?.conn || pool;
  return conn.query(toPg(sql), norm(params));
}
const one = async (sql, ...p) => (await exec(sql, p)).rows[0];
const all = async (sql, ...p) => (await exec(sql, p)).rows;
/** Escrita: devolve { lastInsertRowid, changes }. Em INSERT, o id vem por RETURNING. */
async function run(sql, ...p) {
  const s = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING *` : sql;
  const r = await exec(s, p);
  return { lastInsertRowid: r.rows?.[0]?.id, changes: r.rowCount };
}

/** Transação serializada: base do controle de capacidade e estoque. Aninhada, reaproveita a externa. */
async function tx(fn) {
  if (als.getStore()) return fn();
  if (!pool) await open();
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    try {
      await conn.query('SELECT pg_advisory_xact_lock($1)', [TX_LOCK]); // liberada no COMMIT/ROLLBACK
      const r = await als.run({ conn }, fn);
      await conn.query('COMMIT');
      return r;
    } catch (e) { await conn.query('ROLLBACK').catch(() => {}); throw e; }
  } finally { conn.release(); }
}

/** Executa fn fora de qualquer transação em andamento (para tarefas em segundo plano). */
const detached = (fn) => als.exit(fn);

async function setting(key, fallback) { const r = await one('SELECT value FROM settings WHERE "key"=?', key); return r ? JSON.parse(r.value) : fallback; }
async function setSetting(key, value) { await run('INSERT INTO settings("key",value) VALUES(?,?) ON CONFLICT ("key") DO UPDATE SET value=EXCLUDED.value', key, JSON.stringify(value)); }
async function close() { const p = pool; pool = null; if (p) await p.end(); }
/** Remove o banco de testes inteiro ao fim de cada arquivo de teste. Bloqueado fora do ambiente de testes. */
async function dropTestDatabase() {
  if (!config.isTest) throw new Error('Permitido somente no ambiente de testes');
  await close();
  const { url, name } = adminUrl();
  if (!name.startsWith('plataforma_test_')) throw new Error('Banco de testes com nome inesperado');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
}
module.exports = { open, one, all, run, tx, detached, setting, setSetting, close, dropTestDatabase, migrationsCount: migrations.length };
