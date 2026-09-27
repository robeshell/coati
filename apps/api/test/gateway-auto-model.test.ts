import { expect, test } from 'vitest'
import { hasImage } from '../src/modules/gateway/auto-model'

for (const body of [
  { input: 'data:image/png;base64,a' },
  { input: [{ type: 'input_image' }] },
  { messages: [{ content: 'look data:image/png;base64,a' }] },
  ...['image', 'input_image', 'image_url'].map((type) => ({
    messages: [{ content: [{ type }] }],
  })),
  ...['url', 'base64'].map((type) => ({
    messages: [{ content: [{ source: { type } }] }],
  })),
  {
    messages: [
      { content: [{ image_url: { url: 'data:image/png;base64,a' } }] },
    ],
  },
])
  test(`Python image detection: ${JSON.stringify(body)}`, () =>
    expect(hasImage(body)).toBe(true))
for (const body of [
  {},
  { input: 'https://example.invalid/image.png' },
  {
    messages: [
      null,
      { content: 'plain text' },
      { content: [null, { type: 'text', text: 'hello' }] },
    ],
  },
])
  test(`non-image request: ${JSON.stringify(body)}`, () =>
    expect(hasImage(body)).toBe(false))
