import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PublicRoutes from '@/modules/gateway/pages/routes/PublicRoutes'
import {
  listGateway,
  saveGateway,
  disableGateway,
} from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
const access = vi.hoisted(() => ({ write: true }))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => access.write }),
}))
vi.mock('@/modules/gateway/api/gateway', () => ({
  listGateway: vi.fn(),
  saveGateway: vi.fn(),
  disableGateway: vi.fn(),
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), apiError: vi.fn() },
}))
const row = {
  id: 4,
  model: 'public-text',
  upstream_model: 'text-main',
  upstream_id: 7,
  enabled: true,
  fallback_enabled: true,
  upstream_base: 'https://fixture.invalid/path',
  description: '',
  vision_model: null,
}
const account = {
  id: 7,
  name: 'Fixture account',
  enabled: true,
  supported_models: ['text-main'],
}
beforeEach(() => {
  vi.resetAllMocks()
  access.write = true
  listGateway.mockImplementation((resource) =>
    Promise.resolve({ items: resource === 'upstreams' ? [account] : [row] }),
  )
  saveGateway.mockResolvedValue({})
  disableGateway.mockResolvedValue({})
})
it('shows public routing decisions but hides write actions for readers', async () => {
  access.write = false
  render(<PublicRoutes />)
  expect(await screen.findByText('public-text')).toBeInTheDocument()
  expect(screen.getByText('Fixture account')).toBeInTheDocument()
  expect(screen.getByText('允许回退')).toBeInTheDocument()
  expect(screen.queryByText('添加公开路由')).not.toBeInTheDocument()
  expect(screen.queryByText('编辑')).not.toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('搜索公开路由'), 'missing')
  expect(screen.queryByText('public-text')).not.toBeInTheDocument()
})
it('creates an automatic route and validates coati-auto before submitting', async () => {
  render(<PublicRoutes />)
  await screen.findByText('public-text')
  await userEvent.click(screen.getByText('添加公开路由'))
  fireEvent.change(screen.getByLabelText(/对外模型/), {
    target: { value: 'coati-auto' },
  })
  await userEvent.click(screen.getByText('保存'))
  expect(
    await screen.findByText('自动路由必须配置实际模型'),
  ).toBeInTheDocument()
  expect(saveGateway).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('上游模型'), {
    target: { value: 'text-main' },
  })
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() =>
    expect(saveGateway).toHaveBeenCalledWith(
      'public-routes',
      expect.objectContaining({
        model: 'coati-auto',
        upstream_id: null,
        upstream_model: 'text-main',
        fallback_enabled: false,
        upstream_base: null,
      }),
      undefined,
    ),
  )
})
it('clears hidden binding fields and preserves edits on failed save for retry', async () => {
  saveGateway.mockRejectedValueOnce({ isAxiosError: true })
  render(<PublicRoutes />)
  await userEvent.click(await screen.findByText('编辑'))
  await userEvent.click(screen.getByRole('combobox', { name: '绑定账号' }))
  await userEvent.click(screen.getByRole('option', { name: '自动账号池' }))
  expect(screen.queryByLabelText('路由上游地址覆盖')).not.toBeInTheDocument()
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(toast.apiError).toHaveBeenCalled())
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByLabelText(/对外模型/)).toHaveValue('public-text')
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  )
  expect(saveGateway).toHaveBeenLastCalledWith(
    'public-routes',
    expect.objectContaining({
      upstream_id: null,
      fallback_enabled: false,
      upstream_base: null,
    }),
    4,
  )
})
it('submits bound account fallback and only deletes disabled routes after confirmation', async () => {
  render(<PublicRoutes />)
  await userEvent.click(await screen.findByText('编辑'))
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() =>
    expect(saveGateway).toHaveBeenCalledWith(
      'public-routes',
      expect.objectContaining({
        upstream_id: 7,
        fallback_enabled: true,
        upstream_base: 'https://fixture.invalid/path',
      }),
      4,
    ),
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  )
  expect(screen.queryByText('删除')).not.toBeInTheDocument()
  listGateway.mockImplementation((resource) =>
    Promise.resolve({
      items:
        resource === 'upstreams' ? [account] : [{ ...row, enabled: false }],
    }),
  )
  await userEvent.click(screen.getByText('刷新'))
  await userEvent.click(await screen.findByText('删除'))
  expect(disableGateway).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('确认'))
  await waitFor(() =>
    expect(disableGateway).toHaveBeenCalledWith('public-routes', 4),
  )
})
it('keeps routes visible when account list fails and ignores stale list responses', async () => {
  let old
  listGateway.mockImplementation((resource) =>
    resource === 'upstreams'
      ? Promise.reject(new Error('accounts'))
      : new Promise((resolve) => {
          old = resolve
        }),
  )
  render(<PublicRoutes />)
  await waitFor(() => expect(listGateway).toHaveBeenCalledTimes(2))
  listGateway.mockImplementation((resource) =>
    resource === 'upstreams'
      ? Promise.reject(new Error('accounts'))
      : Promise.resolve({ items: [row] }),
  )
  await userEvent.click(screen.getByText('刷新'))
  expect(await screen.findByText('public-text')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('账号列表未能加载')
  old({ items: [{ ...row, model: 'stale' }] })
  await waitFor(() =>
    expect(screen.queryByText('stale')).not.toBeInTheDocument(),
  )
  await userEvent.click(screen.getByText('编辑'))
  expect(screen.getByRole('combobox')).toBeDisabled()
})

it('retries a failed route list and reports required and length errors', async () => {
  listGateway.mockImplementation((resource) =>
    resource === 'upstreams'
      ? Promise.resolve({ items: [account] })
      : Promise.reject(new Error('route list unavailable')),
  )
  render(<PublicRoutes />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'route list unavailable',
  )
  expect(screen.getByText('添加公开路由')).toBeDisabled()
  listGateway.mockImplementation((resource) =>
    Promise.resolve({ items: resource === 'upstreams' ? [account] : [] }),
  )
  await userEvent.click(screen.getByText('刷新'))
  await waitFor(() => expect(screen.getByText('添加公开路由')).toBeEnabled())
  await userEvent.click(screen.getByText('添加公开路由'))
  await userEvent.click(screen.getByText('保存'))
  expect(await screen.findByText('请输入模型名称')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText(/对外模型/), {
    target: { value: 'x'.repeat(129) },
  })
  await userEvent.click(screen.getByText('保存'))
  expect(
    await screen.findByText('模型名称不能超过 128 个字符'),
  ).toBeInTheDocument()
  expect(saveGateway).not.toHaveBeenCalled()
})
