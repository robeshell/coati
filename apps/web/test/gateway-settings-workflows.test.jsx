import '@/i18n'
import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelProfiles from '@/modules/gateway/pages/model-profiles'
import WebSearch from '@/modules/gateway/pages/web-search'
import request from '@/shared/api/request'
const access = vi.hoisted(() => ({write:true}))
vi.mock('@/context/AuthContext',()=>({useAuth:()=>({hasPermission:()=>access.write})}))
vi.mock('@/shared/api/request',()=>({default:{get:vi.fn(),post:vi.fn(),put:vi.fn(),delete:vi.fn()}}))
vi.mock('@/lib/toast',()=>({toast:{success:vi.fn(),apiError:vi.fn()},errorMessage:error=>error.message}))
const profile={id:1,model_name:'fixture',context_window:128000,max_output_tokens:8192,context_window_override:4096,max_output_tokens_override:null,enabled:true,note:''}
const settings={provider:'tavily',configured:true,has_api_key:true,timeout_seconds:15,source:{provider:'database',api_key:'database'}}
beforeEach(()=>{vi.resetAllMocks();access.write=true})
it('model capability edits can clear an override and survive an initial save failure',async()=>{
 request.get.mockImplementation(path=>Promise.resolve(path.endsWith('/candidates')?{items:['fixture']}:{items:[profile],total:1}))
 request.put.mockRejectedValueOnce(Object.assign(new Error('save failed'),{isAxiosError:true})).mockResolvedValueOnce({})
 render(<ModelProfiles/>);await userEvent.click(await screen.findByRole('button',{name:'编辑'}))
 fireEvent.change(screen.getByLabelText('上下文窗口覆盖值'),{target:{value:''}})
 await userEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'保存',exact:true}))
 await waitFor(()=>expect(request.put).toHaveBeenCalledTimes(1))
 expect(screen.getByRole('dialog')).toBeInTheDocument()
 await userEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'保存',exact:true}))
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
 expect(request.put).toHaveBeenLastCalledWith('/admin/gateway/model-profiles/1',expect.objectContaining({context_window_override:null}))
})
it('search save is single-flight and checking never submits unsaved secrets',async()=>{
 let finish
 request.get.mockResolvedValue(settings)
 request.put.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
 request.post.mockResolvedValue({result_count:1,sample:['https://example.com']})
 render(<WebSearch/>);await screen.findByText('搜索服务已配置')
 fireEvent.change(screen.getByLabelText('API Key'),{target:{value:'fixture-unsaved'}})
 await userEvent.click(screen.getByRole('button',{name:'检查连接'}))
 await screen.findByText('https://example.com')
 expect(request.post).toHaveBeenCalledWith('/admin/gateway/web-search/test',{},expect.any(Object))
 const form=screen.getByRole('button',{name:'保存配置'}).closest('form')
 fireEvent.submit(form);fireEvent.submit(form)
 await waitFor(()=>expect(request.put).toHaveBeenCalledTimes(1))
 await act(async()=>finish(settings))
 expect(screen.getByLabelText('API Key')).toHaveValue('')
})
it('read-only capability and search pages expose no write or paid check actions',async()=>{
 access.write=false
 request.get.mockResolvedValue({items:[profile],total:1})
 const page=render(<ModelProfiles/>);await screen.findByText('fixture')
 expect(screen.queryByRole('button',{name:'编辑'})).toBeNull()
 expect(screen.queryByRole('button',{name:'添加模型能力'})).toBeNull()
 expect(screen.queryByRole('button',{name:'导入能力目录'})).toBeNull()
 page.unmount();request.get.mockResolvedValue(settings)
 render(<WebSearch/>);await screen.findByText('搜索服务已配置')
 expect(screen.getByLabelText('API Key')).toBeDisabled()
 expect(screen.queryByRole('button',{name:'检查连接'})).toBeNull()
 expect(screen.queryByRole('button',{name:'保存配置'})).toBeNull()
 expect(request.post).not.toHaveBeenCalled()
})
