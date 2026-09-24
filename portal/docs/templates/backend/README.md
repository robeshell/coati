# 后端模板使用说明

## 文件说明

| 文件 | 对应层 | 说明 |
|---|---|---|
| `model.py` | model 层 | SQLAlchemy 模型，工厂函数格式 |
| `crud.py` | crud 层 | 纯数据库操作 |
| `service.py` | service 层 | 业务逻辑 + 错误处理 |
| `api.py` | api 层 | Flask 路由 + 权限检查 |

schema 层可选，简单场景在 service 层直接处理即可。

## 使用方式

1. 复制所有文件到 `backend/app/<domain>/` 对应子目录
2. 全局替换占位符：
   - `<Resource>` → 模型类名（大驼峰，如 `Customer`）
   - `<resource>` → 资源名（下划线，如 `customer`）
   - `<domain>` → 所属域（如 `admin`、`component_center`）
   - `<domain_resource>` → 权限编码前缀（如 `system_customers`）
3. 补充实际业务字段（搜索 `TODO` 注释）
4. 在 `domain/api/router.py` 中注册：
   ```python
   from backend.app.<domain>.api.<resource> import init_<resource>_api
   init_<resource>_api(bp, db, models)
   ```

## 参考实现

参考 Component Center 中的完整实现：
- `backend/app/component_center/api/list_page.py`
- `backend/app/admin/api/users.py`
