import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SESSION_EXPORT_DISCLOSURE,
  createSessionExport,
  defaultSessionExportFilename,
  renderSessionExportJson,
  renderSessionExportMarkdown,
  writeSessionExport,
  type SessionExportInput,
} from '../src/export.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function fixture(): SessionExportInput {
  const events = [
    {
      seq: 0,
      time: 1,
      type: 'user/message',
      surfaceOp: 'append',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please inspect the workspace.' }] },
    },
    {
      seq: 1,
      time: 2,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] } },
    },
  ] as unknown as SessionEvent[]
  return {
    header: {
      version: 0,
      id: SessionId('session-1'),
      createdAt: 1_700_000_000_000,
      cwd: '/tmp/workspace',
      agentPreset: 'standard',
    },
    events,
    projections: {
      transcript: {
        entries: [
          { role: 'user', kind: 'text', text: 'Please inspect the workspace.' },
          { role: 'assistant', kind: 'text', text: 'I will inspect it.', detail: 'done' },
        ],
      },
    },
  }
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
  temporaryRoots.push(path)
  return path
}

test('creates a parseable version-1 envelope with the supplied event count', () => {
  const output = renderSessionExportJson(fixture())
  const parsed = JSON.parse(output) as {
    version: number
    disclosure: string
    session: { events: unknown[]; header: { id: string }; projections: unknown }
  }

  assert.equal(parsed.version, 1)
  assert.equal(parsed.disclosure, SESSION_EXPORT_DISCLOSURE)
  assert.equal(parsed.session.header.id, 'session-1')
  assert.equal(parsed.session.events.length, 2)
  assert.deepEqual(parsed.session.projections, fixture().projections)
})

test('omits attachment bytes and encoded payloads while preserving reference metadata', () => {
  const input = fixture()
  input.events[0] = {
    seq: 0,
    time: 1,
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      source: { kind: 'user' },
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'image-1',
          mediaType: 'image/png',
          bytes: 12,
          width: 2,
          height: 2,
          name: 'diagram.png',
        },
        data: new Uint8Array([1, 2, 3]),
        base64: 'AQID',
      }],
    },
  } as unknown as SessionEvent

  const envelope = createSessionExport(input)
  const image = (envelope.session.events[0] as { data: { content: Array<Record<string, unknown>> } }).data.content[0]!
  assert.deepEqual(image.attachment, {
    attachmentId: 'image-1',
    bytes: 12,
    height: 2,
    mediaType: 'image/png',
    name: 'diagram.png',
    width: 2,
  })
  assert.equal('data' in image, false)
  assert.equal('base64' in image, false)
})

test('preserves similarly named plugin data outside an exact image attachment shape', () => {
  const input = fixture()
  input.events[0] = {
    seq: 0,
    time: 1,
    type: 'plugin/custom',
    data: {
      attachmentId: 'plugin-record-id',
      imageLabel: 'preview',
      data: 'must-keep',
      base64: 'plugin-value',
      nested: { attachmentNote: 'keep', data: ['also', 'keep'] },
    },
  } as unknown as SessionEvent

  const envelope = createSessionExport(input)
  const data = (envelope.session.events[0] as { data: unknown }).data
  assert.deepEqual(data, {
    attachmentId: 'plugin-record-id',
    base64: 'plugin-value',
    data: 'must-keep',
    imageLabel: 'preview',
    nested: { attachmentNote: 'keep', data: ['also', 'keep'] },
  })
})

test('omits encoded payloads from plugin-style image records', () => {
  const input = fixture()
  input.events[0] = {
    seq: 0,
    time: 1,
    type: 'plugin/custom',
    data: {
      content: [{
        type: 'image',
        mimeType: 'image/png',
        name: 'preview.png',
        data: 'VERY_SECRET_BASE64',
        previewUrl: 'data:image/png;base64,ALSO_SECRET',
      }],
    },
  } as unknown as SessionEvent

  const envelope = createSessionExport(input)
  const image = (envelope.session.events[0] as { data: { content: Array<Record<string, unknown>> } }).data.content[0]!
  assert.deepEqual(image, {
    mimeType: 'image/png',
    name: 'preview.png',
    type: 'image',
  })
})

test('renders deterministic Markdown from projections and events', () => {
  const input = fixture()
  const first = renderSessionExportMarkdown(input)
  const second = renderSessionExportMarkdown(input)

  assert.equal(first, second)
  assert.match(first, /^# DeepSeek Harness Session Export/m)
  assert.match(first, /> Exports can contain prompts, tool output, and local paths\./)
  assert.match(first, /## Projection: transcript/)
  assert.match(first, /### 1 · user · text/)
  assert.match(first, /## Event log/)
  assert.match(first, /Events: 2/)
})

test('renders untrusted session metadata in bounded Markdown code spans', () => {
  const original = fixture()
  const input = {
    ...original,
    header: {
      ...original.header,
      id: SessionId('session-`unsafe`'),
      cwd: 'C:\\work\\`backticks`',
    },
  }

  const output = renderSessionExportMarkdown(input)

  assert.ok(output.includes('- Session: `` session-`unsafe` ``'))
  assert.ok(output.includes('- Working directory: `` C:\\work\\`backticks` ``'))
})

test('sanitizes default filenames to one safe basename', () => {
  const filename = defaultSessionExportFilename({ id: SessionId('../../escape\\name\n'), createdAt: 0 }, 'markdown')

  assert.equal(filename, 'session-escape-name-19700101T000000Z.markdown')
  assert.equal(filename, filename.split(/[\\/]/u).pop())
  assert.doesNotMatch(filename, /[\u0000\r\n\\/]/u)
  assert.equal(filename.startsWith('.'), false)
})

test('writes owner-private output atomically and refuses overwrite by default', async () => {
  const root = await tempRoot()
  const destination = join(root, 'session.json')
  const input = fixture()

  const result = await writeSessionExport(input, destination)
  assert.equal(result.path, resolve(destination))
  assert.equal(result.format, 'json')
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600)
  const original = await readFile(destination, 'utf8')

  await assert.rejects(writeSessionExport({ ...input, projections: { changed: true } }, destination), /EEXIST/)
  assert.equal(await readFile(destination, 'utf8'), original)
  assert.deepEqual((await readdir(root)).sort(), ['session.json'])

  await writeSessionExport({ ...input, projections: { changed: true } }, destination, { overwrite: true })
  assert.match(await readFile(destination, 'utf8'), /"changed": true/)
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600)
})

test('leaves no destination or temporary artifact after cancellation or staging failure', async () => {
  const root = await tempRoot()
  const destination = join(root, 'cancelled.json')
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(writeSessionExport(fixture(), destination, { signal: controller.signal }), /aborted/i)
  assert.equal((await readdir(root)).length, 0)

  const failingDestination = join(root, 'directory-target')
  await mkdir(failingDestination)
  await assert.rejects(writeSessionExport(fixture(), failingDestination), /EEXIST|directory/i)
  assert.deepEqual((await readdir(root)).sort(), ['directory-target'])
})
