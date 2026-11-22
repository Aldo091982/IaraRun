'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('../config');
const { UserError, Forbidden } = require('./util');
const { assertCan } = require('./orgs');

const err401 = () => Object.assign(new Error('Faça login para continuar.'), { status: 401 });
const requireUser = (req, res, next) => (req.user ? next() : next(err401()));
const requireAdmin = (req, res, next) => (!req.user ? next(err401()) : req.user.is_admin && req.session.context === 'admin' ? next() : next(new Forbidden('Área restrita à administração. Selecione o perfil "Administração".')));
/** Exige contexto de organizador com vínculo à organização ativa no contexto. */
const requireOrg = (req, res, next) => {
  if (!req.user) return next(err401());
  if (!req.org) {
    if (req.memberships?.length === 1) return res.redirect(303, `/contexto/org:${req.memberships[0].org_id}?volta=${encodeURIComponent(req.originalUrl)}`);
    if (!req.memberships?.length) return res.redirect(303, '/organizador/cadastro');
    return next(new Forbidden('Selecione no menu a empresa que deseja gerenciar.'));
  }
  next();
};
const perm = (p, eventParam = 'eventId') => (req, res, next) => { try { assertCan(req.member, p, req.params[eventParam]); next(); } catch (e) { next(e); } };
const csrfAfterMultipart = (req, res, next) => (req.body?._csrf === req.csrfToken ? next() : next(new UserError('Sessão do formulário expirou. Recarregue a página.', 403)));

// Uploads: validação de tipo pelo conteúdo (assinatura) e tamanho.
const SIGS = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46], 'application/pdf': [0x25, 0x50, 0x44, 0x46] };
const upload = (maxMb) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: 4 } });
function checkFile(file, allowed, label) {
  if (!file) return null;
  const sig = SIGS[file.mimetype];
  if (!allowed.includes(file.mimetype) || !sig || !sig.every((b, i) => file.buffer[i] === b)) throw new UserError(`${label}: formato não aceito. Envie ${allowed.map((m) => m.split('/')[1].toUpperCase()).join(', ')}.`);
  return file;
}
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/pdf': '.pdf' };
/** Salva arquivo; privados ficam fora da pasta servida publicamente. */
function store(file, { isPrivate }) {
  const dir = isPrivate ? config.privateDir : config.publicUploadDir;
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(16).toString('hex') + EXT[file.mimetype];
  fs.writeFileSync(path.join(dir, key), file.buffer, { mode: 0o600 });
  return key;
}
const privatePath = (key) => { const p = path.join(config.privateDir, path.basename(key)); return p; };

module.exports = { requireUser, requireAdmin, requireOrg, perm, csrfAfterMultipart, upload, checkFile, store, privatePath };
