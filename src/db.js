'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const migrations = [
`-- 001 núcleo
CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, email_verified_at TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
  cpf TEXT, birth_date TEXT, gender TEXT, phone TEXT, city TEXT, state TEXT,
  emergency_name TEXT, emergency_phone TEXT, shirt_size TEXT,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0, notify_prefs TEXT NOT NULL DEFAULT '{}',
  public_results INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), context TEXT NOT NULL DEFAULT 'athlete', csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE outbox (id INTEGER PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'transactional', created_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_id INTEGER, org_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT ${NOW});
CREATE INDEX audit_org ON audit_log(org_id, created_at);
CREATE TABLE consents (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), doc_key TEXT NOT NULL, version TEXT NOT NULL, context TEXT, accepted_at TEXT NOT NULL DEFAULT ${NOW}, ip TEXT);

CREATE TABLE organizations (
  id INTEGER PRIMARY KEY, cnpj TEXT NOT NULL UNIQUE, legal_name TEXT, trade_name TEXT, cnpj_status TEXT,
  address TEXT NOT NULL DEFAULT '{}', cnpj_source TEXT NOT NULL DEFAULT 'manual', cnpj_checked_at TEXT,
  logo_path TEXT, website TEXT, support_phone TEXT, support_email TEXT, bio TEXT,
  status TEXT NOT NULL DEFAULT 'onboarding', status_note TEXT,
  mp_status TEXT NOT NULL DEFAULT 'none', mp_user_id TEXT, mp_configured_at TEXT,
  api_key_hash TEXT, is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE org_members (org_id INTEGER NOT NULL REFERENCES organizations(id), user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]', event_ids TEXT, created_at TEXT NOT NULL DEFAULT ${NOW}, PRIMARY KEY (org_id, user_id));
CREATE TABLE org_access_requests (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), user_id INTEGER NOT NULL REFERENCES users(id), message TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, decided_at TEXT, created_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE onboarding_drafts (user_id INTEGER PRIMARY KEY REFERENCES users(id), step INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL DEFAULT '{}', org_id INTEGER, updated_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE documents (id INTEGER PRIMARY KEY, org_id INTEGER REFERENCES organizations(id), user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, storage_key TEXT NOT NULL, original_name TEXT, mime TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'submitted', reviewed_by INTEGER, reviewed_at TEXT, review_note TEXT, created_at TEXT NOT NULL DEFAULT ${NOW});

CREATE TABLE events (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, description TEXT, sport TEXT NOT NULL DEFAULT 'Corrida de rua', start_local TEXT, timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  start_utc TEXT, venue TEXT, address TEXT, city TEXT, state TEXT, route_info TEXT, route_url TEXT, cover_path TEXT,
  regulation TEXT, regulation_version INTEGER NOT NULL DEFAULT 0, change_policy TEXT, cancel_policy TEXT, change_deadline_utc TEXT,
  allow_transfer INTEGER NOT NULL DEFAULT 0, allow_modality_change INTEGER NOT NULL DEFAULT 1, allow_shirt_change INTEGER NOT NULL DEFAULT 1,
  change_fee_cents INTEGER NOT NULL DEFAULT 0, kit_pickup_info TEXT, support_phone TEXT, support_email TEXT,
  fee_percent REAL NOT NULL DEFAULT 0, fee_payer TEXT NOT NULL DEFAULT 'athlete',
  reservation_minutes INTEGER NOT NULL DEFAULT 15, allow_duplicate INTEGER NOT NULL DEFAULT 0, capacity INTEGER,
  ranking_basis TEXT NOT NULL DEFAULT 'net', review_days INTEGER NOT NULL DEFAULT 3, allow_third_party_pickup INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', wizard_step INTEGER NOT NULL DEFAULT 1, published_at TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT
);
CREATE INDEX events_org ON events(org_id);
CREATE TABLE modalities (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), name TEXT NOT NULL, distance_km REAL, capacity INTEGER, start_time TEXT, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE categories (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), modality_id INTEGER REFERENCES modalities(id), name TEXT NOT NULL, gender TEXT NOT NULL DEFAULT 'any', min_age INTEGER, max_age INTEGER);
CREATE TABLE lots (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), modality_id INTEGER REFERENCES modalities(id), name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, starts_utc TEXT, ends_utc TEXT, quantity INTEGER, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE kits (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), name TEXT NOT NULL, description TEXT, extra_price_cents INTEGER NOT NULL DEFAULT 0, has_shirt INTEGER NOT NULL DEFAULT 1);
CREATE TABLE kit_sizes (id INTEGER PRIMARY KEY, kit_id INTEGER NOT NULL REFERENCES kits(id), size TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0, UNIQUE(kit_id, size));
CREATE TABLE products (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), name TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE product_variants (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), label TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0);
CREATE TABLE questions (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), modality_id INTEGER REFERENCES modalities(id), label TEXT NOT NULL, purpose TEXT, type TEXT NOT NULL DEFAULT 'text', options TEXT NOT NULL DEFAULT '[]', required INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE coupons (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), code TEXT NOT NULL COLLATE NOCASE, percent_off REAL, amount_off_cents INTEGER, max_uses INTEGER, min_group INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, UNIQUE(event_id, code));
CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'equipe', owner_user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE team_members (team_id INTEGER NOT NULL REFERENCES teams(id), user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(team_id, user_id));
CREATE TABLE favorites (user_id INTEGER NOT NULL REFERENCES users(id), event_id INTEGER NOT NULL REFERENCES events(id), created_at TEXT NOT NULL DEFAULT ${NOW}, PRIMARY KEY(user_id, event_id));

CREATE TABLE orders (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), event_id INTEGER NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL DEFAULT 'registration', status TEXT NOT NULL DEFAULT 'pending', subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0, fee_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  organizer_fee_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'BRL', coupon_id INTEGER REFERENCES coupons(id),
  expires_at TEXT, provider TEXT, provider_ref TEXT, checkout_url TEXT, paid_at TEXT, exception_note TEXT,
  related_registration_id INTEGER, change_payload TEXT, created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT
);
CREATE INDEX orders_event ON orders(event_id, status);
CREATE TABLE registrations (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), event_id INTEGER NOT NULL REFERENCES events(id),
  modality_id INTEGER NOT NULL REFERENCES modalities(id), lot_id INTEGER REFERENCES lots(id), category_id INTEGER REFERENCES categories(id),
  kit_id INTEGER REFERENCES kits(id), kit_size TEXT, user_id INTEGER REFERENCES users(id), buyer_user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, email TEXT, cpf TEXT, birth_date TEXT, gender TEXT, guardian_name TEXT, guardian_cpf TEXT, team_name TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'reserved', bib TEXT, qr_token TEXT NOT NULL UNIQUE,
  regulation_version INTEGER, regulation_accepted_at TEXT, answers TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT ${NOW}, confirmed_at TEXT, cancelled_at TEXT
);
CREATE INDEX reg_event ON registrations(event_id, status);
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), registration_id INTEGER REFERENCES registrations(id), variant_id INTEGER NOT NULL REFERENCES product_variants(id), qty INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', picked_up_at TEXT, picked_up_by INTEGER);
CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), provider TEXT NOT NULL, provider_payment_id TEXT NOT NULL, status TEXT NOT NULL, status_detail TEXT, method TEXT, amount_cents INTEGER, currency TEXT, refunded_cents INTEGER NOT NULL DEFAULT 0, provider_updated_at TEXT, updated_at TEXT NOT NULL DEFAULT ${NOW}, UNIQUE(provider, provider_payment_id));
CREATE TABLE webhook_events (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, topic TEXT, resource_id TEXT, signature_ok INTEGER NOT NULL, result TEXT, received_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE sim_payments (id TEXT PRIMARY KEY, order_code TEXT NOT NULL, status TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'BRL', method TEXT, refunded_cents INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE requests (id INTEGER PRIMARY KEY, registration_id INTEGER NOT NULL REFERENCES registrations(id), user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', reason TEXT, status TEXT NOT NULL DEFAULT 'open', response TEXT, decided_by INTEGER, decided_at TEXT, refund_cents INTEGER, created_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE payment_exceptions (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at TEXT NOT NULL DEFAULT ${NOW});

CREATE TABLE pickup_points (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), name TEXT NOT NULL);
CREATE TABLE kit_pickups (id INTEGER PRIMARY KEY, registration_id INTEGER NOT NULL UNIQUE REFERENCES registrations(id), operator_id INTEGER NOT NULL REFERENCES users(id), point_id INTEGER, third_party_name TEXT, third_party_doc TEXT, picked_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE checkins (id INTEGER PRIMARY KEY, registration_id INTEGER NOT NULL UNIQUE REFERENCES registrations(id), operator_id INTEGER NOT NULL, point_id INTEGER, at TEXT NOT NULL DEFAULT ${NOW});

CREATE TABLE result_versions (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', note TEXT, created_by INTEGER, published_at TEXT, created_at TEXT NOT NULL DEFAULT ${NOW}, UNIQUE(event_id, version));
CREATE TABLE results (id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES result_versions(id), event_id INTEGER NOT NULL, registration_id INTEGER REFERENCES registrations(id), bib TEXT, name TEXT, modality_id INTEGER, category_id INTEGER, gender TEXT, gun_s INTEGER, net_s INTEGER, status TEXT NOT NULL, pace_s_km INTEGER, rank_overall INTEGER, rank_gender INTEGER, rank_category INTEGER);
CREATE INDEX results_version ON results(version_id);
CREATE TABLE result_reviews (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, registration_id INTEGER NOT NULL, user_id INTEGER NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', response TEXT, responded_by INTEGER, responded_at TEXT, created_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE athlete_records (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), event_name TEXT NOT NULL, date TEXT, distance_km REAL NOT NULL, time_s INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'athlete', created_at TEXT NOT NULL DEFAULT ${NOW});
CREATE TABLE support_tickets (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, org_id INTEGER, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', response TEXT, created_at TEXT NOT NULL DEFAULT ${NOW});
`,
`-- 002 login com provedores externos (Google)
CREATE TABLE user_identities (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL DEFAULT ${NOW}, last_login_at TEXT, UNIQUE(provider, subject));
CREATE INDEX user_identities_user ON user_identities(user_id);
`,
];

