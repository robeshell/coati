import type { MenuNode } from '@/context/AuthContext'
import { isNavVisible } from '@/components/app/menu-tree'

// Presentation groups contain only the menus already granted by the server.
// Existing custom parent hierarchies are left intact; no permissions are added.
const GROUPS = [
  { code: 'gateway_model_management', name: '模型管理', icon: 'IconLayers', pages: ['gateway_upstreams', 'gateway_routes', 'gateway_model_profiles'] },
  { code: 'gateway_access_management', name: '接入管理', icon: 'IconKey', pages: ['gateway_keys', 'gateway_my_channels'] },
  { code: 'gateway_operations', name: '运维与工具', icon: 'IconActivity', pages: ['gateway_requests', 'gateway_cache_tests', 'gateway_websearch'] },
]

export function groupGatewayNavigation(menus: MenuNode[]): MenuNode[] {
  const roots = Array.isArray(menus) ? menus : []
  const grouped = new Set<number>()
  const groups: MenuNode[] = GROUPS.flatMap(group => {
    const children = group.pages.flatMap(code => roots.filter(menu => menu.code === code && isNavVisible(menu)))
    if (!children.length) return []
    children.forEach(menu => grouped.add(menu.id))
    return [{ id: -1001 - GROUPS.indexOf(group), code: group.code, name: group.name, icon: group.icon,
      path: null, component: null, parent_id: null, sort_order: 0, description: null, created_at: null, updated_at: null, menu_type: 'directory', is_active: true, is_visible: true, children }]
  })
  const overview = roots.filter(menu => menu.code === 'gateway_overview' && isNavVisible(menu))
  overview.forEach(menu => grouped.add(menu.id))
  const children = [...overview, ...groups]
  const gateway: MenuNode = { id: -1000, code: 'gateway', name: '模型网关', icon: 'IconLayers',
    path: null, component: null, parent_id: null, sort_order: 0, description: null, created_at: null, updated_at: null, menu_type: 'directory', is_active: true, is_visible: true, children }
  const first = roots.findIndex(menu => grouped.has(menu.id))
  if (first < 0) return roots
  return roots.flatMap((menu, index) => [
    ...(index === first ? [gateway] : []),
    ...(grouped.has(menu.id) ? [] : [menu]),
  ])
}
