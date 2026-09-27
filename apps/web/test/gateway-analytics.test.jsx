import { MemoryRouter } from 'react-router-dom'
import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UsageAnalytics from '@/modules/gateway/components/UsageAnalytics'
import { getUsageAnalytics, listMyUsage } from '@/modules/gateway/api/gateway'
vi.mock('@/modules/gateway/api/gateway',()=>({getUsageAnalytics:vi.fn(),listMyUsage:vi.fn()}))
vi.mock('echarts-for-react',()=>({default:({option})=><div data-testid="chart">{JSON.stringify(option.series.map(s=>s.data))}</div>}))
const fixture={summary:{requests:2,tokens:12,success_rate:50,avg_latency_ms:10,p95_latency_ms:20,prompt_tokens:10,completion_tokens:2,active_models:1,cache_read_tokens:0,cache_write_tokens:null,cache_miss_tokens:10,cache_read_reported_requests:1,cache_write_reported_requests:0,cache_miss_reported_requests:1},trend:[{bucket:'2026-09-26T00:00:00+08:00',tokens:12,requests:2,errors:1}],models:{tokens:12,items:[{model:'model-a',tokens:12,requests:2,share_percent:100}]},users:[{user_id:7,username:'alice',tokens:12,requests:2,errors:1}],quota:{daily_quota:null,remaining:null,used_today:12},filter_options:{models:[{value:'model-a',label:'model-a'}],pats:[{value:3,label:'my-pat'}],users:[{value:7,label:'alice'}]}}
beforeEach(()=>{vi.resetAllMocks();getUsageAnalytics.mockResolvedValue(fixture);listMyUsage.mockResolvedValue({items:[]})})
it('personal statistics keep cache unknown distinct from zero and omit user filters',async()=>{
 render(<MemoryRouter><UsageAnalytics /></MemoryRouter>)
 expect(await screen.findByTestId('chart')).toHaveTextContent('[[12],[2]]')
 expect(screen.getByText('缓存读取 Token').closest('tr')).toHaveTextContent('0')
 expect(screen.getByText('缓存写入 Token').closest('tr')).toHaveTextContent('未报告')
 expect(screen.queryByLabelText('用户')).not.toBeInTheDocument()
 expect(screen.queryByText('用户用量排行')).not.toBeInTheDocument()
 await userEvent.click(screen.getByRole('combobox',{name:/令牌名称/}))
 await userEvent.click(screen.getByRole('option',{name:'my-pat'}))
 expect(getUsageAnalytics).toHaveBeenCalledTimes(1)
 await userEvent.click(screen.getByText('查询'))
 await waitFor(()=>expect(getUsageAnalytics).toHaveBeenLastCalledWith('personal',expect.objectContaining({pat_id:'3'})))
 expect(getUsageAnalytics.mock.calls.at(-1)[1]).not.toHaveProperty('user_id')
})
it('admin statistics show user ranking and submit user/model/status filters',async()=>{
 render(<MemoryRouter><UsageAnalytics scope="admin" /></MemoryRouter>)
 expect(await screen.findByText('用户用量排行')).toBeInTheDocument()
 await userEvent.click(screen.getByRole('combobox',{name:/用户/}))
 await userEvent.click(screen.getByRole('option',{name:'alice'}))
 await userEvent.click(screen.getByRole('combobox',{name:/模型/}))
 await userEvent.click(screen.getByRole('option',{name:'model-a'}))
 await userEvent.click(screen.getByRole('combobox',{name:/状态/}))
 await userEvent.click(screen.getByRole('option',{name:'流中断'}))
 await userEvent.click(screen.getByText('查询'))
 await waitFor(()=>expect(getUsageAnalytics).toHaveBeenLastCalledWith('admin',expect.objectContaining({user_id:'7',model:'model-a',status:'stream_error'})))
 expect(screen.queryByLabelText('令牌名称')).not.toBeInTheDocument()
})
it('empty data has no fabricated trend and errors remain retryable',async()=>{
 getUsageAnalytics.mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValueOnce({...fixture,trend:[],models:{tokens:0,items:[]},users:[]})
 render(<MemoryRouter><UsageAnalytics /></MemoryRouter>)
 expect(await screen.findByRole('alert')).toHaveTextContent('fixture failure')
 await userEvent.click(screen.getByText('刷新'))
 await screen.findByText('用量趋势')
 expect(screen.queryByTestId('chart')).not.toBeInTheDocument()
})
it('ignores a late response after the user changes the query',async()=>{
 let resolveOld
 getUsageAnalytics.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve}))
 render(<MemoryRouter><UsageAnalytics /></MemoryRouter>)
 fireEvent.change(screen.getByLabelText('最近天数'),{target:{value:'1'}})
 await userEvent.click(screen.getByText('查询'))
 await screen.findByTestId('chart')
 resolveOld({...fixture,trend:[]})
 await waitFor(()=>expect(screen.getByTestId('chart')).toBeInTheDocument())
})
