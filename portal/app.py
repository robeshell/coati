"""
应用入口文件
前后端分离架构
"""
from datetime import datetime
import json
import os
import socket
import sys

from flask import Flask, Response, current_app, jsonify, redirect, request, send_file, send_from_directory
from flask.sessions import SecureCookieSessionInterface
from flask_caching import Cache
from flask_compress import Compress
from flask_cors import CORS
from flask_migrate import Migrate
from werkzeug.middleware.proxy_fix import ProxyFix
from sqlalchemy import text

from backend import db
from backend.app import init_app_routes, init_models
from backend.common.json_encoder import CustomJSONEncoder
from backend.common.scheduler import init_scheduled_task_runner
from backend.app.agent.service.credential_probe import init_credential_probe_runner
from config import get_config

_APP_CACHE = {}


def _is_truthy(value):
    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'}


class AutoSecureSessionInterface(SecureCookieSessionInterface):
    """会话 Cookie 的 Secure 标志采用 auto 策略：
    - 配置 SESSION_COOKIE_SECURE=true/false 时强制指定；
    - 未配置（None）时按 request.is_secure 动态决定（TLS 才打 Secure），
      避免裸 HTTP 部署（docker compose 默认拓扑）登录被 Secure cookie 弄挂。"""

    def get_cookie_secure(self, app):
        configured = app.config.get('SESSION_COOKIE_SECURE')
        if configured is not None:
            return bool(configured)
        return bool(request and request.is_secure)


def _render_site_index(index_path, env_config, models):
    """渲染产品站首页：向静态文件中注入当前生效的下载地址配置。

    index.html 内的 window.COATI_SITE_CONFIG.downloads 以 REPLACE_* 占位；此处按
    「数据库优先、环境变量兜底」解析后，注入一段在内联配置脚本之后、site.js（defer）
    执行之前生效的脚本，让 /site/ 的下载按钮指向平台系统设置里的真实地址。
    """
    try:
        from backend.app.admin.service.settings_service import get_site_download_effective_config
        cfg = get_site_download_effective_config(env_config, db, models)
    except Exception:
        cfg = {}
    with open(index_path, 'r', encoding='utf-8') as f:
        html = f.read()
    downloads = {
        'macDmg': cfg.get('macDmg') or '',
        'macZip': cfg.get('macZip') or '',
        'windowsExe': cfg.get('windowsExe') or '',
        'cliNpm': cfg.get('cliNpm') or '',
    }
    payload = json.dumps(downloads, ensure_ascii=False).replace('</', '<\\/')
    script = (
        '<script>(function(){try{window.COATI_SITE_CONFIG=window.COATI_SITE_CONFIG||{};'
        'window.COATI_SITE_CONFIG.downloads=' + payload + ';}catch(e){}})();</script>\n'
    )
    marker = '</body>'
    if marker in html:
        html = html.replace(marker, script + '</body>')
    else:
        html += script
    return html


def _dev_frontend_origin():
    return str(current_app.config.get('DEV_FRONTEND_URL') or '').rstrip('/')


def _tcp_open(url):
    try:
        host = url.split('://', 1)[-1].split('/', 1)[0]
        if host.startswith('['):
            return False
        hostname, _, port_text = host.partition(':')
        port = int(port_text or (443 if url.startswith('https:') else 80))
        with socket.create_connection((hostname, port), timeout=0.4):
            return True
    except (OSError, ValueError):
        return False


def _serve_site_response(index_path):
    """服务产品站首页（注入下载配置后返回 HTML），其余静态资源走 send_file。"""
    models = current_app.extensions.get('app_models') or {}
    html = _render_site_index(index_path, current_app.config, models)
    return Response(html, mimetype='text/html', status=200)


