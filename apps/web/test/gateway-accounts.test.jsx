import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AccountsPage from '@/modules/gateway/components/AccountsPage'
import {
  accountBody,
  accountValues,
} from '@/modules/gateway/components/account-form'
import { listGateway, saveGateway } from '@/modules/gateway/api/gateway'
const access = vi.hoisted(() => ({ write: true }))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => access.write }),
}))
vi.mock('@/modules/gateway/api/gateway', () => ({
  listGateway: vi.fn(),
  saveGateway: vi.fn(),
  checkAccount: vi.fn(),
  discoverAccountModels: vi.fn(),
  deleteAccount: vi.fn(),
  copyAccount: vi.fn(),
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), apiError: vi.fn() },
}))
const row = {
  id: 9,
  name: 'My channel',
  protocol: 'openai',
  base_url: 'https://fixture.invalid/v1',
  provider: 'openai-compatible',
  supported_models: ['alpha'],
  display_models: ['mine/alpha'],
  default_model: '',
  model_prefix: 'mine',
  enabled: true,
  has_proxy: true,
  proxy_hint: 'https://proxy.invalid',
  extra_headers: { 'X-Tenant': 'demo' },
  scope: 'personal',
  owner_user_id: 4,
  health_status: 'unknown',
  weight: 100,
  priority: 100,
  concurrency_limit: 10,
  request_timeout_seconds: 120,
  note: '',
}
beforeEach(() => {
  vi.resetAllMocks()
  access.write = true
  listGateway.mockResolvedValue({ items: [row] })
  saveGateway.mockResolvedValue({})
})
it('editing a personal channel sends only writable fields and preserves blank credentials and proxy', async () => {
  render(<AccountsPage personal />)
  await userEvent.click(await screen.findByRole('button', { name: '编辑' }))
  fireEvent.change(screen.getByLabelText('备注'), {
    target: { value: 'updated' },
  })
  await userEvent.click(
    screen.getByRole('button', { name: '保存', exact: true }),
  )
  await waitFor(() => expect(saveGateway).toHaveBeenCalled())
  const [resource, body, id] = saveGateway.mock.calls[0]
  expect(resource).toBe('my-channels')
  expect(id).toBe(9)
  expect(body).toMatchObject({
    note: 'updated',
    model_prefix: 'mine',
    extra_headers: { 'X-Tenant': 'demo' },
    supported_models: ['alpha'],
  })
  for (const key of [
    'id',
    'scope',
    'owner_user_id',
    'has_proxy',
    'display_models',
    'api_key',
    'proxy_url',
  ])
    expect(body).not.toHaveProperty(key)
  expect(
    accountBody({ ...accountValues(row), proxy_mode: 'clear' }, true).proxy_url,
  ).toBeNull()
  expect(() =>
    accountBody({ ...accountValues(row), proxy_mode: 'replace' }, true),
  ).toThrow('请输入新的代理地址')
  expect(() =>
    accountBody({ ...accountValues(row), extra_headers: '[]' }, true),
  ).toThrow('自定义请求头必须是 JSON 对象')
})
it('five-channel limit disables add and read-only users have no mutations', async () => {
  listGateway.mockResolvedValue({
    items: Array.from({ length: 5 }, (_, i) => ({
      ...row,
      id: i,
      name: `channel-${i}`,
    })),
  })
  const view = render(<AccountsPage personal />)
  await screen.findByText('channel-0')
  expect(screen.getByRole('button', { name: '添加个人渠道' })).toBeDisabled()
  expect(screen.getAllByRole('button', { name: '删除' })[0]).toBeDisabled()
  access.write = false
  view.rerender(<AccountsPage personal />)
  expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '检查' })).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: '添加个人渠道' }),
  ).not.toBeInTheDocument()
})
