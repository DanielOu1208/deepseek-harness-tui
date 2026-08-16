import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export function modelSelectionFromEvents(
  events: readonly SessionEvent[],
  fallback: ModelSelection,
): ModelSelection {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header') continue
    const config = event.data.header.config
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
  }
  return fallback
}

export function forkSeedEvents(events: readonly SessionEvent[], boundary: number): SessionEvent[] {
  if (boundary < 0) return []
  const nextTurn = events.find(event => event.seq > boundary && event.type === 'turn/start')
  const cut = nextTurn?.seq ?? Number.POSITIVE_INFINITY
  return events.filter(event => event.seq < cut)
}
