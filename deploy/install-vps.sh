#!/usr/bin/env bash
# Instala ou atualiza o IaraRun numa VPS AlmaLinux/RHEL 9, sem mexer no que já roda nela.
#
#   cd /opt/IaraRun && git pull && bash deploy/install-vps.sh
#
# O que faz (cada passo é pulado se já estiver feito; pode rodar de novo com segurança):
#   1. Node.js 22 (pacote oficial do AlmaLinux)
#   2. PostgreSQL: usuário e banco "iararun", extensão citext, login por senha só via 127.0.0.1
#   3. Usuário de sistema "iararun", sem login, dono apenas de /opt/IaraRun/storage
#   4. .env de produção (gerado uma vez; nunca sobrescrito)
#   5. Dependências, migrações do banco e serviço systemd "iararun" (escuta só em 127.0.0.1)
#   6. Cloudflare Tunnel para https://$DOMINIO → app (não usa a porta 80 nem a 443)
#
# Não altera: containers Docker, porta 80, outros bancos do PostgreSQL, outros serviços.
set -euo pipefail

DOMINIO="${DOMINIO:-iararun.sabertecnologia.tech}"
APP_DIR="${APP_DIR:-/opt/IaraRun}"
APP_USER="iararun"
PORTA="${PORTA:-3100}"
DB_NAME="iararun"
DB_USER="iararun"
DB_PASSWORD="${DB_PASSWORD:-}"
PG_HBA="/var/lib/pgsql/data/pg_hba.conf"

