import { MemoryRouter } from 'react-router-dom'
import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Requests from '@/modules/gateway/pages/requests'
import { listAdminUsage, listGateway } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
vi.mock('@/modules/gateway/api/gateway', () => ({ listAdminUsage: vi.fn(), listGateway: vi.fn(), listQuotas: vi.fn(), updateQuota: vi.fn() }))
vi.mock('@/lib/toast', () => ({toast:{apiError:vi.fn()}}))
const row = {id:'request-1',model:'public',username:'alice',pat_name:'my-key',credential_name:'fixture-account',inbound_protocol:'openai',status:'ok',total_tokens:12,latency_ms:10,created_at:'2026-09-26T00:00:00Z'}
beforeEach(() => {
  vi.resetAllMocks()
  listAdminUsage.mockResolvedValue({items:[row],total:1})
  listGateway.mockImplementation(path => Promise.resolve(path.endsWith('/attempts') ? {items:[{id:1,upstream_id:2,status:200,duration_ms:10,execution:{upstream_name:'historic-account',upstream_model:'wire-model',upstream_protocol:'openai'}}]} : {id:row.id,model:'public',input_tokens:10,output_tokens:2,cache_read_tokens:0,cache_write_tokens:null,raw_usage:{prompt_tokens:10},execution:{route_name:'public',upstream_name:'historic-account',upstream_model:'wire-model',upstream_protocol:'responses',provider:'custom'}}))
})
it('submits administrator filters and displays full ledger detail with execution snapshots', async () => {
  render(<MemoryRouter><Requests /></MemoryRouter>)
  expect(await screen.findByText('alice')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('用户 ID'),{target:{value:'7'}})
  fireEvent.change(screen.getByLabelText('模型'),{target:{value:'public'}})
  expect(listAdminUsage).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByText('查询'))
  await waitFor(() => expect(listAdminUsage).toHaveBeenLastCalledWith(expect.objectContaining({user_id:'7',model:'public',page:1,per_page:20})))
  await userEvent.click(await screen.findByText('查看'))
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  expect(screen.getByText('custom')).toBeInTheDocument()
  expect(screen.getByText('responses')).toBeInTheDocument()
  expect(screen.getByText('wire-model')).toBeInTheDocument()
  expect(listGateway).toHaveBeenCalledWith('requests/request-1')
  expect(listGateway).toHaveBeenCalledWith('requests/request-1/attempts')
  expect(screen.getByText('缓存读取 Token').parentElement).toHaveTextContent('0')
  expect(screen.getByText('缓存写入 Token').parentElement).toHaveTextContent('未报告')
})
it('retains the list and allows retry after detail loading fails', async () => {
  listGateway.mockRejectedValueOnce({isAxiosError:true})
  render(<MemoryRouter><Requests /></MemoryRouter>)
  await userEvent.click(await screen.findByText('查看'))
  await waitFor(() => expect(toast.apiError).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByText('alice')).toBeInTheDocument()
  await userEvent.click(screen.getByText('查看'))
  expect(await screen.findByRole('dialog')).toBeInTheDocument()
})
it('does not open an obsolete detail after refreshing the query', async () => {
  let resolveDetail
  listGateway.mockImplementation(path => path.endsWith('/attempts') ? Promise.resolve({items:[]}) : new Promise(resolve=>{resolveDetail=resolve}))
  render(<MemoryRouter><Requests /></MemoryRouter>)
  await userEvent.click(await screen.findByText('查看'))
  await userEvent.click(screen.getByText('刷新'))
  await waitFor(() => expect(listAdminUsage).toHaveBeenCalledTimes(2))
  resolveDetail({id:row.id})
  await waitFor(() => expect(screen.getByText('查看')).toBeEnabled())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
