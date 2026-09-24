#!/bin/bash
# coati 安全部署脚本（只修改当前项目，不修改 Docker 全局配置）
set -euo pipefail

GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; BOLD=$'\033[1m'; NC=$'\033[0m'
info() { echo "${GREEN}✓${NC} $1"; }
warn() { echo "${YELLOW}!${NC} $1"; }
fail() { echo "${RED}✗ $1${NC}" >&2; exit 1; }
random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else python3 -c "import secrets; print(secrets.token_hex($1))"; fi
}

cd "$(dirname "$0")"
echo "${BOLD}Coati Model Gateway 部署${NC}"
echo "本脚本只会创建当前目录的 .env.production，并启动本项目容器。"

command -v docker >/dev/null 2>&1 || fail "未安装 Docker Desktop / Docker Engine"
docker info >/dev/null 2>&1 || fail "Docker 尚未启动"
docker compose version >/dev/null 2>&1 || fail "缺少 docker compose 插件"

if [ -f .env.production ]; then
  read -r -p "检测到已有 .env.production，保留并直接启动？[Y/n] " keep
  if [[ ! "${keep:-Y}" =~ ^[Nn]$ ]]; then
    info "保留现有生产配置"
  else
    mv .env.production ".env.production.backup.$(date +%Y%m%d%H%M%S)"
  fi
fi

if [ ! -f .env.production ]; then
  while true; do
    read -r -s -p "管理员初始密码（至少 12 位）: " admin_password; echo
    if [ "${#admin_password}" -lt 12 ]; then
      warn "密码长度不足 12 位，请重新输入"
      continue
    fi
    if [[ ! "$admin_password" =~ ^[A-Za-z0-9._@%+=:,/-]+$ ]]; then
      warn "密码仅支持字母、数字及 ._@%+=:,/-，避免 dotenv 特殊字符被误解析"
      continue
    fi
    break
  done
  read -r -p "对外访问端口 [8080]: " app_port
  app_port=${app_port:-8080}
  [[ "$app_port" =~ ^[0-9]+$ ]] && [ "$app_port" -ge 1 ] && [ "$app_port" -le 65535 ] || fail "端口不合法"

  secret_key=$(random_secret 48)
  agent_credential_encryption_key=$(random_secret 48)
  postgres_password=$(random_secret 24)
  postgres_ro_password=$(random_secret 24)
  umask 077
  {
    echo 'FLASK_ENV=production'
    echo "SECRET_KEY=$secret_key"
    echo "AGENT_CREDENTIAL_ENCRYPTION_KEY=$agent_credential_encryption_key"
    echo "ADMIN_PASSWORD=$admin_password"
    echo "APP_PORT=$app_port"
    echo "POSTGRES_PASSWORD=$postgres_password"
    echo "POSTGRES_RO_PASSWORD=$postgres_ro_password"
    echo 'ENABLE_TASK_SCHEDULER=true'
    echo 'RUN_SCHEDULER_IN_WEB=true'
    echo 'AGENT_DAILY_TOKEN_QUOTA=0'
    echo 'AGENT_MIN_CLI_VERSION=0.1.0'
    echo 'AGENT_PLUGIN_ALLOWLIST='
    echo 'AGENT_GATEWAY_MAX_ATTEMPTS=3'
    echo 'AGENT_GATEWAY_SELECTION_POOL_SIZE=7'
    echo 'AGENT_ACTIVE_REQUEST_STALE_SECONDS=900'
    echo 'AGENT_CREDENTIAL_FAILURE_THRESHOLD=3'
    echo 'AGENT_CREDENTIAL_COOLDOWN_SECONDS=60'
    echo 'AI_API_KEY='
    echo 'AI_API_BASE='
    echo 'AI_MODEL='
  } > .env.production
  chmod 600 .env.production
  info "已生成权限为 0600 的 .env.production"
fi

# dotenv 不是 shell 脚本，绝不 source；这里只读取健康检查需要的数字端口。
APP_PORT=$(sed -n 's/^APP_PORT=//p' .env.production | tail -n 1)
APP_PORT=${APP_PORT:-8080}
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] || fail ".env.production 中 APP_PORT 不合法"

echo "正在构建并启动服务……"
docker compose --env-file .env.production up -d --build

printf '等待健康检查'
ready=false
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then ready=true; break; fi
  printf '.'; sleep 3
done
echo

if [ "$ready" = true ]; then
  info "服务已就绪：http://127.0.0.1:${APP_PORT}"
else
  warn "服务尚未通过健康检查，请执行：docker compose logs -f app"
  exit 1
fi

echo "管理员账号：admin"
echo "上游模型 Key 请登录后在 Agent → 上游 Key 中配置，不要写入用户本机。"