passo() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32mok\033[0m %s\n' "$*"; }
falha() { printf '\n\033[1;31mERRO: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || falha "Rode como root."
[ -f "$APP_DIR/package.json" ] || falha "Não encontrei o projeto em $APP_DIR."
cd "$APP_DIR"

# ---------------------------------------------------------------- 1. Node.js
passo "1/6 Node.js 22"
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  ok "Node $(node -v) já instalado"
else
  dnf -y module reset nodejs >/dev/null
  dnf -y module install nodejs:22/common
  ok "Node $(node -v) instalado"
fi

# ---------------------------------------------------------------- 2. PostgreSQL
passo "2/6 PostgreSQL (usuário e banco $DB_NAME)"
systemctl is-active --quiet postgresql || falha "O PostgreSQL não está rodando (systemctl status postgresql)."
rpm -q postgresql-contrib >/dev/null 2>&1 || dnf -y install postgresql-contrib
if [ -z "$DB_PASSWORD" ]; then
  read -r -s -p "    Senha do usuário $DB_USER no PostgreSQL (Enter = gerar uma aleatória): " DB_PASSWORD; echo
  [ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(openssl rand -hex 24)"
fi
# Senha passada por variável do psql, sem aparecer na lista de processos
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -v pw="$DB_PASSWORD" -v dbuser="$DB_USER" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'dbuser') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'dbuser')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'dbuser', :'pw')\gexec
SQL
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -v dbname="$DB_NAME" -v dbuser="$DB_USER" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8''', :'dbname', :'dbuser') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname')\gexec
SQL
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS citext;"
ok "usuário e banco $DB_NAME prontos"
if grep -Eq '^host\s+all\s+all\s+(127\.0\.0\.1/32|::1/128)\s+ident' "$PG_HBA"; then
  [ -f "$PG_HBA.bak" ] || cp "$PG_HBA" "$PG_HBA.bak"
  sed -i -E 's/^(host\s+all\s+all\s+(127\.0\.0\.1\/32|::1\/128)\s+)ident/\1scram-sha-256/' "$PG_HBA"
  systemctl reload postgresql
  ok "login por senha liberado só para 127.0.0.1 (cópia em $PG_HBA.bak)"
else
  ok "login por senha local já configurado"
fi
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -tAc "select 1" >/dev/null || falha "Não conectei no banco com o usuário $DB_USER. Confira a senha."
ok "conexão testada"

# ---------------------------------------------------------------- 3. Usuário do sistema
passo "3/6 Usuário de sistema $APP_USER"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/storage"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/storage"
chmod 750 "$APP_DIR/storage"
ok "o app só escreve em $APP_DIR/storage"

# ---------------------------------------------------------------- 4. .env
passo "4/6 Configuração (.env)"
if [ -f .env ]; then
  ok ".env já existe — mantido como está (atualizo só a senha do banco, se mudou)"
  DB_URL="postgres://$DB_USER:$(node -p 'encodeURIComponent(process.argv[1])' "$DB_PASSWORD")@127.0.0.1:5432/$DB_NAME"
  if grep -q '^DATABASE_URL=' .env; then sed -i "s#^DATABASE_URL=.*#DATABASE_URL=$DB_URL#" .env; else echo "DATABASE_URL=$DB_URL" >> .env; fi
else
  if ss -ltn | grep -q ":$PORTA "; then falha "A porta $PORTA já está em uso. Rode de novo com PORTA=outra (ex.: PORTA=3200 bash deploy/install-vps.sh)."; fi
  DB_URL="postgres://$DB_USER:$(node -p 'encodeURIComponent(process.argv[1])' "$DB_PASSWORD")@127.0.0.1:5432/$DB_NAME"
  cat > .env <<EOF
APP_ENV=production
APP_NAME=IaraRun
HOST=127.0.0.1
PORT=$PORTA
BASE_URL=https://$DOMINIO
SESSION_SECRET=$(openssl rand -hex 48)
DATABASE_URL=$DB_URL
DB_CREATE=0
MAIL_FROM=IaraRun <nao-responda@sabertecnologia.tech>
# Preencha quando tiver as credenciais (ver .env.example) e reinicie: systemctl restart iararun
PAYMENT_RECEIVER_MODEL=undecided
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
EOF
  ok ".env criado (porta $PORTA, https://$DOMINIO)"
fi
chown "root:$APP_USER" .env
chmod 640 .env
PORTA="$(grep -E '^PORT=' .env | cut -d= -f2)"

# ---------------------------------------------------------------- 5. App e serviço
passo "5/6 Dependências, banco e serviço"
npm ci --omit=dev --no-audit --no-fund
runuser -u "$APP_USER" -- node --no-warnings scripts/migrate.js
cat > /etc/systemd/system/iararun.service <<EOF
[Unit]
Description=IaraRun — plataforma de eventos esportivos
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) --no-warnings src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_DIR/storage

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable iararun >/dev/null 2>&1
systemctl restart iararun
for i in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$PORTA/" && break; sleep 1; done
curl -fsS -o /dev/null "http://127.0.0.1:$PORTA/" || { journalctl -u iararun -n 30 --no-pager; falha "O app não respondeu na porta $PORTA."; }
ok "app rodando em 127.0.0.1:$PORTA (systemctl status iararun)"

# ---------------------------------------------------------------- 6. Cloudflare Tunnel
passo "6/6 Cloudflare Tunnel → https://$DOMINIO"
if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo -o /etc/yum.repos.d/cloudflared.repo
  dnf -y install cloudflared
fi
ok "$(cloudflared --version | head -1)"
if [ ! -f /root/.cloudflared/cert.pem ]; then
  echo
  echo "    Abra o link que vai aparecer abaixo no navegador (logado na Cloudflare),"
  echo "    escolha o domínio sabertecnologia.tech e clique em Authorize."
  echo
  cloudflared tunnel login
fi
if ! cloudflared tunnel list -o json | grep -q '"name":"iararun"'; then
  cloudflared tunnel create iararun
fi
TUNNEL_ID="$(cloudflared tunnel list -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.name==="iararun");console.log(t?t.id:"")})')"
[ -n "$TUNNEL_ID" ] || falha "Não encontrei o túnel iararun."
mkdir -p /etc/cloudflared
cp "/root/.cloudflared/$TUNNEL_ID.json" "/etc/cloudflared/$TUNNEL_ID.json"
chmod 600 "/etc/cloudflared/$TUNNEL_ID.json"
cat > /etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $DOMINIO
    service: http://127.0.0.1:$PORTA
  - service: http_status:404
EOF
# Cria/atualiza só o registro DNS deste subdomínio
cloudflared tunnel route dns --overwrite-dns iararun "$DOMINIO"
if systemctl list-unit-files | grep -q '^cloudflared.service'; then
  systemctl restart cloudflared
else
  cloudflared service install
fi
systemctl enable --now cloudflared >/dev/null 2>&1 || true
ok "túnel ativo"

echo
printf '\033[1;32mPronto: https://%s\033[0m (o DNS pode levar 1 a 2 minutos)\n' "$DOMINIO"
echo
echo "Próximos passos:"
echo "  1. Crie sua conta pelo site e depois torne-a administradora:"
echo "       cd $APP_DIR && runuser -u $APP_USER -- node --no-warnings scripts/make-admin.js SEU@EMAIL"
echo "  2. Atualizar depois:  cd $APP_DIR && git pull && bash deploy/install-vps.sh"
echo "  3. Logs:              journalctl -u iararun -f"
