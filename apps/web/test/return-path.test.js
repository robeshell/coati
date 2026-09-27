import { describe, it, expect } from 'vitest'
import { safeReturnPath } from '../src/lib/return-path'
describe('authentication return path',()=>{
  it('preserves device verification and local query state',()=>{
    expect(safeReturnPath('/agent/device-confirm')).toBe('/agent/device-confirm')
    expect(safeReturnPath('/gateway/requests?page=2')).toBe('/gateway/requests?page=2')
  })
  it.each(['https://example.com','//example.com','/\\example.com','/\n/example.com','/login?returnTo=/login',null])('rejects external or recursive target %s',value=>expect(safeReturnPath(value)).toBe('/'))
})
