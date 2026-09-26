import type { Content, Event } from './contracts'
/** Validate bridge lifecycle before an inbound encoder emits frames. No wire conversion here. */
export class EventGuard {
  private started = false
  private terminal = false
  private blocks = new Map<number, Content['type']>()
  private seen = new Set<number>()
  accept(event: Event): void {
    if (this.terminal) throw new Error('Event after terminal')
    if (event.type === 'error') {
      this.terminal = true
      return
    }
    if (event.type === 'start') {
      if (this.started) throw new Error('Duplicate start')
      this.started = true
      return
    }
    if (!this.started) throw new Error('Event before start')
    if (event.type === 'block_start') {
      if (
        !Number.isInteger(event.index) ||
        event.index < 0 ||
        this.seen.has(event.index)
      )
        throw new Error('Invalid block index')
      this.blocks.set(event.index, event.block.type)
      this.seen.add(event.index)
    } else if (event.type === 'delta') {
      const expected = {
        text: 'text',
        reasoning: 'reasoning',
        tool_arguments: 'tool_call',
      }[event.kind]
      if (this.blocks.get(event.index) !== expected)
        throw new Error('Delta without matching open block')
    } else if (event.type === 'block_end') {
      if (!this.blocks.delete(event.index))
        throw new Error('End without open block')
    } else if (event.type === 'usage') {
      const { usage } = event
      for (const value of [
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.reasoning,
      ]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
          throw new Error('Invalid usage')
      }
      if (
        (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.input ||
        (usage.reasoning ?? 0) > usage.output
      )
        throw new Error('Usage subsets exceed totals')
    } else if (event.type === 'finish') {
      if (this.blocks.size) throw new Error('Finish with open blocks')
      this.terminal = true
    }
  }
  end(): void {
    if (!this.terminal) throw new Error('Truncated stream')
  }
}
