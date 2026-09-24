# -*- coding: utf-8 -*-
"""Electron 在线更新公开端点。"""

import secrets

from flask import Response, current_app, jsonify, redirect, request, g, stream_with_context
from backend.app.agent.service.bearer import agent_scope_required
from backend.app.agent.service.gitea_desktop_release_service import GiteaDesktopReleaseService

from backend.app.admin.service.settings_service import resolve_desktop_update_settings
from backend.app.agent.service.desktop_release_service import (
    DesktopReleaseError,
    DesktopReleaseService,
    PLATFORMS,
    electron_metadata,
)


def init_agent_desktop_updates_api(bp, db, models):
    def service():
        return DesktopReleaseService(resolve_desktop_update_settings(current_app.config, db, models))

    def error_response(error):
        return jsonify({'error': str(error)}), error.status_code

    @bp.route('/api/agent/desktop-updates/<platform>/<metadata_name>', methods=['GET'])
    def desktop_update_metadata(platform, metadata_name):
        rules = PLATFORMS.get(platform)
        if not rules or metadata_name != rules['metadata']:
            return jsonify({'error': '未找到更新清单'}), 404
        try:
            payload = electron_metadata(service().latest(platform))
        except DesktopReleaseError as error:
            return error_response(error)
        return Response(payload, content_type='text/yaml; charset=utf-8', headers={
            'Cache-Control': 'no-store',
        })

    @bp.route('/api/agent/desktop-updates/<platform>/<version>/<path:file_name>', methods=['GET'])
    def desktop_update_download(platform, version, file_name):
        try:
            release_service = service()
            release = release_service.latest(platform)
            if not secrets.compare_digest(release['version'], version):
                raise DesktopReleaseError('该更新版本已不可用', 404)
            if not secrets.compare_digest(release['file_name'], file_name):
                raise DesktopReleaseError('未找到更新文件', 404)
            return redirect(release_service.download_url(release['file_path']), code=302)
        except DesktopReleaseError as error:
            return error_response(error)


    @bp.route('/api/agent/gitea-updates/<channel>/<platform>/<arch>/<metadata_name>', methods=['GET'])
    @agent_scope_required('profile')
    def gitea_update_metadata(channel, platform, arch, metadata_name):
        if metadata_name != {'macos': 'latest-mac.yml', 'windows': 'latest.yml'}.get(platform):
            return jsonify({'error': '未找到更新清单'}), 404
        if channel == 'preview':
            users = {x.strip() for x in str(current_app.config.get('AGENT_DESKTOP_GITEA_TEST_USER_IDS') or '').split(',') if x.strip()}
            if str(g.agent_user.id) not in users:
                return jsonify({'error': '该账号未开放测试更新'}), 403
        elif current_app.config.get('AGENT_DESKTOP_UPDATE_PROVIDER') != 'gitea':
            return jsonify({'error': '更新渠道未开放'}), 404
        try:
            payload = GiteaDesktopReleaseService(current_app.config).latest(platform, arch, channel)
            return Response(payload, content_type='text/yaml; charset=utf-8', headers={'Cache-Control': 'no-store'})
        except DesktopReleaseError as error:
            return error_response(error)

    @bp.route('/api/agent/gitea-updates/<channel>/<platform>/<arch>/download/<ticket>/<path:file_name>', methods=['GET'])
    def gitea_update_download(channel, platform, arch, ticket, file_name):
        try:
            upstream = GiteaDesktopReleaseService(current_app.config).download(ticket, file_name, request.headers.get('Range'))
        except DesktopReleaseError as error:
            return error_response(error)
        def chunks():
            try:
                yield from upstream.iter_content(256 * 1024)
            finally:
                upstream.close()
        headers = {k: v for k, v in upstream.headers.items() if k.lower() in (
            'content-length', 'content-range', 'accept-ranges', 'content-type')}
        headers['Cache-Control'] = 'private, no-store'
        response = Response(stream_with_context(chunks()), status=upstream.status_code, headers=headers)
        response.call_on_close(upstream.close)
        return response


    @bp.route('/api/agent/minio-updates/<ticket>/<channel>/<platform>/<arch>/<metadata_name>', methods=['GET'])
    def minio_update_metadata(ticket, channel, platform, arch, metadata_name):
        from backend.app.agent.service.minio_desktop_release_service import MinioDesktopReleaseService
        if metadata_name != {'macos': 'latest-mac.yml', 'windows': 'latest.yml'}.get(platform):
            return jsonify({'error': '未找到更新清单'}), 404
        try:
            payload = MinioDesktopReleaseService(current_app.config).latest(ticket, channel, platform, arch)
            return Response(payload, content_type='text/yaml; charset=utf-8', headers={'Cache-Control': 'private, no-store'})
        except DesktopReleaseError as error:
            return error_response(error)

    @bp.route('/api/agent/minio-updates/<ticket>/<channel>/<platform>/<arch>/<version>/<path:file_name>', methods=['GET'])
    def minio_update_download(ticket, channel, platform, arch, version, file_name):
        from backend.app.agent.service.minio_desktop_release_service import MinioDesktopReleaseService
        try:
            url = MinioDesktopReleaseService(current_app.config).download_url(ticket, channel, platform, arch, version, file_name)
            response = redirect(url, code=307)
            response.headers['Cache-Control'] = 'private, no-store'
            response.headers['Referrer-Policy'] = 'no-referrer'
            return response
        except DesktopReleaseError as error:
            return error_response(error)
