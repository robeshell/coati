import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Button, Form, Toast, Typography } from '@douyinfe/semi-ui'
import { login } from '@/modules/admin/api/auth'
import { useAuth } from '@/context/AuthContext'
import './login.css'

const { Title, Text } = Typography

export default function Login() {
  const { user, login: setAuth, loading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [submitting, setSubmitting] = useState(false)
  const returnTo = typeof location.state?.from === 'string'
    && location.state.from.startsWith('/')
    && !location.state.from.startsWith('//')
    ? location.state.from
    : '/'

  if (!loading && user) return <Navigate to={returnTo} replace />

  const handleSubmit = async (values) => {
    setSubmitting(true)
    try {
      const data = await login(values)
      await setAuth(data.user)
      Toast.success('登录成功')
      navigate(returnTo, { replace: true })
    } catch (err) {
      Toast.error(err?.message || '用户名或密码错误')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="coati-login-page">
      <section className="coati-login-intro" aria-hidden="true">
        <div className="coati-tech-grid" />
        <div className="coati-tech-scan" />

        <svg className="coati-tech-circuits" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="coati-circuit-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity="0" />
              <stop offset="45%" stopColor="#22d3ee" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g className="coati-tech-circuit-lines">
            <path d="M-40 164H190L272 246H380L438 304" />
            <path d="M1040 216H802L742 276H650L592 334" />
            <path d="M-40 790H210L286 714H366L430 650" />
            <path d="M1040 844H840L764 768H662L594 700" />
            <path d="M160 -40V144L256 240" />
            <path d="M846 -40V136L756 226" />
            <path d="M154 1040V856L250 760" />
            <path d="M852 1040V862L754 764" />
          </g>
          <g className="coati-tech-circuit-nodes">
            <circle cx="272" cy="246" r="4" />
            <circle cx="742" cy="276" r="4" />
            <circle cx="286" cy="714" r="4" />
            <circle cx="764" cy="768" r="4" />
            <circle cx="256" cy="240" r="4" />
            <circle cx="756" cy="226" r="4" />
            <circle cx="250" cy="760" r="4" />
            <circle cx="754" cy="764" r="4" />
          </g>
        </svg>

        <div className="coati-tech-particles">
          {Array.from({ length: 12 }, (_, index) => <i key={index} />)}
        </div>

        <div className="coati-tech-core">
          <div className="coati-tech-halo coati-tech-halo--one" />
          <div className="coati-tech-halo coati-tech-halo--two" />
          <div className="coati-tech-orbit coati-tech-orbit--outer">
            <i className="coati-tech-node" />
            <i className="coati-tech-node coati-tech-node--opposite" />
          </div>
          <div className="coati-tech-orbit coati-tech-orbit--middle">
            <i className="coati-tech-node" />
          </div>
          <div className="coati-tech-orbit coati-tech-orbit--inner" />
          <div className="coati-tech-energy">
            <svg className="coati-tech-drop" viewBox="0 0 120 160" preserveAspectRatio="xMidYMid meet">
              <defs>
                <linearGradient id="coati-drop-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#cffafe" />
                  <stop offset="28%" stopColor="#22d3ee" />
                  <stop offset="68%" stopColor="#2563eb" />
                  <stop offset="100%" stopColor="#6d28d9" />
                </linearGradient>
              </defs>
              <path className="coati-tech-drop-body" d="M60 4C52 27 18 63 18 103C18 129 37 149 60 149C83 149 102 129 102 103C102 63 68 27 60 4Z" />
              <path className="coati-tech-drop-shine" d="M47 48C34 67 28 83 29 99C30 108 34 114 40 119" />
              <path className="coati-tech-drop-wave" d="M23 108C43 98 66 96 97 106" />
            </svg>
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>

      <section className="coati-login-form-panel">
        <div className="coati-login-form-wrap">
          <div className="coati-login-mobile-brand">
            <img src="/logo.svg" alt="Coati" />
            <span>Coati</span>
          </div>
          <Title heading={3} className="coati-login-title">登录平台</Title>
          <Text className="coati-login-subtitle">使用平台分配的账号进入管理门户</Text>

          <Form onSubmit={handleSubmit} autoComplete="off" className="coati-login-form">
            <Form.Input
              field="username"
              label="用户名"
              placeholder="请输入用户名"
              rules={[{ required: true, message: '请输入用户名' }]}
              size="large"
            />
            <Form.Input
              field="password"
              label="密码"
              type="password"
              placeholder="请输入密码"
              rules={[{ required: true, message: '请输入密码' }]}
              size="large"
            />
            <Button htmlType="submit" theme="solid" type="primary" size="large" block loading={submitting} className="coati-login-submit">
              登录
            </Button>
          </Form>

          <div className="coati-login-help">如无法登录，请联系平台管理员重置账号或权限。</div>
        </div>
        <footer>
          <span>© 2026 Coati contributors · 企业级模型网关</span>
          <a className="coati-login-site-link" href="https://github.com/robeshell/coati" target="_blank" rel="noopener noreferrer">GitHub</a>
        </footer>
      </section>
    </main>
  )
}
