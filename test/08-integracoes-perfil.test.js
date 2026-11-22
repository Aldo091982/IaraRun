'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const h = require('./helpers');
const f = require('./fixtures');
const { db } = h;
const config = require('../src/config');
const integrations = require('../src/lib/integrations');
const delivery = require('../src/lib/delivery');

before(h.start);
after(async () => { await integrations.load(); await h.stop(); });

async function adminClient() {
  const c = new h.Client(); await h.login(c, await h.makeAdmin('integra@teste.local')); await c.post('/contexto', { context: 'admin' });
  return c;
}

/** Servidor SMTP mínimo, só para os testes: guarda as mensagens recebidas. */
function fakeSmtp() {
  const received = [];
  const server = net.createServer((sock) => {
    let data = null; let msg = { rcpt: [] };
    sock.write('220 teste ESMTP\r\n');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data !== null) {
          if (line === '.') { msg.data = data; received.push(msg); data = null; msg = { rcpt: [] }; sock.write('250 OK queued\r\n'); } else data += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-teste\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write('235 OK\r\n');
        else if (cmd === 'MAIL') { msg.from = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { msg.rcpt.push(line); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { data = ''; sock.write('354 envie\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 tchau\r\n'); sock.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, received })));
}

test('topo mostra o botão Sair e as iniciais; foto de perfil enviada e removida', async () => {
  const a = await f.athlete();
  const home = await a.c.get('/');
  assert.match(home.text, /class="btn-logout"/);
  assert.match(home.text, /avatar-initials/);
  const up = await a.c.postMultipart('/minha-conta/perfil/foto', { foto: { buffer: h.PNG, type: 'image/png', name: 'eu.png' } });
  assert.equal(up.status, 200);
  const u = await db.one('SELECT avatar_path FROM users WHERE id=?', a.user.id);
  assert.ok(u.avatar_path);
  assert.match((await a.c.get('/')).text, new RegExp(`/media/${u.avatar_path}`));
  // arquivo que não é imagem é recusado
  const bad = await a.c.postMultipart('/minha-conta/perfil/foto', { foto: { buffer: h.PDF, type: 'application/pdf', name: 'x.pdf' } });
  assert.match(bad.text, /formato não aceito/);
  await a.c.post('/minha-conta/perfil/foto/remover', {});
  assert.equal((await db.one('SELECT avatar_path FROM users WHERE id=?', a.user.id)).avatar_path, null);
  // Sair encerra a sessão
  await a.c.post('/sair', {});
  assert.notEqual((await a.c.get('/minha-conta', { follow: false })).status, 200);
});

test('organizador pessoa física: cadastro com CPF, sem vínculo de empresa, CPF não se repete', async () => {
  const c = new h.Client();
  await h.signup(c, { name: 'Maria Organizadora', email: 'pf.org@teste.local', perfil: 'organizador' });
  await c.post('/organizador/cadastro/1', { acao: 'avancar' });
  const page = await c.get('/organizador/cadastro?etapa=2');
  assert.match(page.text, /Pessoa física/);
  const cpf = h.cpfFrom('987654321');
  const r = await c.postMultipart('/organizador/cadastro/2', { acao: 'avancar', person_type: 'pf', cpf, legal_name: 'Maria Organizadora da Silva', trade_name: 'Maria Corridas', city: 'Recife', state: 'PE',
    identity: { buffer: h.PDF, type: 'application/pdf', name: 'rg.pdf' } });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const org = await db.one("SELECT * FROM organizations WHERE cpf=?", cpf);
  assert.equal(org.person_type, 'pf');
  assert.equal(org.cnpj, null);
  // CPF inválido e CPF já usado por outro organizador
  const c2 = new h.Client(); await h.signup(c2, { name: 'Outra Pessoa', email: 'pf.org2@teste.local', perfil: 'organizador' });
  await c2.post('/organizador/cadastro/1', { acao: 'avancar' });
  const inval = await c2.postMultipart('/organizador/cadastro/2', { acao: 'avancar', person_type: 'pf', cpf: '12345678900', legal_name: 'X', trade_name: 'X', city: 'Recife', state: 'PE' });
  assert.match(inval.text, /CPF inválido/);
  const dup = await c2.postMultipart('/organizador/cadastro/2', { acao: 'avancar', person_type: 'pf', cpf, legal_name: 'X', trade_name: 'X', city: 'Recife', state: 'PE' });
  assert.match(dup.text, /Já existe um organizador cadastrado com este CPF/);
  // empresa continua exigindo CNPJ válido
  const pj = await c2.postMultipart('/organizador/cadastro/2', { acao: 'avancar', person_type: 'pj', cnpj: '11111111111111', legal_name: 'X', trade_name: 'X', city: 'Recife', state: 'PE', link_role: 'socio' });
  assert.match(pj.text, /CNPJ inválido/);
  // a revisão e a administração mostram o CPF
  await c.post('/organizador/cadastro/3', { acao: 'avancar', support_email: 'maria@teste.local', support_phone: '(81) 99999-0000', accept_terms: 1, accept_privacy: 1, accept_organizer: 1 });
  const rev = await c.get('/organizador/cadastro?etapa=4');
  assert.match(rev.text, /CPF \d{3}\.\d{3}\.\d{3}-\d{2}/);
  assert.doesNotMatch(rev.text, /vínculo com a empresa \(etapa 2\)/);
  const adm = await adminClient();
  assert.match((await adm.get('/admin/organizadores')).text, /CPF \d{3}\.\d{3}/);
});

test('integrações pela tela: segredo criptografado, nunca exibido, aplicado na hora e auditado', async () => {
  const adm = await adminClient();
  const page = await adm.get('/admin/integracoes');
  for (const t of ['Mercado Pago', 'PayPal', 'PicPay', 'E-mail (servidor SMTP)', 'SMS e WhatsApp', 'Entrar com o Google', 'Consulta de CNPJ']) assert.ok(page.text.includes(t), t);
  const token = 'TEST-1234567890-segredo-de-teste';
  await adm.post('/admin/integracoes/mercadopago', { access_token: token, webhook_secret: 'chave-webhook-xyz', receiver_model: 'undecided' });
  assert.equal(config.mp.mode, 'mp_test', 'vale na hora, sem reiniciar');
  const raw = (await db.one('SELECT value FROM settings WHERE "key"=?', 'integration:mercadopago')).value;
  assert.ok(!raw.includes(token) && !raw.includes('chave-webhook-xyz'), 'segredo não fica em texto puro no banco');
  const again = await adm.get('/admin/integracoes?abrir=mercadopago');
  assert.ok(!again.text.includes(token), 'segredo nunca volta para a tela');
  assert.match(again.text, /Configurado/);
  const log = await db.one("SELECT detail FROM audit_log WHERE action='integration.updated' ORDER BY id DESC LIMIT 1");
  assert.ok(!log.detail.includes(token));
  // salvar sem digitar o segredo mantém o atual; "remover" apaga
  await adm.post('/admin/integracoes/mercadopago', { receiver_model: 'platform' });
  assert.equal(config.mp.accessToken, token);
  assert.equal(config.mp.receiverModel, 'platform');
  await adm.post('/admin/integracoes/mercadopago', { access_token__remover: 1, webhook_secret__remover: 1, receiver_model: 'undecided' });
  assert.equal(config.mp.mode, 'simulator');
  // quem não é administrador não altera integrações
  const a = await f.athlete();
  await a.c.post('/admin/integracoes/mercadopago', { access_token: 'TEST-invasor' });
  assert.notEqual(config.mp.accessToken, 'TEST-invasor');
  // meios de pagamento oferecidos
  await adm.post('/admin/integracoes/payment_methods', { methods: { 0: 'mercadopago', 1: 'picpay' } });
  assert.deepEqual(config.paymentMethods, ['mercadopago', 'picpay']);
  await adm.post('/admin/integracoes/payment_methods', { methods: { 0: 'mercadopago', 1: 'paypal', 2: 'picpay' } });
});

test('e-mail sai de verdade pelo SMTP configurado na tela; falha volta para a fila', async () => {
  const smtp = await fakeSmtp();
  const adm = await adminClient();
  try {
    await adm.post('/admin/integracoes/mail', { smtp_host: '127.0.0.1', smtp_port: String(smtp.port), smtp_secure: 'none', smtp_user: 'usuario', smtp_pass: 'senha-smtp', from: 'IaraRun <nao-responda@teste.local>' });
    assert.equal(config.mail.mode, 'smtp');
    const { sendMail } = require('../src/lib/core');
    await sendMail('destino@teste.local', 'Assunto real', 'Corpo da mensagem real');
    assert.equal((await db.one("SELECT status FROM outbox WHERE to_email='destino@teste.local'")).status, 'queued');
    await delivery.processQueue();
    const row = await db.one("SELECT * FROM outbox WHERE to_email='destino@teste.local'");
    assert.equal(row.status, 'sent', row.error || '');
    assert.ok(smtp.received.some((m) => m.rcpt.join().includes('destino@teste.local') && m.data.includes('Assunto real')));
    // teste pela tela
    const t = await adm.post('/admin/integracoes/mail/teste', { to: 'admin-teste@teste.local' });
    assert.match(t.text, /E-mail de teste enviado/);
    // servidor fora do ar: tenta de novo depois, sem perder a mensagem
    smtp.server.close();
    await sendMail('fila@teste.local', 'Vai falhar', 'x');
    await delivery.processQueue();
    const fail = await db.one("SELECT * FROM outbox WHERE to_email='fila@teste.local'");
    assert.equal(fail.status, 'retry');
    assert.ok(fail.error);
    // a tela de mensagens mostra a situação, sem o conteúdo
    const msgs = await adm.get('/admin/mensagens');
    assert.match(msgs.text, /Nova tentativa/);
    assert.ok(!msgs.text.includes('Corpo da mensagem real'));
  } finally {
    smtp.server.close();
    await adm.post('/admin/integracoes/mail', { smtp_pass__remover: 1, smtp_secure: 'starttls' });
  }
  assert.equal(config.mail.mode, 'local');
});

test('WhatsApp/SMS: só para quem autorizou, pela Twilio configurada na tela', async (t) => {
  const realFetch = global.fetch; const sent = [];
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.twilio.com/')) return realFetch(url, opts);
    sent.push(Object.fromEntries(new URLSearchParams(opts.body)));
    return new Response(JSON.stringify({ sid: `SM${sent.length}` }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const adm = await adminClient();
  await adm.post('/admin/integracoes/messaging', { provider: 'twilio', account_sid: 'AC123', auth_token: 'tok-twilio', sms_from: '+5511900000000', whatsapp_from: '+5511900000001' });
  assert.equal(config.messaging.mode, 'twilio');
  try {
    const sim = await f.athlete(); const nao = await f.athlete();
    for (const x of [sim, nao]) await x.c.post('/minha-conta/perfil', { name: x.user.name, phone: '(11) 98888-7777' });
    await sim.c.post('/minha-conta/preferencias', { c_whatsapp: 1, n_payments: 1 });
    assert.ok(await db.one("SELECT 1 FROM consents WHERE user_id=? AND doc_key='channel_whatsapp'", sim.user.id), 'autorização registrada');
    const o = await f.organizer(); const ev = await f.event(o.c, { price: '0' });
    await f.register(sim, ev); await f.register(nao, ev);
    await delivery.processQueue();
    const toSim = sent.filter((m) => m.To === 'whatsapp:+5511988887777');
    assert.equal(toSim.length, 1, 'mesmo telefone nas duas contas: só quem autorizou recebe');
    assert.match(toSim[0].Body, /inscrição confirmada/);
    assert.equal((await db.one('SELECT COUNT(*) n FROM message_log WHERE user_id=?', nao.user.id)).n, 0, 'sem autorização, nada é enviado');
    assert.equal((await db.one("SELECT COUNT(*) n FROM message_log WHERE user_id=? AND channel='sms'", sim.user.id)).n, 0, 'SMS não autorizado');
    assert.equal(delivery.toE164('(11) 98888-7777'), '+5511988887777');
    assert.equal(delivery.toE164('123'), null);
  } finally {
    await adm.post('/admin/integracoes/messaging', { provider: '', auth_token__remover: 1 });
  }
});

test('integrações: valor do .env vale quando a tela está vazia; segredo ilegível não quebra', async () => {
  const saved = JSON.parse(JSON.stringify(config.envBaseline));
  try {
    config.envBaseline.cnpj.name = 'Fornecedor do Ambiente';
    await integrations.load();
    assert.equal(config.cnpj.name, 'Fornecedor do Ambiente');
    // valor salvo com outra chave de criptografia é ignorado (tratado como não configurado)
    await db.setSetting('integration:google', { client_id: 'abc', client_secret: { enc: 1, iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==', data: 'AAAA' } });
    await integrations.load();
    assert.equal(config.google.clientSecret, '');
    assert.notEqual(config.google.mode, 'live');
  } finally {
    Object.assign(config.envBaseline, saved);
    await db.run('DELETE FROM settings WHERE "key"=?', 'integration:google');
    await integrations.load();
  }
});

test('revisão: autorização retirada antes do envio cancela a mensagem; "Desativado" vale sobre o .env', async (t) => {
  const realFetch = global.fetch; let calls = 0;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (url, opts) => { if (!String(url).startsWith('https://api.twilio.com/')) return realFetch(url, opts); calls++; return new Response('{"sid":"SMx"}', { status: 201 }); };
  const adm = await adminClient();
  await adm.post('/admin/integracoes/messaging', { provider: 'twilio', account_sid: 'AC9', auth_token: 'tok9', whatsapp_from: '+5511900000001' });
  const a = await f.athlete();
  await a.c.post('/minha-conta/perfil', { name: a.user.name, phone: '(21) 97777-6666' });
  await a.c.post('/minha-conta/preferencias', { c_whatsapp: 1 });
  assert.equal(await delivery.queueUserMessage(a.user.id, 'aviso'), 1);
  await a.c.post('/minha-conta/preferencias', {}); // retira a autorização antes de a fila rodar
  await delivery.processQueue();
  assert.equal(calls, 0, 'nada enviado sem autorização');
  assert.equal((await db.one('SELECT status FROM message_log WHERE user_id=?', a.user.id)).status, 'cancelled');
  // .env ativa o provedor, a tela desativa: vale a tela
  const saved = config.envBaseline.messaging.provider;
  try {
    config.envBaseline.messaging.provider = 'twilio';
    await adm.post('/admin/integracoes/messaging', { provider: '' });
    assert.equal(config.messaging.provider, '');
    assert.equal(config.messaging.mode, 'off');
  } finally { config.envBaseline.messaging.provider = saved; await adm.post('/admin/integracoes/messaging', { provider: '', auth_token__remover: 1 }); }
});
