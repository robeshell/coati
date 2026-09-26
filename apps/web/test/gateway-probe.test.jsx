import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProbeAccount from '@/modules/gateway/components/ProbeAccount'
import { probeAccount } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
vi.mock('@/modules/gateway/api/gateway', () => ({ probeAccount: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { apiError: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())
it('unverified model discovery does not announce account recovery', async () => {
  probeAccount.mockResolvedValue({
    models: ['fixture-model'],
    verified: false,
    health_updated: false,
    latency_ms: 12,
  })
  const refresh = vi.fn()
  render(
    <ProbeAccount
      account={{ id: 2, name: 'Fixture', enabled: true }}
      onComplete={refresh}
    />,
  )
  await userEvent.click(screen.getByText('恢复探测'))
  expect(
    await screen.findByText('模型发现不代表对话可用，账号健康状态未改变'),
  ).toBeInTheDocument()
  expect(screen.getByText('fixture-model')).toBeInTheDocument()
  expect(screen.queryByText('已验证并恢复账号健康')).not.toBeInTheDocument()
  expect(refresh).toHaveBeenCalledTimes(1)
})
it('failures refresh state without opening a success dialog', async () => {
  probeAccount.mockRejectedValue(new Error('fixture failure'))
  const refresh = vi.fn()
  render(
    <ProbeAccount
      account={{ id: 2, name: 'Fixture', enabled: true }}
      onComplete={refresh}
    />,
  )
  await userEvent.click(screen.getByText('恢复探测'))
  await waitFor(() => expect(toast.apiError).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(refresh).toHaveBeenCalledTimes(1)
})
it('disabled accounts cannot be probed', () => {
  render(<ProbeAccount account={{ id: 2, enabled: false }} />)
  expect(screen.getByRole('button')).toBeDisabled()
  expect(probeAccount).not.toHaveBeenCalled()
})