let db;
function open(file = config.dbFile) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}
function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const current = db.prepare('SELECT COALESCE(MAX(version),0) v FROM schema_migrations').get().v;
  migrations.forEach((sql, i) => {
    const v = i + 1;
    if (v <= current) return;
    db.exec('BEGIN');
    try { db.exec(sql); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(v, new Date().toISOString()); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  });
}
function get() { return db || open(); }
const one = (sql, ...p) => get().prepare(sql).get(...p);
const all = (sql, ...p) => get().prepare(sql).all(...p);
const run = (sql, ...p) => get().prepare(sql).run(...p);
let depth = 0;
/** Transação de escrita serializada (BEGIN IMMEDIATE): base do controle de capacidade e estoque. */
function tx(fn) {
  if (depth > 0) return fn();
  get().exec('BEGIN IMMEDIATE'); depth++;
  try { const r = fn(); depth--; get().exec('COMMIT'); return r; }
  catch (e) { depth--; get().exec('ROLLBACK'); throw e; }
}
function setting(key, fallback) { const r = one('SELECT value FROM settings WHERE key=?', key); return r ? JSON.parse(r.value) : fallback; }
function setSetting(key, value) { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
function close() { if (db) db.close(); db = null; }
module.exports = { open, get, one, all, run, tx, setting, setSetting, close, migrationsCount: migrations.length };
