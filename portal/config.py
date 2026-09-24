"""
应用配置文件
支持开发环境(development)和生产环境(production)
"""
import os
from datetime import timedelta
from dotenv import load_dotenv

_env = os.environ.get('FLASK_ENV', 'development')
load_dotenv(f'.env.{_env}')


def _require_secret_key():
    """生产环境必须显式配置 SECRET_KEY，缺失则拒绝启动（fail-closed）。"""
    value = (os.environ.get('SECRET_KEY') or '').strip()
    if value:
        return value
    if _env == 'production':
        raise RuntimeError('生产环境必须设置 SECRET_KEY，请使用 setup.sh 生成 .env.production')
    return 'dev-insecure-secret-key'


def _require_admin_password():
    """生产环境必须显式配置 ADMIN_PASSWORD，缺失则拒绝启动（fail-closed）。"""
    value = (os.environ.get('ADMIN_PASSWORD') or '').strip()
    if value:
        return value
    if _env == 'production':
        raise RuntimeError('生产环境必须设置 ADMIN_PASSWORD，请使用 setup.sh 生成 .env.production')
    return 'admin123'


def _require_agent_credential_encryption_key():
    """上游凭证使用独立密钥；生产环境缺失时拒绝启动。"""
    value = (os.environ.get('AGENT_CREDENTIAL_ENCRYPTION_KEY') or '').strip()
    if value:
        return value
    if _env == 'production':
        raise RuntimeError('生产环境必须设置 AGENT_CREDENTIAL_ENCRYPTION_KEY，请使用 setup.sh 生成 .env.production')
    return 'dev-only-agent-credential-encryption-key'


