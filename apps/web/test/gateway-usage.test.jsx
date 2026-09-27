import { expect, it } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import '@/i18n'
import UsageDetails from '@/modules/gateway/pages/requests/UsageDetails'
it('distinguishes unreported counters from zero and labels estimated totals', () => {
  render(<UsageDetails request={{ input_tokens: 100, output_tokens: 5, cache_read_tokens: 0, usage_source: 'estimated' }} />)
  expect(within(screen.getByText('缓存读取 Token').parentElement).getByText('0')).toBeInTheDocument()
  expect(within(screen.getByText('缓存写入 Token').parentElement).getByText('未报告')).toBeInTheDocument()
  expect(screen.getAllByText('（估算）')).toHaveLength(2)
})
it('raw usage is opt-in and renders data as text', () => {
  const { container } = render(<UsageDetails request={{ raw_usage: { custom: '<img src=x onerror=alert(1)>' } }} />)
  const details = container.querySelector('details')
  expect(details.open).toBe(false)
  fireEvent.click(screen.getByText('上游原始用量'))
  expect(details.open).toBe(true)
  expect(container.querySelector('pre').textContent).toContain('<img')
  expect(container.querySelector('img')).toBeNull()
})

it('labels derived cache misses and keeps unknown distinct from zero', () => {
  const { rerender } = render(<UsageDetails request={{cache_miss_tokens: 0, cache_miss_source: 'derived'}} />)
  const row = screen.getByText('缓存未命中 Token').parentElement
  expect(within(row).getByText('0')).toBeInTheDocument()
  expect(within(row).getByText('（推导）')).toBeInTheDocument()
  rerender(<UsageDetails request={{cache_miss_tokens: null}} />)
  expect(within(row).getByText('未报告')).toBeInTheDocument()
  expect(screen.queryByText('（推导）')).toBeNull()
})
