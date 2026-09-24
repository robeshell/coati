import { useEffect, useRef, useState } from 'react'
import './animated-number.css'

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value ?? '').replace(/,/g, '').trim()
  if (!NUMBER_RE.test(text)) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function fractionDigits(value) {
  const text = String(value ?? '').replace(/,/g, '').trim()
  const decimal = text.split('.')[1]
  return decimal ? decimal.length : 0
}

function formatValue(value, decimals) {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

export function AnimatedNumber({ value, duration = 720, className = '' }) {
  const target = numericValue(value)
  const decimals = fractionDigits(value)
  const [displayValue, setDisplayValue] = useState(0)
  const previousTarget = useRef(null)

  useEffect(() => {
    if (target == null) {
      previousTarget.current = null
      return undefined
    }

    const from = previousTarget.current == null ? 0 : previousTarget.current
    previousTarget.current = target
    if (from === target) return undefined

    let frameId
    const startedAt = performance.now()
    const tick = (timestamp) => {
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / duration))
      const eased = 1 - ((1 - progress) ** 3)
      setDisplayValue(from + ((target - from) * eased))
      if (progress < 1) frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [duration, target])

  if (target == null) return <span className={`animated-number ${className}`.trim()}>{value}</span>
  return <span className={`animated-number ${className}`.trim()}>{formatValue(displayValue, decimals)}</span>
}

export default AnimatedNumber