def _register_error_handlers(app):
    """API 统一返回 JSON 错误结构，避免泄漏 HTML/内部细节；非 API 走默认处理。"""

    @app.errorhandler(404)
    def handle_not_found(e):
        if request.path.startswith('/api/'):
            return jsonify({'error': '资源不存在'}), 404
        return e

    @app.errorhandler(405)
    def handle_method_not_allowed(e):
        if request.path.startswith('/api/'):
            return jsonify({'error': '请求方法不允许'}), 405
        return e

    @app.errorhandler(500)
    def handle_internal_error(e):
        current_app.logger.exception('未处理的服务器错误: %s', e)
        if request.path.startswith('/api/'):
            return jsonify({'error': '服务器内部错误，请稍后重试'}), 500
        return e


def _register_builtin_routes(app):
    @app.after_request
    def add_header(response):
        """为静态资源添加缓存头"""
        static_extensions = ('.js', '.css', '.png', '.jpg', '.jpeg',
                             '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf')
        if request.path.startswith('/site/'):
            # 产品站静态资源不带文件名指纹，禁用强缓存，改为每次协商（ETag/Last-Modified），避免改动后浏览器用旧缓存
            response.headers['Cache-Control'] = 'no-cache'
            return response
        if request.path.endswith(static_extensions):
            response.headers['Cache-Control'] = 'public, max-age=604800'
            response.headers.pop('Expires', None)
            response.headers.pop('Pragma', None)
        return response

    @app.route('/health')
    def health_check():
        """健康检查端点"""
        try:
            db.session.execute(text('SELECT 1'))
            return jsonify({
                "status": "healthy",
                "timestamp": datetime.utcnow().isoformat(),
                "database": "connected"
            })
        except Exception as e:
            return jsonify({
                "status": "unhealthy",
                "error": str(e),
                "timestamp": datetime.utcnow().isoformat()
            }), 500

    # 产品站（portal/site/）：静态页面，随平台单镜像部署，无需额外部署一套。
    # 注册在 SPA 兜底路由之前，保证 /site 与 /site/<path> 命中本站点而非管理端 SPA。
    site_root = os.path.realpath(os.path.join(app.root_path, 'site'))

    @app.route('/site', defaults={'subpath': 'index.html'})
    @app.route('/site/', defaults={'subpath': 'index.html'})
    @app.route('/site/<path:subpath>')
    def serve_product_site(subpath):
        target = os.path.realpath(os.path.join(site_root, subpath))
        if target != site_root and not target.startswith(site_root + os.sep):
            return jsonify({'error': '资源不存在'}), 404
        if os.path.isdir(target):
            target = os.path.join(target, 'index.html')
        if os.path.isfile(target):
            # 首页注入当前生效的下载地址（来源：平台系统设置 产品站下载配置，否则环境变量）
            if os.path.basename(target) == 'index.html':
                return _serve_site_response(target)
            return send_file(target)
        # 未命中：带扩展名（疑似静态资源）→ 404；无扩展名（页面路由）→ 回退站点首页，
        # 避免落到管理端 SPA。
        if os.path.splitext(subpath)[1]:
            return jsonify({'error': '资源不存在'}), 404
        index = os.path.join(site_root, 'index.html')
        if os.path.isfile(index):
            return _serve_site_response(index)
        return jsonify({'error': '资源不存在'}), 404

    @app.route('/', defaults={'path': ''})
    @app.route('/<path:path>')
    def serve_frontend(path):
        """服务前端 SPA（/api/ 路径不落入 SPA，避免未知 API 返回 HTML）"""
        if path.startswith('api/'):
            return jsonify({'error': '资源不存在'}), 404
        frontend_dist = os.path.join(app.root_path, 'frontend', 'dist')
        if path and os.path.exists(os.path.join(frontend_dist, path)):
            return send_from_directory(frontend_dist, path)
        index_path = os.path.join(frontend_dist, 'index.html')
        if os.path.exists(index_path):
            return send_from_directory(frontend_dist, 'index.html')
        vite = _dev_frontend_origin()
        if current_app.debug and vite and request.host != vite.split('://', 1)[-1]:
            if _tcp_open(vite):
                location = f'{vite}/{path}' if path else f'{vite}/'
                query = request.query_string.decode('utf-8')
                if query:
                    location = f'{location}?{query}'
                return redirect(location)
            return Response(
                '<!doctype html><meta charset="utf-8"><title>前端未启动</title>'
                '<p>开发模式下授权页由 Vite 提供，当前 5173 未在监听。</p>'
                '<p>请先在开发启动台启动「门户前端」，再点客户端里的浏览器授权。</p>',
                status=503,
                mimetype='text/html; charset=utf-8',
            )
        return jsonify({"message": "coati API", "status": "running"}), 200


