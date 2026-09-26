import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@/i18n'
import AccountHealth from '@/modules/gateway/components/AccountHealth'
it('expired cooldown requires verification instead of being reported healthy', () => {
  render(<AccountHealth account={{health_status:'cooldown',cooldown_until:'2020-01-01T00:00:00Z'}} />)
  expect(screen.getByText('待恢复验证')).toBeInTheDocument()
  expect(screen.queryByText('健康')).toBeNull()
})
it('active cooldown and unknown health remain distinct', () => {
  const {rerender} = render(<AccountHealth account={{health_status:'cooldown',cooldown_until:'2099-01-01T00:00:00Z'}} />)
  expect(screen.getByText('冷却中')).toBeInTheDocument()
  rerender(<AccountHealth account={{health_status:'unknown'}} />)
  expect(screen.getByText('未验证')).toBeInTheDocument()
})
