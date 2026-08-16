function textFromMessage(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('\n');
}
export function queueItemView(message, placement) {
    const imageCount = message.content.filter(block => block.type === 'image').length;
    const text = textFromMessage(message);
    return {
        id: String(message.id),
        placement,
        text,
        editable: imageCount === 0,
        imageCount,
    };
}
export function queueItems(nextStep, nextTurn) {
    return [
        ...nextStep.map(message => queueItemView(message, 'next-step')),
        ...nextTurn.map(message => queueItemView(message, 'next-turn')),
    ];
}
export function queueItemLabel(item, maxChars = 80) {
    const normalized = item.text.replace(/\s+/gu, ' ').trim();
    const text = normalized === '' ? `[image${item.imageCount === 1 ? '' : ` ×${item.imageCount}`}]` : normalized;
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
