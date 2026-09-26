import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Quotas from '@/modules/gateway/pages/requests/Quotas'
import { listQuotas, updateQuota } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
const permission = vi.hoisted(() => ({ edit: true }))
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => permission.edit }) }))
vi.mock('@/modules/gateway/api/gateway', () => ({ listQuotas: vi.fn(), updateQuota: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), apiError: vi.fn() } }))
const row = { user_id: 7, username: 'alice', daily_token_quota: 100, effective_quota: 100, quota_source: 'user', used_today: 25, remaining: 75, exhausted: false }
beforeEach(() => {
  vi.resetAllMocks(); permission.edit = true
  listQuotas.mockResolvedValue({ items: [row], total: 1, default_daily_quota: 1000 })
  updateQuota.mockResolvedValue({})
})
it('searches only on submit, shows usage and hides write action for readers', async () => {
  permission.edit = false
  render(<Quotas />)
  expect(await screen.findByText('alice')).toBeInTheDocument()
  expect(screen.getByText('75')).toBeInTheDocument()
  expect(screen.queryByText('编辑配额')).not.toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('搜索用户'), 'bob')
  expect(listQuotas).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByText('查询'))
  await waitFor(() => expect(listQuotas).toHaveBeenLastCalledWith({ page: 1, per_page: 20, search: 'bob' }))
})
it('validates integer quota and preserves edits after failure before retry', async () => {
  updateQuota.mockRejectedValueOnce({ isAxiosError: true })
  render(<Quotas />)
  await userEvent.click(await screen.findByText('编辑配额'))
  const amount = screen.getByLabelText(/每日 Token 上限/)
  fireEvent.change(amount, { target: { value: '1.5' } })
  await userEvent.click(screen.getByText('保存'))
  expect(await screen.findByText('请输入整数')).toBeInTheDocument()
  expect(updateQuota).not.toHaveBeenCalled()
  fireEvent.change(amount, { target: { value: '200' } })
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(toast.apiError).toHaveBeenCalled())
  expect(amount).toHaveValue(200)
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(updateQuota).toHaveBeenLastCalledWith(7, { daily_token_quota: 200 })
  expect(listQuotas).toHaveBeenCalledTimes(2)
})
it.each([['不限额',0],['继承默认额度',null]])('saves %s with the correct distinct value', async (label, value) => {
  render(<Quotas />)
  await userEvent.click(await screen.findByText('编辑配额'))
  await userEvent.click(screen.getByRole('combobox'))
  await userEvent.click(screen.getByRole('option', { name: label }))
  expect(screen.queryByLabelText(/每日 Token 上限/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(updateQuota).toHaveBeenCalledWith(7, { daily_token_quota: value }))
})
it('retries list errors and ignores stale results after a new query', async () => {
  let resolveOld
  listQuotas.mockRejectedValueOnce(new Error('fixture error')).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  render(<Quotas />)
  expect(await screen.findByRole('alert')).toHaveTextContent('fixture error')
  await userEvent.click(screen.getByText('刷新'))
  await userEvent.type(screen.getByLabelText('搜索用户'),'alice')
  await userEvent.click(screen.getByText('查询'))
  expect(await screen.findByText('alice')).toBeInTheDocument()
  resolveOld({ items: [{...row,username:'stale'}],total:1 })
  await waitFor(() => expect(screen.queryByText('stale')).not.toBeInTheDocument())
})
