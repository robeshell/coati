/** Mirrors Python _body_has_image; detection never downloads or decodes images. */
export function hasImage(body: Record<string, unknown>): boolean {
  const imageTypes = ['image', 'image_url', 'input_image']
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  if (typeof body.input === 'string' && body.input.includes('data:image/'))
    return true
  const items = [
    ...(Array.isArray(body.messages) ? body.messages : []),
    ...(Array.isArray(body.input) ? body.input : []),
  ]
  return items.some((value) => {
    const item = object(value)
    if (imageTypes.includes(String(item.type))) return true
    if (typeof item.content === 'string')
      return item.content.includes('data:image/')
    if (!Array.isArray(item.content)) return false
    return item.content.some((value) => {
      const part = object(value),
        source = object(part.source),
        image = object(part.image_url)
      return (
        imageTypes.includes(String(part.type)) ||
        ['url', 'base64'].includes(String(source.type)) ||
        (typeof image.url === 'string' && image.url.startsWith('data:image/'))
      )
    })
  })
}
