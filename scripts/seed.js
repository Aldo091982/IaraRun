'use strict';
// Dados FICTÍCIOS de demonstração. Todos os registros recebem is_demo=1 e o rótulo [DEMO].
const config = require('../src/config');
const db = require('../src/db');
const { hashPassword, recordConsent, LEGAL } = require('../src/lib/core');
const { createOrder, confirmOrder } = require('../src/lib/orders');
const results = require('../src/lib/results');
const { zonedToUtc, randomToken } = require('../src/lib/util');

const PASSWORD = 'demo12345';
function user(email, name, extra = {}) {
  const ex = db.one('SELECT * FROM users WHERE email=?', email);
  if (ex) return ex;
  const id = Number(db.run('INSERT INTO users(email,name,password_hash,email_verified_at,is_admin,cpf,birth_date,gender,is_demo) VALUES(?,?,?,?,?,?,?,?,1)', email, name, hashPassword(PASSWORD), new Date().toISOString(), extra.admin ? 1 : 0, extra.cpf || null, extra.birth || null, extra.gender || null).lastInsertRowid);
  for (const k of Object.keys(LEGAL)) recordConsent(null, id, k, 'seed');
  return db.one('SELECT * FROM users WHERE id=?', id);
}
const local = (days, hm = '07:00') => { const d = new Date(Date.now() + days * 864e5); return `${d.toISOString().slice(0, 10)}T${hm}`; };

function event(orgId, { name, slug, days, city, state, free, past }) {
  if (db.one('SELECT 1 FROM events WHERE slug=?', slug)) return db.one('SELECT * FROM events WHERE slug=?', slug);
  const start = local(days);
  const id = Number(db.run(`INSERT INTO events(org_id,slug,name,description,sport,start_local,timezone,start_utc,venue,address,city,state,route_info,regulation,regulation_version,change_policy,cancel_policy,kit_pickup_info,support_email,support_phone,fee_percent,fee_payer,status,published_at,is_demo,wizard_step,allow_transfer)
    VALUES(?,?,?,?,?,?,'America/Sao_Paulo',?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,1,9,1)`, orgId, slug, name,
    'Evento FICTÍCIO de demonstração da plataforma. Percurso urbano, largada pela manhã, kit com camiseta e medalha para concluintes. Use para testar inscrição, pagamento simulado, retirada de kit e resultados.',
    'Corrida de rua', start, zonedToUtc(start), 'Parque Municipal (demo)', 'Av. Exemplo, 100', city, state,
    'Percurso plano com dois pontos de hidratação. Largada e chegada no mesmo local.',
    'Regulamento de demonstração. 1. A prova acontece na data e horário informados. 2. Idade mínima de 16 anos, com autorização do responsável para menores. 3. Retirada do kit mediante QR Code. 4. Premiação: troféus aos três primeiros colocados gerais.',
    'Trocas de modalidade e camiseta até 7 dias antes do evento, sujeitas a disponibilidade.', 'Cancelamento com reembolso integral até 7 dias antes do evento.',
    'Retirada na véspera, das 10h às 18h, no local da largada. Apresente o QR Code.', 'atendimento@demo.invalid', '(11) 4000-0000',
    free ? 0 : 5, 'athlete', past ? 'completed' : 'published', new Date().toISOString()).lastInsertRowid);
  const m5 = Number(db.run("INSERT INTO modalities(event_id,name,distance_km,capacity,start_time,sort) VALUES(?,'5 km',5,300,'07:00',0)", id).lastInsertRowid);
  const m10 = Number(db.run("INSERT INTO modalities(event_id,name,distance_km,capacity,start_time,sort) VALUES(?,'10 km',10,200,'07:00',1)", id).lastInsertRowid);
  db.run("INSERT INTO categories(event_id,name,gender) VALUES(?,'Geral','any')", id);
  for (const g of ['F', 'M']) for (const [a, z] of [[16, 29], [30, 39], [40, 49], [50, null]]) db.run('INSERT INTO categories(event_id,name,gender,min_age,max_age) VALUES(?,?,?,?,?)', id, `${g === 'F' ? 'Feminino' : 'Masculino'} ${z ? `${a}-${z}` : `${a}+`}`, g, a, z);
  db.run('INSERT INTO lots(event_id,name,price_cents,starts_utc,ends_utc,quantity,sort) VALUES(?,?,?,?,?,?,1)', id, '1º lote', free ? 0 : 8900, past ? '2000-01-01T00:00:00Z' : null, past ? '2000-01-02T00:00:00Z' : null, 100);
  db.run('INSERT INTO lots(event_id,name,price_cents,sort) VALUES(?,?,?,2)', id, '2º lote', free ? 0 : 10900);
  const kit = Number(db.run("INSERT INTO kits(event_id,name,description,has_shirt) VALUES(?,'Kit Atleta','Camiseta, número de peito e medalha de conclusão',1)", id).lastInsertRowid);
  for (const [s, n] of [['PP', 20], ['P', 60], ['M', 100], ['G', 80], ['GG', 30]]) db.run('INSERT INTO kit_sizes(kit_id,size,stock) VALUES(?,?,?)', kit, s, n);
  if (!free) { const p = Number(db.run("INSERT INTO products(event_id,name,price_cents) VALUES(?,'Viseira oficial',3500)", id).lastInsertRowid); db.run("INSERT INTO product_variants(product_id,label,stock) VALUES(?,'Única',50)", p); }
  db.run("INSERT INTO questions(event_id,label,purpose,type,options,required) VALUES(?,?,?,'select',?,1)", id, 'Possui alguma condição de saúde que a equipe médica deva conhecer?', 'Atendimento médico no dia da prova', JSON.stringify(['Não', 'Sim — informarei no local']));
  db.run("INSERT INTO pickup_points(event_id,name) VALUES(?,'Tenda de retirada — Balcão 1')", id);
  db.run("INSERT INTO coupons(event_id,code,percent_off,min_group) VALUES(?,'EQUIPE10',10,3)", id);
  return { ...db.one('SELECT * FROM events WHERE id=?', id), m5, m10, kit };
}

