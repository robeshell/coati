import { describe, expect, it } from 'vitest'
import {
  formatCompactNumber, formatNumber, formatTokenCount, getUsageCacheInfo,
} from '@/modules/agent/utils'

describe('用量数字格式化', () => {
  it('Token 正文统一展示完整的千分位数字', () => {
    expect(formatTokenCount(16885)).toBe('16,885')
    expect(formatTokenCount(1000000)).toBe('1,000,000')
    expect(formatTokenCount(null)).toBe('0')
  })

  it('普通数字与 Token 使用同一基础千分位格式', () => {
    expect(formatNumber(18143)).toBe('18,143')
    expect(formatTokenCount(18143)).toBe(formatNumber(18143))
  })

  it('紧凑格式只保留给图表坐标轴等空间有限的位置', () => {
    expect(formatCompactNumber(16885)).toBe('16.9K')
    expect(formatCompactNumber(1000000)).toBe('1.0M')
  })

  it('缓存命中率只根据已知的读/未命中 Token 计算', () => {
    expect(getUsageCacheInfo({ prompt_tokens: 1000, cache_read_tokens: 800, cache_miss_tokens: 200 })).toMatchObject({
      hitRate: 80,
      complete: true,
      hasAny: true,
    })
    expect(getUsageCacheInfo({ prompt_tokens: 1000, cache_read_tokens: 800 })).toMatchObject({
      hitRate: null,
      complete: false,
      hasAny: true,
      readReported: true,
      writeReported: false,
      missReported: false,
    })
    expect(getUsageCacheInfo({
      prompt_tokens: 1000,
      cache_read_tokens: 700,
      cache_write_tokens: 100,
      cache_miss_tokens: 200,
    })).toMatchObject({
      observed: 1000,
      hitRate: 70,
      complete: true,
    })
    expect(getUsageCacheInfo({ prompt_tokens: 1000 })).toMatchObject({
      hitRate: null,
      complete: false,
      hasAny: false,
    })
  })
})
