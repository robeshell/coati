#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo '请先安装 Docker 和 Docker Compose。'; exit 1; }
command -v openssl >/dev/null || { echo '请先安装 OpenSSL。'; exit 1; }
docker compose version >/dev/null
if [[ ! -f .env.production ]]; then
  read -r -s -p '管理员密码（至少 12 个字符）：' coati_admin_password
  echo
  [[ ${#coati_admin_password} -ge 12 ]] || { echo '密码长度不足。'; exit 1; }
  read -r -p '访问端口 [8080]：' coati_app_port
  coati_app_port=${coati_app_port:-8080}
  [[ "$coati_app_port" =~ ^[0-9]+$ ]] && ((coati_app_port>=1 && coati_app_port<=65535)) || { echo '端口无效。'; exit 1; }
  # Compose single-quoted values are literal. Escape backslash and apostrophe for dotenv.
  coati_quoted=${coati_admin_password//\\/\\\\}
  coati_quoted=${coati_quoted//\'/\\\'}
  umask 077
  {
    printf "ADMIN_PASSWORD='%s'\n" "$coati_quoted"
    printf 'APP_PORT=%s\n' "$coati_app_port"
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'SECRET_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'GATEWAY_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  } > .env.production
fi
chmod 600 .env.production
docker compose --env-file .env.production up -d --build
printf 'Coati 已启动。默认地址 http://localhost:8080（自定义端口见 .env.production）。\n'
