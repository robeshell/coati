import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import KeyActions from '@/modules/gateway/components/KeyActions'
import { rotateKey, saveGateway } from '@/modules/gateway/api/gateway'
vi.mock('@/modules/gateway/api/gateway', () => ({
  rotateKey: vi.fn(),
  saveGateway: vi.fn(),
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), apiError: vi.fn() },
}))
const record = {
  id: 5,
  name: 'Fixture',
  kind: 'personal',
  revoked: false,
  expires_at: null,
}
beforeEach(() => vi.resetAllMocks())
it('rotation requires confirmation and delivers the one-time token to the parent', async () => {
  rotateKey.mockResolvedValue({ token: 'fixture-replacement' })
  const onToken = vi.fn(),
    onComplete = vi.fn()
  render(
    <KeyActions
      record={record}
      canRotate
      onToken={onToken}
      onComplete={onComplete}
    />,
  )
  await userEvent.click(screen.getByText('轮换密钥'))
  expect(rotateKey).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('确认'))
  await waitFor(() =>
    expect(onToken).toHaveBeenCalledWith('fixture-replacement'),
  )
  expect(rotateKey).toHaveBeenCalledWith(5)
  expect(onComplete).toHaveBeenCalledTimes(1)
})
it('expiry must be chosen explicitly before an edit can clear it', async () => {
  saveGateway.mockResolvedValue({})
  render(<KeyActions record={record} canEdit />)
  await userEvent.click(screen.getByText('编辑'))
  await userEvent.click(screen.getByText('保存'))
  expect(await screen.findByText('请选择有效期')).toBeInTheDocument()
  expect(saveGateway).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('combobox'))
  await userEvent.click(screen.getByRole('option', { name: '长期有效' }))
  await userEvent.click(screen.getByText('保存'))
  await waitFor(() =>
    expect(saveGateway).toHaveBeenCalledWith(
      'keys',
      { name: 'Fixture', expires_days: null },
      5,
    ),
  )
})
it('revoked keys hide lifecycle actions and device keys cannot be edited', () => {
  const { rerender } = render(
    <KeyActions record={{ ...record, revoked: true }} canEdit canRotate />,
  )
  expect(screen.queryByText('轮换密钥')).not.toBeInTheDocument()
  rerender(
    <KeyActions record={{ ...record, kind: 'device' }} canEdit canRotate />,
  )
  expect(screen.queryByText('编辑')).not.toBeInTheDocument()
  expect(screen.getByText('轮换密钥')).toBeInTheDocument()
})
