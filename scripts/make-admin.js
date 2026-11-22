'use strict';
/**
 * Dá acesso de administração a uma conta já cadastrada (crie a conta pelo site antes).
 *   npm run make-admin -- email@exemplo.com
 *   npm run make-admin -- email@exemplo.com --remover
 */
const db = require('../src/db');

(async () => {
  const email = String(process.argv[2] || '').trim();
  const remove = process.argv.includes('--remover');
  if (!email || email.startsWith('-')) throw new Error('Informe o e-mail: npm run make-admin -- email@exemplo.com');
  await require('./pg-local').ensureLocal();
  const u = await db.one('SELECT id, name FROM users WHERE email=?', email);
  if (!u) throw new Error(`Nenhuma conta com o e-mail ${email}. Crie a conta pelo site primeiro.`);
  await db.run('UPDATE users SET is_admin=?, email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?', remove ? 0 : 1, new Date().toISOString(), u.id);
  await db.run('INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)', u.id, remove ? 'admin.revoked_cli' : 'admin.granted_cli', 'user', String(u.id), JSON.stringify({ via: 'scripts/make-admin.js' }));
  console.log(remove ? `${u.name} (${email}) não é mais administrador.` : `${u.name} (${email}) agora é administrador. Entre no site e escolha o perfil "Administração" no menu.`);
  await db.close();
})().catch(async (e) => { console.error(e.message || e); await db.close().catch(() => {}); process.exit(1); });
