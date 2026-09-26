import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import Device from '@/modules/gateway/pages/device'
import PrivateRoute from '@/components/app/PrivateRoute'
import { confirmDevice, denyDevice } from '@/modules/gateway/api/gateway'
const auth = vi.hoisted(() => ({
  user: { username: 'fixture-user' },
  loading: false,
  hasPermission: vi.fn(() => true),
}))
vi.mock('@/context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('@/modules/gateway/api/gateway', () => ({
  confirmDevice: vi.fn(),
  denyDevice: vi.fn(),
}))
beforeEach(() => {
  vi.clearAllMocks()
  auth.user = { username: 'fixture-user' }
  auth.hasPermission.mockReturnValue(true)
})
function open(path = '/agent/device-confirm?user_code=ab1234') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Device />
    </MemoryRouter>,
  )
}
it('prefills query code without automatically granting and supports denial', async () => {
  denyDevice.mockResolvedValue({ success: true })
  open()
  expect(screen.getByRole('textbox')).toHaveValue('AB1234')
  expect(confirmDevice).not.toHaveBeenCalled()
  expect(screen.getByText('当前账号：fixture-user')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '拒绝授权' }))
  expect(denyDevice).toHaveBeenCalledWith('AB1234')
  expect(await screen.findByRole('status')).toHaveTextContent('已拒绝授权')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
it('requires a code and retries failures without losing it', async () => {
  confirmDevice
    .mockRejectedValueOnce({ error: 'expired_token' })
    .mockResolvedValueOnce({ success: true })
  open('/agent/device-confirm')
  await userEvent.click(screen.getByRole('button', { name: '确认授权' }))
  expect(confirmDevice).not.toHaveBeenCalled()
  await userEvent.type(screen.getByRole('textbox'), ' aB1234 ')
  await userEvent.click(screen.getByRole('button', { name: '确认授权' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('授权码已过期')
  expect(screen.getByRole('textbox')).toHaveValue(' aB1234 ')
  await userEvent.click(screen.getByRole('button', { name: '确认授权' }))
  expect(await screen.findByRole('status')).toHaveTextContent('已授权')
  expect(confirmDevice).toHaveBeenLastCalledWith('AB1234')
})
it('disables both decisions while a request is pending', async () => {
  let resolve
  confirmDevice.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  open()
  await userEvent.click(screen.getByRole('button', { name: '确认授权' }))
  expect(screen.getByRole('button', { name: '正在授权…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '拒绝授权' })).toBeDisabled()
  expect(screen.getByRole('textbox')).toBeDisabled()
  resolve({ success: true })
  await screen.findByRole('status')
})
it('does not expose decisions without permission', () => {
  auth.hasPermission.mockReturnValue(false)
  open()
  expect(screen.getByRole('alert')).toHaveTextContent('没有设备授权权限')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
it('retains the complete verification link on the login redirect', async () => {
  auth.user = null
  function Destination() {
    return <p>{useLocation().search}</p>
  }
  render(
    <MemoryRouter initialEntries={['/agent/device-confirm?user_code=AB1234']}>
      <Routes>
        <Route
          path="/agent/device-confirm"
          element={
            <PrivateRoute>
              <Device />
            </PrivateRoute>
          }
        />
        <Route path="/login" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() =>
    expect(
      screen.getByText(
        '?returnTo=%2Fagent%2Fdevice-confirm%3Fuser_code%3DAB1234',
      ),
    ).toBeInTheDocument(),
  )
})