def create_app(env_name=None, start_scheduler=None, scheduler_force=False):
    resolved_env = env_name or os.environ.get('FLASK_ENV', 'development')
    cache_key = resolved_env
    cached_app = _APP_CACHE.get(cache_key)
    if cached_app is not None:
        cached_models = cached_app.extensions.get('app_models', {})
        if start_scheduler is None:
            start_scheduler = _is_truthy(cached_app.config.get('RUN_SCHEDULER_IN_WEB', 'false'))
        if start_scheduler:
            init_scheduled_task_runner(cached_app, db, cached_models, force=scheduler_force)
            init_credential_probe_runner(cached_app, db, cached_models, force=scheduler_force)
        return cached_app

    config_obj = get_config(resolved_env)

    app = Flask(__name__)
    app.config.from_object(config_obj)
    app.config['JSON_AS_ASCII'] = False
    app.session_interface = AutoSecureSessionInterface()

    app.config['CACHE_TYPE'] = 'SimpleCache'
    app.config['CACHE_DEFAULT_TIMEOUT'] = 300
    Cache(app)

    app.config['COMPRESS_MIMETYPES'] = [
        'text/html',
        'text/css',
        'text/xml',
        'application/json',
        'application/javascript',
        'text/javascript',
    ]
    app.config['COMPRESS_LEVEL'] = 6
    app.config['COMPRESS_MIN_SIZE'] = 500
    Compress(app)

    cors_origins = [o.strip() for o in config_obj.CORS_ORIGINS.split(',') if o.strip()]
    CORS(app, resources={r"/api/*": {"origins": cors_origins or []}})
    app.json_encoder = CustomJSONEncoder

    # 可信反向代理支持：修正 remote_addr 与 is_secure（部署在反代后时）
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)
    from backend.common.csrf import csrf_protect
    app.before_request(csrf_protect)

    db.init_app(app)

    with app.app_context():
        models = init_models(db)

    Migrate(app, db, directory='backend/migrations')
    app.register_blueprint(init_app_routes(db, models, app=app))
    app.extensions['app_models'] = models

    if start_scheduler is None:
        start_scheduler = _is_truthy(app.config.get('RUN_SCHEDULER_IN_WEB', 'false'))
    if start_scheduler:
        init_scheduled_task_runner(app, db, models, force=scheduler_force)
        init_credential_probe_runner(app, db, models, force=scheduler_force)

    _register_builtin_routes(app)
    _register_error_handlers(app)
    _APP_CACHE[cache_key] = app
    return app


# Flask CLI / WSGI 默认使用该实例，不自动启调度器，避免多 worker 重复执行任务。
app = create_app(start_scheduler=False)
models = app.extensions.get('app_models', {})


if __name__ == '__main__':
    os.makedirs('instance', exist_ok=True)

    runtime_app = create_app(start_scheduler=True)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else runtime_app.config.get('DEFAULT_PORT', 5001)

    print(f"\n{'='*50}")
    print("coati 启动")
    print(f"{'='*50}")
    print(f"环境: {os.environ.get('FLASK_ENV', 'development')}")
    print(f"端口: {port}")
    print(f"{'='*50}\n")

    runtime_app.run(host='0.0.0.0', port=port, debug=runtime_app.config.get('DEBUG', False))
