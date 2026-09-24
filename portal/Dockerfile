# coati portal — Flask + React 单镜像（前端构建产物由 Flask 静态托管）
# build context: portal/
# build cmd:  docker build -f portal/Dockerfile -t coati/portal:<tag> portal/

# 基础镜像可覆盖（国内/离线环境可指向镜像源或内网 registry）
ARG FRONTEND_NODE_IMAGE=node:20-alpine
ARG PYTHON_BASE_IMAGE=python:3.11-slim

# ─────────────────────────────────────────────────────────────
# Stage 1: 构建前端静态资源
# ─────────────────────────────────────────────────────────────
FROM ${FRONTEND_NODE_IMAGE} AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci --prefer-offline

COPY frontend/ ./
RUN npm run build


# ─────────────────────────────────────────────────────────────
# Stage 2: Python 运行时
# ─────────────────────────────────────────────────────────────
FROM ${PYTHON_BASE_IMAGE}

WORKDIR /app

ARG APT_MIRROR=none
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_DEFAULT_TIMEOUT=120
ARG PIP_RETRIES=10

# 系统依赖（psycopg2-binary 已包含 libpq，仅需 curl 做 healthcheck）
RUN if [ -n "$APT_MIRROR" ] && [ "$APT_MIRROR" != "none" ]; then \
      sed -i "s/deb.debian.org/$APT_MIRROR/g; s/security.debian.org/$APT_MIRROR/g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s/deb.debian.org/$APT_MIRROR/g; s/security.debian.org/$APT_MIRROR/g" /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Python 依赖
COPY requirements.txt ./
RUN pip install \
      --timeout "$PIP_DEFAULT_TIMEOUT" \
      --retries "$PIP_RETRIES" \
      -i "$PIP_INDEX_URL" \
      --no-cache-dir \
      -r requirements.txt

# 项目代码
COPY . .

# 前端构建产物覆盖（来自 Stage 1）
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# 确保 entrypoint 可执行
RUN chmod +x docker-entrypoint.sh

# 运行时必要目录 + 非 root 运行用户（纵深防御，降低容器内提权影响）
RUN mkdir -p instance && \
    useradd --create-home --uid 10001 appuser && \
    chown -R appuser:appuser /app/instance

ENV FLASK_APP=app.py \
    FLASK_ENV=production \
    PYTHONUNBUFFERED=1

EXPOSE 5000

USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
