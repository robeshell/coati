import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UserLimitsDialog from '@/modules/gateway/components/UserLimitsDialog'
import { listGateway, saveGateway } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'

vi.mock('@/modules/gateway/api/gateway', () => ({
  listGateway: vi.fn(),
  saveGateway: vi.fn(),
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), apiError: vi.fn() },
}))
beforeEach(() => {
  vi.clearAllMocks()
  listGateway.mockResolvedValue({
    daily_limit: 1200,
    concurrency_limit: 2,
    rpm_limit: 10,
  })
  saveGateway.mockResolvedValue({})
})

it('loads shared limits and saves numeric values including zero', async () => {
  render(<UserLimitsDialog user={{ id: 7, username: 'alice' }} />)
  await userEvent.click(screen.getByText('网关额度'))
  expect(
    await screen.findByText('配置 alice 的全部访问密钥共享限制'),
  ).toBeInTheDocument()
  expect(listGateway).toHaveBeenCalledWith('user-limits/7')
  const daily = screen.getByLabelText(/每日 Token 上限/)
  expect(daily).toHaveValue(1200)
  fireEvent.change(daily, { target: { value: '0' } })
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() =>
    expect(saveGateway).toHaveBeenCalledWith(
      'user-limits',
      {
        daily_limit: 0,
        concurrency_limit: 2,
        rpm_limit: 10,
      },
      7,
    ),
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  )
})

it('does not open a zero-filled form when loading fails', async () => {
  listGateway.mockRejectedValueOnce({ isAxiosError: true })
  render(<UserLimitsDialog user={{ id: 7, username: 'alice' }} />)
  await userEvent.click(screen.getByText('网关额度'))
  await waitFor(() => expect(toast.apiError).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(saveGateway).not.toHaveBeenCalled()
})

it('rejects fractional limits and preserves edits after a failed save', async () => {
  saveGateway.mockRejectedValueOnce({ isAxiosError: true })
  render(<UserLimitsDialog user={{ id: 7, username: 'alice' }} />)
  await userEvent.click(screen.getByText('网关额度'))
  const rpm = await screen.findByLabelText(/每分钟请求上限/)
  fireEvent.change(rpm, { target: { value: '1.5' } })
  await userEvent.click(screen.getByText('保存'))
  expect(await screen.findByText('请输入非负整数')).toBeInTheDocument()
  expect(saveGateway).not.toHaveBeenCalled()
  fireEvent.change(rpm, { target: { value: '20' } })
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(toast.apiError).toHaveBeenCalled())
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(rpm).toHaveValue(20)
})

it('clearing the daily limit explicitly restores default inheritance', async () => {
  render(<UserLimitsDialog user={{ id: 7, username: 'alice' }} />)
  await userEvent.click(screen.getByText('网关额度'))
  const daily = await screen.findByLabelText(/每日 Token 上限/)
  fireEvent.change(daily, { target: { value: '' } })
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() => expect(saveGateway).toHaveBeenCalledWith('user-limits', {
    daily_limit: null, concurrency_limit: 2, rpm_limit: 10,
  }, 7))
})
