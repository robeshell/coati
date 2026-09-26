import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RouteMigration from '@/modules/gateway/pages/routes/RouteMigration'
import * as api from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
const access = vi.hoisted(() => ({ write: true }))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => access.write }),
}))
vi.mock('@/modules/gateway/api/gateway', () => ({
  routeMigrationPreflight: vi.fn(),
  routeMigrationHistory: vi.fn(),
  applyRouteMigration: vi.fn(),
  rollbackRouteMigration: vi.fn(),
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), apiError: vi.fn() },
}))
const ready = {
  model: 'review-model',
  version: 'a'.repeat(64),
  status: 'ready_for_review',
  candidates: [
    {
      source_id: 1,
      account_id: 2,
      account_name: 'Fixture account',
      upstream_model: 'wire-model',
      enabled: true,
    },
  ],
  reasons: [],
  additional_accounts: [],
  proposal: {
    upstream_model: 'wire-model',
    upstream_base: 'https://fixture.invalid/path',
  },
}
const report = {
  items: [
    ready,
    {
      ...ready,
      model: 'manual-model',
      status: 'manual_review',
      proposal: null,
      reasons: [{ code: 'multiple', message: '多个候选需要复核' }],
    },
    {
      ...ready,
      model: 'blocked-model',
      status: 'blocked',
      proposal: null,
      reasons: [{ code: 'conflict', message: '模型名称冲突' }],
    },
  ],
  summary: { total: 3, ready_for_review: 1, manual_review: 1, blocked: 1 },
}
const record = {
  id: 'record-1',
  model: 'migrated-model',
  source_routes: [{ id: 5 }],
  public_route: { id: 8 },
  created_at: '2026-09-26T01:00:00Z',
  rolled_back_at: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  access.write = true
  api.routeMigrationPreflight.mockResolvedValue(report)
  api.routeMigrationHistory.mockResolvedValue({ items: [record] })
  api.applyRouteMigration.mockResolvedValue({})
  api.rollbackRouteMigration.mockResolvedValue({})
})
it('shows differences, proposal and history, with only the reviewed single candidate actionable', async () => {
  render(<RouteMigration />)
  await screen.findByText('review-model')
  expect(screen.getByText('多个候选需要复核')).toBeInTheDocument()
  expect(screen.getByText('模型名称冲突')).toBeInTheDocument()
  expect(screen.getAllByText('迁移此模型')).toHaveLength(1)
  await userEvent.click(screen.getByText('查看迁移结果'))
  expect(screen.getByText('https://fixture.invalid/path')).toBeVisible()
  await userEvent.click(screen.getByText('迁移此模型'))
  expect(screen.getByRole('alertdialog')).toHaveTextContent('review-model')
  expect(api.applyRouteMigration).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('取消'))
  expect(api.applyRouteMigration).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('迁移此模型'))
  await userEvent.click(screen.getByText('确认迁移'))
  await waitFor(() =>
    expect(api.applyRouteMigration).toHaveBeenCalledWith({
      model: 'review-model',
      version: 'a'.repeat(64),
    }),
  )
  await waitFor(() =>
    expect(api.routeMigrationPreflight).toHaveBeenCalledTimes(2),
  )
})
it('preserves failed confirmation for review and retry, then permits confirmed rollback', async () => {
  api.applyRouteMigration.mockRejectedValueOnce({
    message: '配置已变化，请重新预检',
  })
  render(<RouteMigration />)
  await userEvent.click(await screen.findByText('迁移此模型'))
  await userEvent.click(screen.getByText('确认迁移'))
  await waitFor(() => expect(toast.apiError).toHaveBeenCalled())
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  await userEvent.click(screen.getByText('取消'))
  await userEvent.click(screen.getByText('重新预检'))
  await waitFor(() =>
    expect(api.routeMigrationPreflight).toHaveBeenCalledTimes(2),
  )
  await userEvent.click(await screen.findByText('回滚'))
  expect(api.rollbackRouteMigration).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('确认回滚'))
  await waitFor(() =>
    expect(api.rollbackRouteMigration).toHaveBeenCalledWith('record-1'),
  )
})
it('hides writes for readers and filters both model lists', async () => {
  access.write = false
  render(<RouteMigration />)
  await screen.findByText('review-model')
  expect(screen.queryByText('迁移此模型')).not.toBeInTheDocument()
  expect(screen.queryByText('回滚')).not.toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('搜索迁移模型'), 'migrated')
  expect(screen.queryByText('review-model')).not.toBeInTheDocument()
  expect(screen.getByText('migrated-model')).toBeInTheDocument()
})
it('separates preflight failure from retained history and recovers on refresh', async () => {
  api.routeMigrationPreflight.mockRejectedValueOnce(new Error('offline'))
  render(<RouteMigration />)
  expect(await screen.findByRole('alert')).toHaveTextContent('预检加载失败')
  expect(screen.getByText('migrated-model')).toBeInTheDocument()
  expect(screen.queryByText('迁移此模型')).not.toBeInTheDocument()
  await userEvent.click(screen.getByText('重新预检'))
  expect(await screen.findByText('review-model')).toBeInTheDocument()
})
it('handles empty states and failed history without losing preflight', async () => {
  api.routeMigrationHistory.mockRejectedValueOnce(new Error('offline'))
  render(<RouteMigration />)
  expect(await screen.findByRole('alert')).toHaveTextContent('迁移记录加载失败')
  expect(screen.getByText('review-model')).toBeInTheDocument()
  api.routeMigrationPreflight.mockResolvedValue({
    items: [],
    summary: { total: 0, ready_for_review: 0, manual_review: 0, blocked: 0 },
  })
  api.routeMigrationHistory.mockResolvedValue({ items: [] })
  await userEvent.click(screen.getByText('重新预检'))
  expect(await screen.findByText('没有待迁移的候选配置')).toBeInTheDocument()
  expect(screen.getByText('暂无迁移记录')).toBeInTheDocument()
})
it('ignores a response from an unmounted view', async () => {
  let resolve
  api.routeMigrationPreflight.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  const view = render(<RouteMigration />)
  view.unmount()
  render(<RouteMigration />)
  await screen.findByText('review-model')
  await act(async () =>
    resolve({ ...report, items: [{ ...ready, model: 'stale-model' }] }),
  )
  expect(screen.queryByText('stale-model')).not.toBeInTheDocument()
})
