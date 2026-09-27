import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CacheTests from '@/modules/gateway/pages/cache-tests'
import request from '@/shared/api/request'
vi.mock('@/context/AuthContext',()=>({useAuth:()=>({hasPermission:()=>true})}))
vi.mock('@/shared/api/request',()=>({default:{get:vi.fn(),post:vi.fn(),delete:vi.fn()}}))
vi.mock('@/lib/toast',()=>({toast:{apiError:vi.fn()},errorMessage:error=>error.message}))
const row=id=>({id,name:`run-${id}`,model:'fixture',status:'ok',rounds:1,summary:{completed_rounds:1,hit_ratio:null},results:[],prompt:`body-${id}`})
beforeEach(()=>vi.resetAllMocks())
it('latest detail wins and a late response cannot reopen a closed dialog',async()=>{
 let first
 request.get.mockImplementation(path=>path.endsWith('/1')?new Promise(resolve=>{first=resolve}):path.endsWith('/2')?Promise.resolve(row(2)):Promise.resolve({items:[row(1),row(2)],total:2}))
 render(<CacheTests/>);await screen.findByText('run-1')
 await userEvent.click(screen.getAllByText('详情')[0])
 await userEvent.click(screen.getAllByText('详情')[1])
 expect(await screen.findByRole('dialog')).toHaveTextContent('run-2')
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape',code:'Escape'})
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
 await act(async()=>first(row(1)))
 expect(screen.queryByRole('dialog')).toBeNull()
})
it('refresh moves an emptied last page back to the remaining page',async()=>{
 let removed=false
 request.get.mockImplementation((_path,options)=>Promise.resolve({items:options?.params?.page===2?(removed?[]:[row(21)]):[row(1)],total:removed?20:21}))
 render(<CacheTests/>);await screen.findByText('run-1')
 await userEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('run-21')
 removed=true
 await userEvent.click(screen.getByRole('button',{name:'刷新'}))
 await screen.findByText('run-1')
 expect(request.get).toHaveBeenLastCalledWith('/admin/gateway/cache-tests',expect.objectContaining({params:expect.objectContaining({page:1})}))
})
