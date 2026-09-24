import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AnimatedNumber from '@/shared/components/AnimatedNumber'

describe('AnimatedNumber', () => {
  const frames = []

  afterEach(() => {
    frames.length = 0
    vi.unstubAllGlobals()
  })

  it('平滑递增并保持千分位格式', () => {
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(performance, 'now').mockReturnValue(0)

    render(<AnimatedNumber value="1,000" duration={720} />)
    expect(screen.getByText('0')).toBeInTheDocument()

    act(() => frames.shift()(0))
    act(() => frames.shift()(720))
    expect(screen.getByText('1,000')).toBeInTheDocument()
  })

  it('非数字内容原样展示', () => {
    render(<AnimatedNumber value="—" />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