class Config:
    """基础配置"""
    SECRET_KEY = _require_secret_key()
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # 管理员账号（密码在子类中按环境决定）
    ADMIN_USERNAME = 'admin'

    # 上传大小上限（16MB），超限 Flask 直接返回 413
    MAX_CONTENT_LENGTH = int(os.environ.get('MAX_CONTENT_LENGTH', str(16 * 1024 * 1024)))

    # 会话 Cookie 安全
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    # None = auto：显式配 true/false 则强制；未配置时按 request.is_secure 决定（TLS 才 Secure）
    SESSION_COOKIE_SECURE = None
    PERMANENT_SESSION_LIFETIME = timedelta(hours=int(os.environ.get('SESSION_TTL_HOURS', '8')))

    # CORS：默认同源部署（空 = 不开放跨域）；如需跨域用逗号分隔白名单覆盖
    CORS_ORIGINS = os.environ.get('CORS_ORIGINS', '')

    # 登录防爆破
    LOGIN_MAX_FAILURES = int(os.environ.get('LOGIN_MAX_FAILURES', '10'))
    LOGIN_LOCKOUT_MINUTES = int(os.environ.get('LOGIN_LOCKOUT_MINUTES', '15'))

    # 定时任务调度
    ENABLE_TASK_SCHEDULER = os.environ.get('ENABLE_TASK_SCHEDULER', 'true')
    TASK_SCHEDULER_INTERVAL_SECONDS = int(os.environ.get('TASK_SCHEDULER_INTERVAL_SECONDS', '20'))
    TASK_SCHEDULER_LEASE_SECONDS = int(os.environ.get('TASK_SCHEDULER_LEASE_SECONDS', '1800'))
    RUN_SCHEDULER_IN_WEB = os.environ.get('RUN_SCHEDULER_IN_WEB', 'false')

    # Agent 控制面 / 网关
    AI_API_KEY = os.environ.get('AI_API_KEY', '')
    AI_API_BASE = os.environ.get('AI_API_BASE', '')
    AI_MODEL = os.environ.get('AI_MODEL', '')
    AGENT_LLM_KEY = os.environ.get('AGENT_LLM_KEY', '')
    AGENT_LLM_BASE = os.environ.get('AGENT_LLM_BASE', '')
    AGENT_LLM_MODEL = os.environ.get('AGENT_LLM_MODEL', '')
    AGENT_CREDENTIAL_ENCRYPTION_KEY = _require_agent_credential_encryption_key()
    # 网页搜索后端：配置后由它执行服务端搜索/抓取，比委托模型账号快且便宜；
    # 留空则回退到「委托号池里能搜的模型账号」，行为与引入前一致。
    AGENT_WEBSEARCH_PROVIDER = os.environ.get('AGENT_WEBSEARCH_PROVIDER', '')
    AGENT_WEBSEARCH_API_KEY = os.environ.get('AGENT_WEBSEARCH_API_KEY', '')
    AGENT_WEBSEARCH_PROXY_URL = os.environ.get('AGENT_WEBSEARCH_PROXY_URL', '')
    AGENT_WEBSEARCH_TIMEOUT_SECONDS = os.environ.get('AGENT_WEBSEARCH_TIMEOUT_SECONDS', '15')

    AGENT_GATEWAY_MAX_ATTEMPTS = int(os.environ.get('AGENT_GATEWAY_MAX_ATTEMPTS', '3') or 3)
    # 新会话调度候选池大小；与故障转移尝试次数分离，避免只在少量账号中选号。
    AGENT_GATEWAY_SELECTION_POOL_SIZE = int(
        os.environ.get('AGENT_GATEWAY_SELECTION_POOL_SIZE', '7') or 7
    )
    AGENT_GATEWAY_TRANSIENT_RETRIES = int(os.environ.get('AGENT_GATEWAY_TRANSIENT_RETRIES', '1') or 1)
    # 未声明模型能力时 dsh 的保守压缩窗口；不要把它当作任何 Provider 的真实上限。
    AGENT_DEFAULT_CONTEXT_WINDOW = int(os.environ.get('AGENT_DEFAULT_CONTEXT_WINDOW', '128000') or 128000)
    # 旧部署兼容：精确模型能力现在应在 agent_model_profile 统一表维护。
    AGENT_MODEL_PROFILES = os.environ.get('AGENT_MODEL_PROFILES', '{}')
    # LiteLLM 是统一模型能力的默认来源；管理员覆盖保存在 agent_model_profile。
    AGENT_LITELLM_AUTO_SYNC_ENABLED = os.environ.get('AGENT_LITELLM_AUTO_SYNC_ENABLED', 'true')
    AGENT_LITELLM_MODEL_CATALOG_URL = os.environ.get(
        'AGENT_LITELLM_MODEL_CATALOG_URL',
        'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    )
    AGENT_LITELLM_SYNC_INTERVAL_SECONDS = int(
        os.environ.get('AGENT_LITELLM_SYNC_INTERVAL_SECONDS', '86400') or 86400
    )
    AGENT_LITELLM_SYNC_TIMEOUT_SECONDS = int(
        os.environ.get('AGENT_LITELLM_SYNC_TIMEOUT_SECONDS', '10') or 10
    )
    AGENT_SESSION_AFFINITY_ENABLED = os.environ.get('AGENT_SESSION_AFFINITY_ENABLED', 'true')
    AGENT_SESSION_AFFINITY_TTL_SECONDS = int(
        os.environ.get('AGENT_SESSION_AFFINITY_TTL_SECONDS', '3600') or 3600
    )
    AGENT_CREDENTIAL_FAILURE_THRESHOLD = int(os.environ.get('AGENT_CREDENTIAL_FAILURE_THRESHOLD', '3') or 3)
    AGENT_CREDENTIAL_COOLDOWN_SECONDS = int(os.environ.get('AGENT_CREDENTIAL_COOLDOWN_SECONDS', '60') or 60)
    AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS = int(os.environ.get('AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS', '300') or 300)
    # 换 Key 可能成功：软失败只刷新 last_error_at，用这个短窗口做读时降权；到期自动参战。
    AGENT_CREDENTIAL_SOFT_RETRY_SECONDS = int(os.environ.get('AGENT_CREDENTIAL_SOFT_RETRY_SECONDS', '10') or 10)
    # 进程内低频探测：对异常/冷却/未检测账号定期主动探活，恢复无需等真实流量触发。
    AGENT_CREDENTIAL_PROBE_ENABLED = os.environ.get('AGENT_CREDENTIAL_PROBE_ENABLED', 'true')
    AGENT_CREDENTIAL_PROBE_INTERVAL_SECONDS = int(os.environ.get('AGENT_CREDENTIAL_PROBE_INTERVAL_SECONDS', '300') or 300)
    AGENT_CREDENTIAL_PROBE_QUIET_SECONDS = int(os.environ.get('AGENT_CREDENTIAL_PROBE_QUIET_SECONDS', '600') or 600)
    AGENT_CREDENTIAL_PROBE_BATCH_LIMIT = int(os.environ.get('AGENT_CREDENTIAL_PROBE_BATCH_LIMIT', '5') or 5)
    AGENT_DAILY_TOKEN_QUOTA = int(os.environ.get('AGENT_DAILY_TOKEN_QUOTA', '0') or 0)
    AGENT_QUOTA_DEFAULT_MAX_OUTPUT_TOKENS = int(os.environ.get('AGENT_QUOTA_DEFAULT_MAX_OUTPUT_TOKENS', '4096') or 4096)
    AGENT_QUOTA_RESERVATION_TTL_SECONDS = int(os.environ.get('AGENT_QUOTA_RESERVATION_TTL_SECONDS', '3600') or 3600)
    # 进行中请求的异常残留保护；超过该时间的 reserved 记录不参与实时负载统计。
    AGENT_ACTIVE_REQUEST_STALE_SECONDS = int(
        os.environ.get('AGENT_ACTIVE_REQUEST_STALE_SECONDS', '900') or 900
    )
    AGENT_TIMEZONE = os.environ.get('AGENT_TIMEZONE', 'Asia/Shanghai')
    AGENT_MIN_CLI_VERSION = os.environ.get('AGENT_MIN_CLI_VERSION', '0.0.0')
    AGENT_PLUGIN_ALLOWLIST = os.environ.get('AGENT_PLUGIN_ALLOWLIST', '')
    AGENT_PUBLIC_API_BASE = os.environ.get('AGENT_PUBLIC_API_BASE', '')
    AGENT_DESKTOP_MINIO_ENDPOINT = os.environ.get('AGENT_DESKTOP_MINIO_ENDPOINT', '')
    AGENT_DESKTOP_MINIO_PUBLIC_ENDPOINT = os.environ.get('AGENT_DESKTOP_MINIO_PUBLIC_ENDPOINT', '')
    AGENT_DESKTOP_MINIO_BUCKET = os.environ.get('AGENT_DESKTOP_MINIO_BUCKET', 'coati-releases')
    AGENT_DESKTOP_MINIO_REGION = os.environ.get('AGENT_DESKTOP_MINIO_REGION', 'us-east-1')
    AGENT_DESKTOP_MINIO_ACCESS_KEY = os.environ.get('AGENT_DESKTOP_MINIO_ACCESS_KEY', '')
    AGENT_DESKTOP_MINIO_SECRET_KEY = os.environ.get('AGENT_DESKTOP_MINIO_SECRET_KEY', '')
    AGENT_DESKTOP_MINIO_FEED_SECRET = os.environ.get('AGENT_DESKTOP_MINIO_FEED_SECRET', '')
    AGENT_DESKTOP_MINIO_TEST_USER_IDS = os.environ.get('AGENT_DESKTOP_MINIO_TEST_USER_IDS', '')
    AGENT_DESKTOP_UPDATE_PROVIDER = os.environ.get('AGENT_DESKTOP_UPDATE_PROVIDER', '')
    AGENT_DESKTOP_GITEA_URL = os.environ.get('AGENT_DESKTOP_GITEA_URL', '')
    AGENT_DESKTOP_GITEA_REPO = os.environ.get('AGENT_DESKTOP_GITEA_REPO', '')
    AGENT_DESKTOP_GITEA_TOKEN = os.environ.get('AGENT_DESKTOP_GITEA_TOKEN', '')
    AGENT_DESKTOP_GITEA_DOWNLOAD_SECRET = os.environ.get('AGENT_DESKTOP_GITEA_DOWNLOAD_SECRET', '')
    AGENT_DESKTOP_GITEA_TEST_TAG = os.environ.get('AGENT_DESKTOP_GITEA_TEST_TAG', '')
    AGENT_DESKTOP_GITEA_TEST_USER_IDS = os.environ.get('AGENT_DESKTOP_GITEA_TEST_USER_IDS', '')
    AGENT_DESKTOP_UPDATE_URL = os.environ.get('AGENT_DESKTOP_UPDATE_URL', '')
    AGENT_DESKTOP_RELEASE_API_BASE = os.environ.get('AGENT_DESKTOP_RELEASE_API_BASE', '')
    AGENT_DESKTOP_RELEASE_IDENTIFIER = os.environ.get('AGENT_DESKTOP_RELEASE_IDENTIFIER', '')
    AGENT_DESKTOP_RELEASE_TEMPLATE = os.environ.get('AGENT_DESKTOP_RELEASE_TEMPLATE', 'electron.json')
    SITE_DOWNLOAD_MAC_DMG = os.environ.get('SITE_DOWNLOAD_MAC_DMG', '')
    SITE_DOWNLOAD_MAC_ZIP = os.environ.get('SITE_DOWNLOAD_MAC_ZIP', '')
    SITE_DOWNLOAD_WINDOWS_EXE = os.environ.get('SITE_DOWNLOAD_WINDOWS_EXE', '')
    SITE_DOWNLOAD_CLI_NPM = os.environ.get('SITE_DOWNLOAD_CLI_NPM', 'https://github.com/robeshell/coati')
    AGENT_DEVICE_INTERVAL_SECONDS = int(os.environ.get('AGENT_DEVICE_INTERVAL_SECONDS', '5'))
    AGENT_DEVICE_TTL_SECONDS = int(os.environ.get('AGENT_DEVICE_TTL_SECONDS', '600'))
    AGENT_DEVICE_VERIFY_PATH = os.environ.get('AGENT_DEVICE_VERIFY_PATH', '/agent/device-confirm')
    AGENT_DEVICE_STARTS_PER_MINUTE = int(os.environ.get('AGENT_DEVICE_STARTS_PER_MINUTE', '60') or 60)
    AGENT_DEVICE_MAX_ACTIVE = int(os.environ.get('AGENT_DEVICE_MAX_ACTIVE', '5000') or 5000)
    AGENT_DEVICE_RETENTION_HOURS = int(os.environ.get('AGENT_DEVICE_RETENTION_HOURS', '24') or 24)


class DevelopmentConfig(Config):
    """开发环境配置"""
    DEBUG = True
    TESTING = False
    ADMIN_PASSWORD = 'admin123'

    # 开发环境数据库 - PostgreSQL
    SQLALCHEMY_DATABASE_URI = os.environ.get('DEV_DATABASE_URL') or \
        'postgresql://localhost/coati_dev'

    SQLALCHEMY_ECHO = False  # 设为True可以看到SQL语句

    DEFAULT_PORT = 5001
    DEV_FRONTEND_URL = os.environ.get('DEV_FRONTEND_URL', 'http://127.0.0.1:5173')


class ProductionConfig(Config):
    """生产环境配置"""
    DEBUG = False
    TESTING = False

    # 生产环境数据库 - PostgreSQL
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL') or \
        'postgresql://localhost/coati'

    SQLALCHEMY_ECHO = False

    DEFAULT_PORT = 5000

    ADMIN_PASSWORD = _require_admin_password()


class TestingConfig(Config):
    """测试环境配置"""
    DEBUG = True
    TESTING = True
    ADMIN_PASSWORD = 'admin123'

    SQLALCHEMY_DATABASE_URI = 'sqlite:///:memory:'

    DEFAULT_PORT = 5002


config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'testing': TestingConfig,
    'default': DevelopmentConfig
}


def get_config(env_name=None):
    if env_name is None:
        env_name = os.environ.get('FLASK_ENV', 'development')
    return config.get(env_name, config['default'])
