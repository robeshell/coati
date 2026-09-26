/** Tags view state: tabs follow navigation, the dashboard stays, closing moves to a neighbor */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { TagsViewProvider, useTagsView } from '@/context/TagsViewContext'

const GATEWAY_PATHS = ['/gateway/upstreams', '/gateway/routes', '/gateway/keys', '/gateway/requests']
const MENUS = [
  ...GATEWAY_PATHS.map((path, i) => ({ id: 1000 + i, name: path, path, menu_type: 'menu', is_active: true, is_visible: true })),
  { id: 1, name: 'Home', path: '/dashboard', menu_type: 'menu', is_active: true, is_visible: true },
  {
    id: 2,
    name: 'System',
    menu_type: 'menu',
    is_active: true,
    is_visible: true,
    children: [
      { id: 3, name: 'Users', path: '/system/users', menu_type: 'menu', is_active: true, is_visible: true },
      { id: 4, name: 'Roles', path: '/system/roles', menu_type: 'menu', is_active: true, is_visible: true },
      { id: 5, name: 'Logs', path: '/system/logs', menu_type: 'menu', is_active: true, is_visible: true },
    ],
  },
]

vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ menus: MENUS }) }))

function setup(initial = '/dashboard') {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>
      <TagsViewProvider>{children}</TagsViewProvider>
    </MemoryRouter>
  )
  return renderHook(() => ({ tags: useTagsView(), navigate: useNavigate(), location: useLocation() }), { wrapper })
}

const paths = (result) => result.current.tags.tabs.map((t) => t.path)

describe('tags view', () => {
  beforeEach(() => sessionStorage.clear())

  it('opens a tab per visited page after the affixed dashboard, and skips unknown pages', () => {
    const { result } = setup()
    act(() => result.current.navigate('/system/users'))
    act(() => result.current.navigate('/system/roles?page=2'))
    act(() => result.current.navigate('/nope'))
    act(() => result.current.navigate('/system/users'))
    expect(paths(result)).toEqual(['/dashboard', '/system/users', '/system/roles'])
    expect(result.current.tags.tabs[0].affix).toBe(true)
    expect(result.current.tags.tabs[2].fullPath).toBe('/system/roles?page=2')
  })

  it('closing the active tab moves to the tab on its right, else its left', () => {
    const { result } = setup()
    for (const path of ['/system/users', '/system/roles', '/system/logs', '/system/roles']) act(() => result.current.navigate(path))
    act(() => result.current.tags.close('/system/roles'))
    expect(result.current.location.pathname).toBe('/system/logs')
    act(() => result.current.tags.close('/system/logs'))
    expect(result.current.location.pathname).toBe('/system/users')
    expect(paths(result)).toEqual(['/dashboard', '/system/users'])
  })

  it('close others / right / all keep the affixed tab', () => {
    const { result } = setup()
    for (const path of ['/system/users', '/system/roles', '/system/logs']) act(() => result.current.navigate(path))
    act(() => result.current.tags.closeRight('/system/users'))
    expect(paths(result)).toEqual(['/dashboard', '/system/users'])
    expect(result.current.location.pathname).toBe('/system/users')
    act(() => result.current.navigate('/system/roles'))
    act(() => result.current.tags.closeOthers('/system/roles'))
    expect(paths(result)).toEqual(['/dashboard', '/system/roles'])
    act(() => result.current.tags.closeAll())
    expect(paths(result)).toEqual(['/dashboard'])
    expect(result.current.location.pathname).toBe('/dashboard')
  })

  it('top-level gateway pages open on navigation and can all be closed', () => {
    const { result } = setup()
    expect(paths(result)).toEqual(['/dashboard'])
    for (const path of GATEWAY_PATHS) act(() => result.current.navigate(path))
    expect(paths(result)).toEqual(['/dashboard', ...GATEWAY_PATHS])
    expect(result.current.tags.tabs.filter((tab) => tab.affix).map((tab) => tab.path)).toEqual(['/dashboard'])
    act(() => result.current.tags.close('/gateway/requests'))
    expect(result.current.location.pathname).toBe('/gateway/keys')
    expect(paths(result)).not.toContain('/gateway/requests')
    act(() => result.current.tags.closeAll())
    expect(paths(result)).toEqual(['/dashboard'])
    expect(result.current.location.pathname).toBe('/dashboard')
  })

  it('closing a restored top-level tab persists across remounts', () => {
    sessionStorage.setItem('tags-view', JSON.stringify([{ path: '/gateway/routes', fullPath: '/gateway/routes?page=2' }]))
    const { result, unmount } = setup('/gateway/routes?page=2')
    act(() => result.current.tags.close('/gateway/routes'))
    expect(result.current.location.pathname).toBe('/dashboard')
    unmount()
    const restored = setup()
    expect(paths(restored.result)).toEqual(['/dashboard'])
  })

  it('refresh bumps the page version', () => {
    const { result } = setup('/system/users')
    act(() => result.current.tags.refresh('/system/users'))
    expect(result.current.tags.versions['/system/users']).toBe(1)
  })
})
