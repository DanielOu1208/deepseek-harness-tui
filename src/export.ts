import { randomBytes } from 'node:crypto'
import { chmod, link, open, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Version of the TUI-owned, portable session export envelope. */
export const SESSION_EXPORT_VERSION = 1 as const

/**
 * Disclosure shown in every export. Session content is user-controlled and may
 * contain sensitive workspace information even though attachment bytes are not
 * copied into the export.
 */
export const SESSION_EXPORT_DISCLOSURE = 'Exports can contain prompts, tool output, and local paths.'

export type SessionExportFormat = 'json' | 'markdown'

export type SessionExportJsonValue =
  | null
  | boolean
  | number
  | string
  | SessionExportJsonValue[]
  | { readonly [key: string]: SessionExportJsonValue }

/** Caller-owned inputs; persistence flushing and reading remain outside this module. */
export interface SessionExportInput {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  /** One projection object, or a named map/array of projection snapshots. */
  readonly projections?: unknown
}

export interface SessionExportEnvelope {
  readonly format: 'deepseek-harness-session-export'
  readonly version: typeof SESSION_EXPORT_VERSION
  readonly disclosure: typeof SESSION_EXPORT_DISCLOSURE
  readonly session: {
    readonly header: SessionExportJsonValue
    readonly events: readonly SessionExportJsonValue[]
    readonly projections: SessionExportJsonValue
  }
}

export interface WriteSessionExportOptions {
  readonly format?: SessionExportFormat
  /** Refuse an existing destination unless this is explicitly true. */
  readonly overwrite?: boolean
  readonly signal?: AbortSignal
}

export interface WrittenSessionExport {
  readonly path: string
  readonly format: SessionExportFormat
  readonly bytes: number
}

const OMIT = Symbol('omit-export-value')
const BYTE_KEY = /^(?:base64|base64data|encoded(?:bytes|data)?|rawbytes|attachmentbytes|imagebytes)$/iu

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? abortError()
}

function isBinary(value: unknown): boolean {
  return value instanceof Uint8Array
    || value instanceof ArrayBuffer
    || (typeof DataView !== 'undefined' && value instanceof DataView)
}

function isImageAttachmentRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.attachmentId === 'string'
    && (record.mediaType === 'image/png'
      || record.mediaType === 'image/jpeg'
      || record.mediaType === 'image/webp'
      || record.mediaType === 'image/gif')
    && Number.isInteger(record.bytes) && Number(record.bytes) >= 0
    && Number.isInteger(record.width) && Number(record.width) > 0
    && Number.isInteger(record.height) && Number(record.height) > 0
}

function hasImageMediaType(record: Record<string, unknown>): boolean {
  const mediaType = record.mediaType ?? record.mimeType ?? record.media_type ?? record.mime_type
  return typeof mediaType === 'string' && mediaType.toLowerCase().startsWith('image/')
}

function isAttachmentObject(record: Record<string, unknown>): boolean {
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : undefined
  return isImageAttachmentRef(record)
    || (type === 'image' && isImageAttachmentRef(record.attachment))
    || isImageAttachmentRef(record.ref)
    || type === 'image'
    || type === 'image_url'
    || type === 'input_image'
    || 'image_url' in record
    || 'imageUrl' in record
    || (hasImageMediaType(record) && ('data' in record || 'base64' in record))
}

