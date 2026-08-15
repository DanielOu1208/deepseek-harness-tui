import test from 'node:test'
import assert from 'node:assert/strict'
import { PromptController } from '../src/prompt-controller.js'

function controllerFor(inputModalities: readonly ('text' | 'image')[]) {
  const drafts = new Map<string, string>()
  let composer = ''
  const savedImages: unknown[] = []
  const image = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const, name: 'clipboard.png' }
  const controller = new PromptController({
    ctx: {
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 1_000, maxImageBytes: 1_000 },
        validateImage: async () => {},
        saveImage: async (attachment: unknown) => {
          savedImages.push(attachment)
          return { id: `image-${String(savedImages.length)}` }
        },
      },
      llm: {
        resolveModelInfo: async () => ({ provider: 'provider', id: 'model', inputModalities }),
      },
    } as never,
    ui: {
      getComposerText: () => composer,
      setComposerText: (text: string) => { composer = text },
      appendNotice: () => {},
      setStatus: () => {},
      flashError: () => {},
    } as never,
    draftStore: {
      load: async sessionId => drafts.get(sessionId),
      save: async (sessionId, text) => {
        if (text === '') drafts.delete(sessionId)
        else drafts.set(sessionId, text)
      },
      delete: async sessionId => { drafts.delete(sessionId) },
      flush: async () => {},
    },
    getAgent: () => ({ id: 'session-1' }) as never,
    getSelection: () => ({ current: { provider: 'provider', model: 'model' }, assembled: undefined }),
    isClosing: () => false,
    readClipboardImage: async () => image,
  })
  return {
    controller,
    drafts,
    image,
    savedImages,
    setComposer: (text: string) => { composer = text },
    getComposer: () => composer,
  }
}

test('admits pending images only for the current model and clears them after successful submission', async () => {
  const textOnly = controllerFor(['text'])
  await textOnly.controller.pasteClipboardImage()
  assert.equal(textOnly.controller.hasPendingImages(), true)
  await textOnly.controller.beginPrompt('describe this')
  await assert.rejects(textOnly.controller.promptMessage('describe this'), /does not accept image input/)
  assert.equal(textOnly.controller.hasPendingImages(), true)

  const vision = controllerFor(['text', 'image'])
  await vision.controller.pasteClipboardImage()
  const sessionId = await vision.controller.beginPrompt('describe this')
  const prepared = await vision.controller.promptMessage('describe this')
  assert.equal(sessionId, 'session-1')
  assert.deepEqual(prepared.content.map(block => block.type), ['text', 'image'])
  assert.equal(vision.savedImages.length, 1)

  await vision.controller.completePrompt(sessionId)
  assert.equal(vision.controller.hasPendingImages(), false)
  assert.equal(vision.drafts.has('session-1'), false)
})

test('restores a failed submitted prompt ahead of newer composer text', async () => {
  const subject = controllerFor(['text'])
  const sessionId = await subject.controller.beginPrompt('first')
  subject.setComposer('typed while submitting')

  await subject.controller.recoverPrompt(sessionId, 'first')

  assert.equal(subject.getComposer(), 'first\ntyped while submitting')
  assert.equal(subject.drafts.get('session-1'), 'first\ntyped while submitting')
})
