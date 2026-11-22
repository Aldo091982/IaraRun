'use strict';
/**
 * PostgreSQL local para desenvolvimento e testes, sem instalação manual.
 * Usa os binários oficiais do pacote embedded-postgres (devDependency) e o pg_ctl,
 * que no Windows também funciona em terminal de administrador.
 *
 *   node scripts/pg-local.js start [dev|test]   inicia (cria o cluster na primeira vez)
 *   node scripts/pg-local.js stop  [dev|test]
 *   node scripts/pg-local.js status [dev|test]
 *
 * Em produção, use um PostgreSQL gerenciado e configure DATABASE_URL.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const CLUSTERS = {
  dev: { dir: path.join(root, 'storage', 'pg', 'dev'), port: 54329 },
  test: { dir: path.join(root, 'storage', 'pg', 'test'), port: 54330 },
};
const PASSWORD = 'postgres'; // somente local

function binDir() {
  const plat = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const dir = path.join(root, 'node_modules', '@embedded-postgres', `${plat}-${process.arch}`, 'native', 'bin');
  if (!fs.existsSync(dir)) throw new Error(`Binários do PostgreSQL não encontrados em ${dir}. Rode "npm install" (inclui devDependencies).`);
  return dir;
}
const exe = (name) => path.join(binDir(), process.platform === 'win32' ? `${name}.exe` : name);

function isListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

/** Espera o servidor aceitar consultas (a porta abre antes de o banco ficar pronto). */
async function waitReady(which, tries = 60) {
  const pg = require('pg');
  for (let i = 0; i < tries; i++) {
    const c = new pg.Client({ connectionString: url(which) });
    try { await c.connect(); await c.query('SELECT 1'); await c.end(); return true; } catch { await c.end().catch(() => {}); }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function start(which = 'dev') {
  const c = CLUSTERS[which];
  if (await isListening(c.port)) { if (await waitReady(which)) return c; throw new Error(`PostgreSQL local na porta ${c.port} não ficou pronto.`); }
  if (!fs.existsSync(path.join(c.dir, 'PG_VERSION'))) {
    fs.mkdirSync(c.dir, { recursive: true });
    const pw = path.join(c.dir, '..', `.pw-${which}`);
    fs.writeFileSync(pw, PASSWORD);
    const r = spawnSync(exe('initdb'), ['-D', c.dir, '-U', 'postgres', `--pwfile=${pw}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], { stdio: 'pipe' });
    fs.rmSync(pw, { force: true });
    if (r.status !== 0) throw new Error(`initdb falhou: ${r.stderr || r.stdout}`);
  }
  // pg_ctl em processo separado e sem herdar a saída (o servidor continua rodando depois)
  const child = spawn(exe('pg_ctl'), ['-D', c.dir, '-o', `-p ${c.port} -c listen_addresses=127.0.0.1`, '-l', path.join(c.dir, 'server.log'), '-w', 'start'], { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  if (await waitReady(which, 90)) return c;
  throw new Error(`PostgreSQL local não respondeu na porta ${c.port}. Veja ${path.join(c.dir, 'server.log')}.`);
}
function stop(which = 'dev') {
  const c = CLUSTERS[which];
  if (!fs.existsSync(path.join(c.dir, 'PG_VERSION'))) return;
  spawnSync(exe('pg_ctl'), ['-D', c.dir, '-m', 'fast', 'stop'], { stdio: 'ignore', windowsHide: true });
}
const url = (which = 'dev', db = 'postgres') => `postgres://postgres:${PASSWORD}@127.0.0.1:${CLUSTERS[which].port}/${db}`;

/**
 * Fora de produção e sem DATABASE_URL, garante o PostgreSQL local de desenvolvimento rodando.
 * Assim "npm start", "npm run migrate" e "npm run seed" funcionam sem configurar nada.
 */
async function ensureLocal() {
  if (process.env.DATABASE_URL || process.env.APP_ENV === 'production' || process.env.APP_ENV === 'test') return;
  await start('dev');
}

module.exports = { start, stop, url, isListening, ensureLocal, CLUSTERS };

if (require.main === module) {
  const [cmd = 'status', which = 'dev'] = process.argv.slice(2);
  (async () => {
    if (!CLUSTERS[which]) throw new Error('Use dev ou test.');
    if (cmd === 'start') { const c = await start(which); console.log(`PostgreSQL local (${which}) em 127.0.0.1:${c.port} — ${url(which, '<banco>')}`); }
    else if (cmd === 'stop') { stop(which); console.log(`PostgreSQL local (${which}) parado.`); }
    else console.log(`PostgreSQL local (${which}): ${(await isListening(CLUSTERS[which].port)) ? 'rodando' : 'parado'} na porta ${CLUSTERS[which].port}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
