import type { UserMessage } from '@deepseek-ai/dsh-llm'

export type QueuePlacement = 'next-step' | 'next-turn'

export interface QueueItemView {
  id: string
  placement: QueuePlacement
  text: string
  editable: boolean
  imageCount: number
}

function textFromMessage(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<UserMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

export function queueItemView(message: UserMessage, placement: QueuePlacement): QueueItemView {
  const imageCount = message.content.filter(block => block.type === 'image').length
  const text = textFromMessage(message)
  return {
    id: String(message.id),
    placement,
    text,
    editable: imageCount === 0,
    imageCount,
  }
}

export function queueItems(
  nextStep: readonly UserMessage[],
  nextTurn: readonly UserMessage[],
): QueueItemView[] {
  return [
    ...nextStep.map(message => queueItemView(message, 'next-step')),
    ...nextTurn.map(message => queueItemView(message, 'next-turn')),
  ]
}

export function queueItemLabel(item: QueueItemView, maxChars = 80): string {
  const normalized = item.text.replace(/\s+/gu, ' ').trim()
  const text = normalized === '' ? `[image${item.imageCount === 1 ? '' : ` ×${item.imageCount}`}]` : normalized
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}
