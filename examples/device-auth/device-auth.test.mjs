import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client, ApiError, waitForToken } from './device-auth.mjs'

test('remote HTTP and credential-bearing URLs are refused', () => {
  for (const url of ['http://example.com','https://user:pass@example.com','https://example.com/path','https://example.com/?key=x']) assert.throws(() => new Client(url))
  for (const url of ['https://example.com','http://localhost:8080','http://127.0.0.1:8080','http://[::1]:8080']) assert.doesNotThrow(() => new Client(url))
})
test('cross-origin verification cannot receive a device code', () => {
  const client = new Client('https://example.com')
  assert.throws(() => client.verificationUrl('https://other.example/verify'))
  assert.equal(client.verificationUrl('/agent/device-confirm?user_code=fixture'), 'https://example.com/agent/device-confirm?user_code=fixture')
})
test('requests refuse redirects and never echo an error payload', async () => {
  const client = new Client('https://example.com', async (url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer fixture-token')
    return new Response(JSON.stringify({ error_code: 'denied', error: 'secret-fixture' }), { status: 403 })
  })
  await assert.rejects(client.request('GET','/api/agent/me',undefined,'fixture-token'), error => error instanceof ApiError && error.code === 'denied' && !error.message.includes('secret-fixture'))
})
test('polling honors pending and slow-down before returning the token', async () => {
  let clock = 0, calls = 0
  const delays = []
  const client = { request: async () => { calls++; if (calls === 1) throw new ApiError(400,'authorization_pending'); if (calls === 2) throw new ApiError(429,'slow_down'); return { access_token:'fixture-token' } } }
  const token = await waitForToken(client,{ device_code:'fixture', expires_in:60, interval:5 },{ now:()=>clock, delay:async ms=>{delays.push(ms);clock+=ms} })
  assert.equal(token,'fixture-token'); assert.deepEqual(delays,[5000,5000,10000])
})
test('expired flow stops polling and denied flow does not retry', async () => {
  let clock=0,calls=0
  const client={request:async()=>{calls++;throw new ApiError(400,'access_denied')}}
  const opts={now:()=>clock,delay:async ms=>{clock+=ms}}
  await assert.rejects(waitForToken(client,{device_code:'fixture',expires_in:2,interval:5},opts),/expired/)
  assert.equal(calls,0)
  await assert.rejects(waitForToken(client,{device_code:'fixture',expires_in:30,interval:5},opts),ApiError)
  assert.equal(calls,1)
})
