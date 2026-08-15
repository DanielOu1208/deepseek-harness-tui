import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DRAFT_OWNER = '@chalk/dsh-tui'
const DRAFT_VERSION = 1
const DRAFT_FILE_PREFIX = 'dsh-tui-draft-v1-'
const DRAFT_FILE_SUFFIX = '.json'

interface PersistedDraft {
  readonly owner: typeof DRAFT_OWNER
  readonly version: typeof DRAFT_VERSION
  readonly sessionId: string
  readonly text: string
}

export interface SessionDraftStoreLike {
  load(sessionId: string): Promise<string | undefined>
  save(sessionId: string, text: string): Promise<void>
  delete(sessionId: string): Promise<void>
  flush(sessionId?: string): Promise<void>
}

/**
 * Return the private, path-safe filename used for one session's draft.
 *
 * A digest keeps arbitrary session IDs out of path syntax and bounds the
 * filename length. The payload stores the original ID as a collision guard.
 */
export function sessionDraftFileName(sessionId: string): string {
  const id = validateSessionId(sessionId)
  const digest = createHash('sha256').update(id, 'utf8').digest('hex')
  return `${DRAFT_FILE_PREFIX}${digest}${DRAFT_FILE_SUFFIX}`
}

/**
 * A small owner-private store for one text draft per session.
 *
 * The root is supplied by the caller so the store does not choose a global
 * location or mix its files with Harness session persistence.
 */
export class SessionDraftStore implements SessionDraftStoreLike {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly configuredRoot: string

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new TypeError('draft root directory must be a non-empty path')
    }
    this.configuredRoot = resolve(rootDir)
  }

  async load(sessionId: string): Promise<string | undefined> {
    const id = validateSessionId(sessionId)
    await this.flush(id)
    const root = await this.resolveRoot(false)
    if (root === undefined) return undefined

    const path = this.pathForSession(root, id)
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    // Never follow an object supplied at the store's filename. In particular,
    // a corrupt symlink must not turn a load into a read outside the root.
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined

    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    return parseDraft(raw, id)
  }

  async save(sessionId: string, text: string): Promise<void> {
    const id = validateSessionId(sessionId)
    if (typeof text !== 'string') throw new TypeError('draft text must be a string')
    if (text.length === 0) {
      await this.delete(id)
      return
    }
    await this.enqueue(id, async () => {
      const root = await this.resolveRoot(true)
      if (root === undefined) throw new Error('draft root is unavailable')
      await this.writeAtomically(this.pathForSession(root, id), {
        owner: DRAFT_OWNER,
        version: DRAFT_VERSION,
        sessionId: id,
        text,
      })
    })
  }

  async delete(sessionId: string): Promise<void> {
    const id = validateSessionId(sessionId)
    await this.enqueue(id, async () => {
      const root = await this.resolveRoot(false)
      if (root === undefined) return
      const path = this.pathForSession(root, id)
      try {
        await unlink(path)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    })
  }

  /** Wait for all queued mutations, or only one session's mutations. */
  async flush(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      const id = validateSessionId(sessionId)
      while (true) {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        await pending
        if (this.pending.get(id) === undefined) return
      }
    }

    while (this.pending.size > 0) {
      await Promise.all([...this.pending.values()])
    }
  }

  private async enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    let tracked: Promise<void>
    tracked = next.finally(() => {
      if (this.pending.get(sessionId) === tracked) this.pending.delete(sessionId)
    })
    this.pending.set(sessionId, tracked)
    await tracked
  }

  private async resolveRoot(create: boolean): Promise<string | undefined> {
    if (create) {
      await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 })
      await chmod(this.configuredRoot, 0o700)
    }
    let root: string
    try {
      root = await realpath(this.configuredRoot)
    } catch (error) {
      if (!create && isMissing(error)) return undefined
      throw error
    }
    const metadata = await lstat(root)
    if (!metadata.isDirectory()) {
      if (!create) return undefined
      throw new Error(`draft root is not a directory: ${this.configuredRoot}`)
    }
    return root
  }

  private pathForSession(root: string, sessionId: string): string {
    const path = resolve(root, sessionDraftFileName(sessionId))
    const escaped = relative(root, path)
    if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
      throw new Error('draft path escaped its root')
    }
    return path
  }

  private async writeAtomically(path: string, draft: PersistedDraft): Promise<void> {
    const temporary = join(
      resolve(path, '..'),
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const serialized = `${JSON.stringify(draft)}\n`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      )
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, path)
      await chmod(path, 0o600)
    } finally {
      if (handle !== undefined) await handle.close().catch(() => {})
      await unlink(temporary).catch(() => {})
    }
  }
}

export function createSessionDraftStore(rootDir: string): SessionDraftStore {
  return new SessionDraftStore(rootDir)
}

function parseDraft(raw: string, sessionId: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.owner !== DRAFT_OWNER || value.version !== DRAFT_VERSION) return undefined
  if (value.sessionId !== sessionId || typeof value.text !== 'string' || value.text.length === 0) {
    return undefined
  }
  return value.text
}

function validateSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')) {
    throw new TypeError('session ID must be a non-empty string without NUL bytes')
  }
  return sessionId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
