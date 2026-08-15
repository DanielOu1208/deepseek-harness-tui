import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsController } from '../src/settings-controller.js'

const imageMessage = {
  content: [{ type: 'image', attachment: {} }],
}

function controllerFor(options: {
  history?: object[]
  nextStep?: object[]
  nextTurn?: object[]
  inputModalities: readonly ('text' | 'image')[]
  hasPendingImages?: boolean
}) {
  const selection = { current: { provider: 'vision', model: 'current' }, assembled: undefined }
  const notices: string[] = []
  let contextWindow: number | undefined
  const agent = {
    session: {
      events: [],
      deriveMessages: () => options.history ?? [],
    },
    inbox: {
      nextStep: options.nextStep ?? [],
      nextTurn: options.nextTurn ?? [],
    },
  }
  const controller = new SettingsController({
    ctx: {
      llm: {
        resolveModelInfo: async (provider: string, model: string) => ({
          provider,
          id: model,
          name: model,
          inputModalities: options.inputModalities,
          context: { contextWindow: 64_000 },
        }),
      },
    } as never,
    ui: { appendNotice: (notice: string) => notices.push(notice) } as never,
    getAgent: () => agent as never,
    getSelection: () => selection as never,
    setSelectedContextWindow: value => { contextWindow = value },
    runHarnessCommand: async () => {},
    refresh: () => {},
    isClosing: () => false,
    hasPendingImages: () => options.hasPendingImages ?? false,
  })
  return { controller, selection, notices, getContextWindow: () => contextWindow }
}

test('rejects a text-only model when durable session history contains an image', async () => {
  const { controller, selection } = controllerFor({
    history: [imageMessage],
    inputModalities: ['text'],
  })

  await assert.rejects(controller.selectModel('text/moderate'), /does not accept images/)

  assert.deepEqual(selection.current, { provider: 'vision', model: 'current' })
})

test('rejects a text-only model when either queued boundary contains an image', async () => {
  for (const queued of [
    { nextStep: [imageMessage] },
    { nextTurn: [imageMessage] },
  ]) {
    const { controller, selection } = controllerFor({
      ...queued,
      inputModalities: ['text'],
    })

    await assert.rejects(controller.selectModel('text/moderate'), /does not accept images/)
    assert.deepEqual(selection.current, { provider: 'vision', model: 'current' })
  }
})

test('rejects a text-only model when an unsent pending image is attached', async () => {
  const { controller, selection } = controllerFor({
    inputModalities: ['text'],
    hasPendingImages: true,
  })

  await assert.rejects(controller.selectModel('text/moderate'), /does not accept images/)

  assert.deepEqual(selection.current, { provider: 'vision', model: 'current' })
})

test('commits a model that accepts images when image input is present', async () => {
  const { controller, selection, notices, getContextWindow } = controllerFor({
    history: [imageMessage],
    nextTurn: [imageMessage],
    inputModalities: ['text', 'image'],
  })

  await controller.selectModel('vision/compatible')

  assert.deepEqual(selection.current, { provider: 'vision', model: 'compatible' })
  assert.equal(getContextWindow(), 64_000)
  assert.match(notices.at(-1) ?? '', /vision\/compatible/)
})