function isByteField(key: string, value: unknown, attachmentContext: boolean): boolean {
  if (isBinary(value)) return true
  const normalized = key.toLowerCase()
  if (typeof value === 'string' && /^data:image\//iu.test(value)) return true
  if (!attachmentContext) return false
  if (BYTE_KEY.test(normalized)) return true
  if (normalized === 'data' && attachmentContext && (typeof value === 'string' || Array.isArray(value))) return true
  if (normalized === 'bytes' && attachmentContext && typeof value !== 'number') return true
  return false
}

function plainObject(value: object): Record<string, unknown> {
  return value as Record<string, unknown>
}

/**
 * Clone into canonical, lossless JSON while omitting recognized image payloads.
 * Ref metadata (attachmentId, mediaType, dimensions, byte count, and name) is
 * retained. Object keys are sorted so all renderers receive deterministic data.
 */
function sanitizeValue(
  value: unknown,
  signal: AbortSignal | undefined,
  seen: WeakSet<object>,
  attachmentContext = false,
  visits: { count: number } = { count: 0 },
): SessionExportJsonValue | typeof OMIT | undefined {
  visits.count += 1
  if ((visits.count & 63) === 0) checkAborted(signal)

  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('Export values must contain finite JSON numbers')
    return value
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('Export values must be JSON-compatible')
  }
  if (isBinary(value)) return OMIT
  if (typeof value !== 'object') throw new TypeError('Export values must be JSON-compatible')
  if (seen.has(value)) throw new TypeError('Export values cannot contain cycles')
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      const output: SessionExportJsonValue[] = []
      for (const item of value) {
        checkAborted(signal)
        const next = sanitizeValue(item, signal, seen, attachmentContext, visits)
        output.push(next === OMIT || next === undefined ? null : next)
      }
      return output
    }

    const record = plainObject(value)
    const currentAttachmentContext = attachmentContext || isAttachmentObject(record)
    const output: Record<string, SessionExportJsonValue> = {}
    for (const key of Object.keys(record).sort()) {
      checkAborted(signal)
      const candidate = record[key]
      if (isByteField(key, candidate, currentAttachmentContext)) continue
      const next = sanitizeValue(candidate, signal, seen, currentAttachmentContext, visits)
      if (next !== OMIT && next !== undefined) output[key] = next
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function sanitizeRoot(value: unknown, signal: AbortSignal | undefined): SessionExportJsonValue {
  const result = sanitizeValue(value, signal, new WeakSet<object>())
  if (result === OMIT || result === undefined) return null
  return result
}

/** Build a detached version-1 envelope without contacting persistence. */
export function createSessionExport(input: SessionExportInput, signal?: AbortSignal): SessionExportEnvelope {
  checkAborted(signal)
  const header = sanitizeRoot(input.header, signal)
  checkAborted(signal)
  const events: SessionExportJsonValue[] = []
  for (const event of input.events) {
    checkAborted(signal)
    events.push(sanitizeRoot(event, signal))
  }
  checkAborted(signal)
  const projections = sanitizeRoot(input.projections ?? {}, signal)
  checkAborted(signal)
  return {
    format: 'deepseek-harness-session-export',
    version: SESSION_EXPORT_VERSION,
    disclosure: SESSION_EXPORT_DISCLOSURE,
    session: { header, events, projections },
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Render the detached envelope as stable, human-readable JSON. */
export function renderSessionExportJson(input: SessionExportInput, signal?: AbortSignal): string {
  return `${canonicalJson(createSessionExport(input, signal))}\n`
}

function markdownInline(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').trim()
}

function markdownFence(value: string): string {
  const longest = Math.max(0, ...value.match(/`+/gu)?.map(match => match.length) ?? [])
  return '`'.repeat(Math.max(3, longest + 1))
}

function markdownCode(value: unknown, fallback: string): string {
  const text = markdownInline(value) || fallback
  const longest = Math.max(0, ...text.match(/`+/gu)?.map(match => match.length) ?? [])
  const fence = '`'.repeat(longest + 1)
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${text}${padding}${fence}`
}

function projectionEntries(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entries = (value as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  return entries.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
}

function projectionSections(projections: SessionExportJsonValue): Array<{ name: string; value: SessionExportJsonValue }> {
  if (Array.isArray(projections)) return projections.map((value, index) => ({ name: `projection-${index + 1}`, value }))
  if (typeof projections !== 'object' || projections === null) return [{ name: 'projection', value: projections }]
  if (Array.isArray(projections.entries)) return [{ name: 'transcript', value: projections }]
  const keys = Object.keys(projections).sort()
  if (keys.length === 0) return []
  return keys.map(key => ({ name: key, value: projections[key]! }))
}

function renderProjection(name: string, value: SessionExportJsonValue, signal: AbortSignal | undefined): string[] {
  checkAborted(signal)
  const lines = [`## Projection: ${markdownInline(name)}`, '']
  const entries = projectionEntries(value)
  if (entries === undefined) {
    const fence = markdownFence(canonicalJson(value))
    lines.push(fence + 'json', canonicalJson(value), fence, '')
    return lines
  }
  if (entries.length === 0) {
    lines.push('_No entries._', '')
    return lines
  }
  entries.forEach((entry, index) => {
    checkAborted(signal)
    const role = markdownInline(entry.role) || 'entry'
    const kind = markdownInline(entry.kind)
    lines.push(`### ${String(index + 1)} · ${role}${kind === '' ? '' : ` · ${kind}`}`, '')
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (text !== '') lines.push(text, '')
    if (typeof entry.detail === 'string' && entry.detail !== '') {
      const fence = markdownFence(entry.detail)
      lines.push(fence, entry.detail, fence, '')
    }
  })
  return lines
}

/** Render a deterministic Markdown transcript plus a lossless event-log appendix. */
export function renderSessionExportMarkdown(input: SessionExportInput, signal?: AbortSignal): string {
  const envelope = createSessionExport(input, signal)
  const header = envelope.session.header
  const headerRecord = typeof header === 'object' && header !== null && !Array.isArray(header) ? header : undefined
  const sessionId = headerRecord?.id
  const cwd = headerRecord?.cwd
  const lines = [
    '# DeepSeek Harness Session Export',
    '',
    `> ${SESSION_EXPORT_DISCLOSURE}`,
    '',
    `- Session: ${markdownCode(sessionId, 'unknown')}`,
    `- Events: ${String(envelope.session.events.length)}`,
    ...(typeof cwd === 'string' && cwd !== '' ? [`- Working directory: ${markdownCode(cwd, 'unknown')}`] : []),
    '',
  ]

  for (const projection of projectionSections(envelope.session.projections)) {
    lines.push(...renderProjection(projection.name, projection.value, signal))
  }

  lines.push('## Event log', '')
  envelope.session.events.forEach((event, index) => {
    checkAborted(signal)
    const record = typeof event === 'object' && event !== null && !Array.isArray(event) ? event : {}
    const type = typeof record.type === 'string' ? record.type : 'unknown'
    const fence = markdownFence(canonicalJson(event))
    lines.push(`### ${String(index + 1)} · ${markdownInline(type)}`, '', fence + 'json', canonicalJson(event), fence, '')
  })
  return lines.join('\n')
}

function safeFilenamePart(value: unknown, fallback: string): string {
  const candidate = String(value ?? '').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.\-]+|[.\-]+$/gu, '').slice(0, 80)
  return candidate || fallback
}

/** Return a basename that cannot escape a caller-selected output directory. */
export function defaultSessionExportFilename(
  header: Pick<SessionHeader, 'id' | 'createdAt'>,
  format: SessionExportFormat = 'json',
): string {
  if (format !== 'json' && format !== 'markdown') throw new TypeError(`Unsupported export format: ${String(format)}`)
  const id = safeFilenamePart(header.id, 'session')
  const date = Number.isFinite(header.createdAt) ? new Date(header.createdAt) : undefined
  const created = date !== undefined && !Number.isNaN(date.getTime())
    ? date.toISOString().replace(/\.\d{3}Z$/u, 'Z').replace(/[-:]/gu, '')
    : 'unknown-time'
  return `session-${id}-${created}.${format}`
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Atomically write one export with mode 0600. A no-overwrite commit uses an
 * exclusive hard-link step, so a destination appearing after staging is still
 * never replaced. The temporary artifact is removed on every failed path.
 */
export async function writeSessionExport(
  input: SessionExportInput,
  destination: string,
  options: WriteSessionExportOptions = {},
): Promise<WrittenSessionExport> {
  const format = options.format ?? 'json'
  if (format !== 'json' && format !== 'markdown') throw new TypeError(`Unsupported export format: ${String(format)}`)
  const overwrite = options.overwrite === true
  const signal = options.signal
  checkAborted(signal)
  const content = format === 'json'
    ? renderSessionExportJson(input, signal)
    : renderSessionExportMarkdown(input, signal)
  checkAborted(signal)

  const target = resolve(destination)
  const temporary = `${target}.${randomBytes(12).toString('hex')}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let committed = false
  try {
    handle = await open(temporary, 'wx', 0o600)
    await chmod(temporary, 0o600)
    checkAborted(signal)
    await handle.writeFile(content, { encoding: 'utf8' })
    checkAborted(signal)
    await handle.sync()
    await handle.close()
    handle = undefined
    checkAborted(signal)

    if (overwrite) {
      await rename(temporary, target)
      committed = true
    } else {
      await link(temporary, target)
      committed = true
      await removeTemporary(temporary)
    }
    return { path: target, format, bytes: Buffer.byteLength(content, 'utf8') }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
    if (!committed || !overwrite) await removeTemporary(temporary)
  }
}
