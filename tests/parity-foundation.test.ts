import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { detectImageMediaType, readClipboardImage } from '../src/clipboard-image.js'
import { deriveDeliverables } from '../src/deliverables.js'
import { queueItemLabel, queueItems } from '../src/queue.js'

test('projects queue placement, text, and image editability', () => {
  const text = createUserMessage({ content: [{ type: 'text', text: 'follow up' }], source: { kind: 'user' } })
  const image = createUserMessage({
    content: [{
      type: 'image',
      attachment: {
        attachmentId: 'sha256:test' as never,
        mediaType: 'image/png',
        bytes: 8,
        width: 1,
        height: 1,
      },
    }],
    source: { kind: 'user' },
  })
  const items = queueItems([image], [text])
  assert.equal(items[0]?.placement, 'next-step')
  assert.equal(items[0]?.editable, false)
  assert.equal(queueItemLabel(items[0]!), '[image]')
  assert.equal(items[1]?.placement, 'next-turn')
  assert.equal(items[1]?.editable, true)
})

test('derives only successful mutation deliverables in first-seen order', () => {
  const records = [
    { seq: 1, turn: 1, failed: false, callView: { card: 'generic', title: 'Read', kind: 'read', locations: [{ path: 'a.ts' }] } },
    { seq: 2, turn: 1, failed: false, callView: { card: 'diff', title: 'Edit', diffs: [], locations: [{ path: 'b.ts' }] } },
    { seq: 3, turn: 1, failed: true, callView: { card: 'diff', title: 'Failed', diffs: [], locations: [{ path: 'c.ts' }] } },
    { seq: 4, turn: 2, failed: false, callView: { card: 'generic', title: 'Insert', kind: 'edit', locations: [{ path: 'b.ts' }, { path: 'd.ts' }] } },
    { seq: 5, turn: 2, failed: false, callView: { card: 'generic', title: 'Delete', kind: 'delete', locations: [{ path: 'e.ts' }] } },
  ] as const
  assert.deepEqual(deriveDeliverables(records), [
    { path: 'b.ts', firstSeq: 2, turn: 1 },
    { path: 'd.ts', firstSeq: 4, turn: 2 },
  ])
})

test('detects supported image signatures', () => {
  assert.equal(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'image/png')
  assert.equal(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff])), 'image/jpeg')
  assert.equal(detectImageMediaType(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(detectImageMediaType(Buffer.from('RIFFxxxxWEBP')), 'image/webp')
  assert.equal(detectImageMediaType(Buffer.from('not an image')), undefined)
})

test('uses portable clipboard commands with fallback', async () => {
  const calls: string[] = []
  const image = await readClipboardImage({
    platform: 'linux',
    runner: async command => {
      calls.push(command.file)
      if (command.file === 'wl-paste') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
    },
  })
  assert.deepEqual(calls, ['wl-paste', 'xclip'])
  assert.equal(image?.mediaType, 'image/png')
})
