# Coati Portal

Flask + React + PostgreSQL 管理门户与模型网关。

## Docker

```bash
bash setup.sh
```

脚本创建权限为 `0600` 的 `.env.production`，要求至少 12 位管理员密码，并启动门户与 PostgreSQL。默认访问 http://localhost:8080。

## 本地开发

需要 Python 3.11+、PostgreSQL 和 Node.js 24.8+。

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt pytest
cp .env.example .env.development
createdb coati_dev
```

编辑 `.env.development`，设置 `DEV_DATABASE_URL`（例如 `postgresql://localhost/coati_dev`）、`SECRET_KEY`、`ADMIN_PASSWORD` 和 `AGENT_CREDENTIAL_ENCRYPTION_KEY`。根据本机 PostgreSQL 的认证方式填写数据库用户名和密码。

```bash
FLASK_ENV=development flask --app app db upgrade -d backend/migrations
FLASK_ENV=development python backend/scripts/init_rbac_data.py --incremental
FLASK_ENV=development flask --app app run --host 127.0.0.1 --port 5001
```

另开终端：

```bash
cd frontend
npm ci
npm run dev -- --port 5173
```

前端代理 `/api` 到后端 5001。生产部署不要使用开发默认账号密码；上游凭证加密密钥必须稳定保存，更换会导致已有密文无法解密。

## 验证

```bash
python -m pytest backend/tests -q
python backend/scripts/verify_feature.py --module agent
```

若前端已由独立任务验证，可使用 `--skip-build --skip-frontend-tests`。