function seed() {
  if (config.isProd) throw new Error('Seed de demonstração bloqueado em produção.');
  db.open();
  return db.tx(() => {
    const admin = user('admin@demo.invalid', '[DEMO] Administração', { admin: true });
    const owner = user('organizador@demo.invalid', '[DEMO] Organizadora Ana');
    const staff = user('operador@demo.invalid', '[DEMO] Operador de Kits');
    const athlete = user('atleta@demo.invalid', '[DEMO] Atleta Bruno', { cpf: '52998224725', birth: '1991-03-15', gender: 'M' });
    let org = db.one("SELECT * FROM organizations WHERE cnpj='11222333000181'");
    if (!org) {
      const id = Number(db.run(`INSERT INTO organizations(cnpj,legal_name,trade_name,address,cnpj_source,support_email,support_phone,bio,status,mp_status,mp_configured_at,is_demo)
        VALUES('11222333000181','[DEMO] Corridas Exemplo LTDA','[DEMO] Corridas Exemplo',?,'manual','atendimento@demo.invalid','(11) 4000-0000','Organizadora fictícia para demonstração.','active','test',?,1)`, JSON.stringify({ city: 'São Paulo', state: 'SP' }), new Date().toISOString()).lastInsertRowid);
      db.run("INSERT INTO org_members(org_id,user_id,role) VALUES(?,?,'owner')", id, owner.id);
      db.run("INSERT INTO org_members(org_id,user_id,role,permissions) VALUES(?,?,'collaborator',?)", id, staff.id, JSON.stringify(['kits']));
      db.run("INSERT INTO documents(org_id,user_id,kind,storage_key,original_name,mime,size,status) VALUES(?,?,'identity','demo-inexistente.pdf','documento-demo.pdf','application/pdf',0,'verified')", id, owner.id);
      db.run('INSERT INTO onboarding_drafts(user_id,step,org_id) VALUES(?,4,?)', owner.id, id);
      org = db.one('SELECT * FROM organizations WHERE id=?', id);
    }
    const paid = event(org.id, { name: '[DEMO] Corrida da Cidade', slug: 'demo-corrida-da-cidade', days: 45, city: 'São Paulo', state: 'SP' });
    event(org.id, { name: '[DEMO] Caminhada Solidária', slug: 'demo-caminhada-solidaria', days: 20, city: 'Campinas', state: 'SP', free: true });
    const past = event(org.id, { name: '[DEMO] Desafio de Outono', slug: 'demo-desafio-de-outono', days: -20, city: 'Santos', state: 'SP', free: true, past: true });
    if (past.m5 && !db.one('SELECT 1 FROM registrations WHERE event_id=?', past.id)) {
      // inscrições e resultados no evento passado (inserção direta: lote já encerrado)
      const people = [[athlete, 'M', '1991-03-15', '52998224725'], [null, 'F', '1988-07-01', '11144477735'], [null, 'M', '1979-11-20', '39053344705'], [null, 'F', '1995-02-02', '86288366757']];
      people.forEach(([u, g, b, cpf], i) => {
        const oc = `PDEMO${i}`;
        const oid = Number(db.run("INSERT INTO orders(code,user_id,event_id,status,paid_at) VALUES(?,?,?,'free',?)", oc, (u || athlete).id, past.id, new Date().toISOString()).lastInsertRowid);
        db.run("INSERT INTO registrations(order_id,event_id,modality_id,category_id,kit_id,kit_size,user_id,buyer_user_id,name,cpf,birth_date,gender,status,bib,qr_token,regulation_version,regulation_accepted_at) VALUES(?,?,?,(SELECT id FROM categories WHERE event_id=? AND gender=? AND min_age IS NOT NULL LIMIT 1),?,?,?,?,?,?,?,?,'confirmed',?,?,1,?)",
          oid, past.id, past.m5, past.id, g, past.kit, 'M', u ? u.id : null, athlete.id, u ? u.name : `[DEMO] Participante ${i + 1}`, cpf, b, g, String(i + 1), randomToken(18), new Date().toISOString());
      });
      const csv = 'numero_peito;nome;modalidade;tempo_bruto;tempo_liquido;situacao\n1;;5 km;00:24:30;00:24:05;CONCLUIU\n2;;5 km;00:26:10;00:25:50;CONCLUIU\n3;;5 km;00:23:59;00:23:40;CONCLUIU\n4;;5 km;;;NAO_CONCLUIU\n';
      const pv = results.preview(past.id, csv);
      const vid = results.saveVersion(past.id, pv.rows.filter((r) => !r.errors.length), owner.id, 'Importação de demonstração');
      results.publish(vid, 'official');
    }
    db.run("INSERT OR IGNORE INTO athlete_records(id,user_id,event_name,date,distance_km,time_s,source) VALUES(9001,?,'[DEMO] Prova externa (registro pessoal)','2025-09-07',5,1530,'athlete')", athlete.id);
    void paid; void admin;
    return { password: PASSWORD };
  });
}
if (require.main === module) {
  const out = seed();
  console.log(`Dados de demonstração criados (ambiente ${config.env}). Senha de todas as contas: ${out.password}
  admin@demo.invalid       — selecione o perfil "Administração" no menu
  organizador@demo.invalid — responsável pela organizadora [DEMO]
  operador@demo.invalid    — colaborador com permissão de entrega de kits
  atleta@demo.invalid      — atleta com resultado no evento passado`);
}
module.exports = { seed, PASSWORD };
