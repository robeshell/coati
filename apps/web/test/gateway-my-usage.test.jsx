import { MemoryRouter } from 'react-router-dom'
import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MyUsage from '@/modules/gateway/pages/my-usage'
import { listMyUsage, exportMyUsage } from '@/modules/gateway/api/gateway'
import { downloadBlobFile } from '@/shared/utils/file'
const auth=vi.hoisted(()=>({hasPermission:vi.fn(()=>true)}))
vi.mock('@/context/AuthContext',()=>({useAuth:()=>auth}))
vi.mock('@/modules/gateway/api/gateway',()=>({listMyUsage:vi.fn(),exportMyUsage:vi.fn()}))
vi.mock('@/shared/utils/file',()=>({downloadBlobFile:vi.fn()}))
const row={id:'req-1',model:'fixture-model',created_at:'2026-09-26T00:00:00Z',pat_name:'My key',status:'ok',total_tokens:12,cache_read_tokens:0,cache_write_tokens:null}
beforeEach(()=>{vi.clearAllMocks();auth.hasPermission.mockReturnValue(true);listMyUsage.mockResolvedValue({items:[row],total:1});exportMyUsage.mockResolvedValue(new Blob(['fixture']))})
it('loads personal records, applies filters and renders safe details',async()=>{
 render(<MemoryRouter initialEntries={['/agent/my-usage?tab=records']}><MyUsage/></MemoryRouter>);await screen.findByText('fixture-model')
 expect(listMyUsage).toHaveBeenCalledWith(expect.objectContaining({days:'7',page:1,per_page:20}))
 await userEvent.type(screen.getByLabelText('模型'),'other-model')
 await userEvent.click(screen.getByRole('button',{name:'查询'}))
 await waitFor(()=>expect(listMyUsage).toHaveBeenLastCalledWith(expect.objectContaining({model:'other-model',page:1})))
 await userEvent.click(screen.getByRole('button',{name:'查看'}))
 expect(await screen.findByText('仅显示当前账号的请求信息。')).toBeInTheDocument()
 expect(screen.queryByText('上游尝试')).toBeNull()
})
it('exports applied filters rather than unsubmitted edits and supports selected records',async()=>{
 render(<MemoryRouter initialEntries={['/agent/my-usage?tab=records']}><MyUsage/></MemoryRouter>);await screen.findByText('fixture-model')
 await userEvent.type(screen.getByLabelText('模型'),'unsubmitted')
 await userEvent.click(screen.getByRole('button',{name:'导出筛选结果'}))
 await userEvent.click(screen.getByRole('button',{name:'导出',exact:true}))
 await waitFor(()=>expect(exportMyUsage).toHaveBeenCalledWith(expect.objectContaining({export_mode:'filtered',file_type:'xlsx',filters:expect.objectContaining({model:''})})))
 expect(downloadBlobFile).toHaveBeenCalledWith(expect.any(Blob),'my_usage_export.xlsx')
 await userEvent.click(screen.getAllByRole('checkbox')[1])
 await userEvent.click(screen.getByRole('button',{name:'导出选中记录 (1)'}))
 await userEvent.click(screen.getByRole('button',{name:'CSV .csv'}))
 await userEvent.click(screen.getByRole('button',{name:'导出',exact:true}))
 await waitFor(()=>expect(exportMyUsage).toHaveBeenLastCalledWith(expect.objectContaining({export_mode:'selected',ids:['req-1'],file_type:'csv'})))
})
it('hides export for missing permission and recovers from load failure',async()=>{
 auth.hasPermission.mockReturnValue(false)
 listMyUsage.mockRejectedValueOnce(new Error('fixture unavailable'))
 render(<MemoryRouter initialEntries={['/agent/my-usage?tab=records']}><MyUsage/></MemoryRouter>);expect(await screen.findByRole('alert')).toHaveTextContent('fixture unavailable')
 expect(screen.queryByRole('button',{name:'导出筛选结果'})).toBeNull()
 await userEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('fixture-model')
 expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
})
it('ignores stale list responses when filters change',async()=>{
 let resolveOld
 listMyUsage.mockReturnValueOnce(new Promise(resolve=>{resolveOld=resolve}))
 render(<MemoryRouter initialEntries={['/agent/my-usage?tab=records']}><MyUsage/></MemoryRouter>);fireEvent.change(screen.getByLabelText('模型'),{target:{value:'new'}})
 await userEvent.click(screen.getByRole('button',{name:'查询'}));await screen.findByText('fixture-model')
 resolveOld({items:[{...row,model:'stale-model'}],total:1})
 await waitFor(()=>expect(screen.queryByText('stale-model')).toBeNull())
})
