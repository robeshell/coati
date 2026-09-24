# -*- coding: utf-8 -*-
"""数据看板统计 API"""

from datetime import datetime, timedelta
from flask import jsonify, session

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.model.access import get_admin_model, get_operation_log_model, get_role_model, get_menu_model


def init_dashboard_api(bp, db, models):
    Admin = get_admin_model(models)
    OperationLog = get_operation_log_model(models)
    Role = get_role_model(models)
    Menu = get_menu_model(models)

    @bp.route('/api/admin/dashboard/stats', methods=['GET'])
    @login_required
    def dashboard_stats():
        # 该旧接口仍返回平台级统计，个人看板不应继续复用它。
        if not has_menu_permission('agent_ops_dashboard'):
            return jsonify({'error': '无权限'}), 403
        today = datetime.utcnow().date()
        today_start = datetime.combine(today, datetime.min.time())

        # 基础计数
        user_count = Admin.query.count()
        role_count = Role.query.count()
        menu_count = Menu.query.count()
        today_log_count = OperationLog.query.filter(
            OperationLog.created_at >= today_start
        ).count()

        # 近 7 天每日操作日志数（单次聚合查询，替代 7 次 count）
        week_start = today - timedelta(days=6)
        week_start_dt = datetime.combine(week_start, datetime.min.time())
        day_counts = db.session.query(
            db.func.date(OperationLog.created_at).label('day'),
            db.func.count().label('cnt'),
        ).filter(OperationLog.created_at >= week_start_dt).group_by(
            db.func.date(OperationLog.created_at)
        ).all()
        count_map = {str(day): cnt for day, cnt in day_counts}

        week_counts = []
        week_labels = []
        for i in range(6, -1, -1):
            day = today - timedelta(days=i)
            week_counts.append(count_map.get(str(day), 0))
            week_labels.append(day.strftime('%m/%d'))

        return jsonify({
            'user_count':       user_count,
            'role_count':       role_count,
            'menu_count':       menu_count,
            'today_log_count':  today_log_count,
            'week_log_counts':  week_counts,
            'week_labels':      week_labels,
        })
