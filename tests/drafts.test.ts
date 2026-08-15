import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionDraftStore, sessionDraftFileName } from '../src/drafts.js'

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-drafts-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('saves, loads, flushes, and deletes one text draft per session', async () => {
  await withTempRoot(async root => {
    const store = new SessionDraftStore(join(root, 'drafts'))

    await store.save('session-one', 'finish the parser')
    assert.equal(await store.load('session-one'), 'finish the parser')
    assert.equal(await store.load('session-two'), undefined)

    await store.save('session-one', '')
    await store.flush()
    assert.equal(await store.load('session-one'), undefined)
  })
})

test('serializes same-session saves so the latest requested text wins', async () => {
  await withTempRoot(async root => {
    const store = new SessionDraftStore(root)
    const first = store.save('session-one', 'first')
    const second = store.save('session-one', 'second')
    const third = store.save('session-one', 'third')

    await store.flush('session-one')
    await Promise.all([first, second, third])
    assert.equal(await store.load('session-one'), 'third')

    await Promise.all([
      store.save('session-one', 'kept'),
      store.save('session-one', ''),
    ])
    assert.equal(await store.load('session-one'), undefined)
  })
})

test('writes owner-private versioned JSON atomically', async () => {
  await withTempRoot(async root => {
    const storeRoot = join(root, 'drafts')
    const store = new SessionDraftStore(storeRoot)
    await store.save('session-one', 'atomic')

    const entries = await readdir(storeRoot)
    assert.deepEqual(entries, [sessionDraftFileName('session-one')])
    const file = join(storeRoot, entries[0] ?? '')
    const metadata = await lstat(file)
    assert.equal(metadata.isFile(), true)
    assert.equal(metadata.mode & 0o777, 0o600)
    const rootMetadata = await lstat(storeRoot)
    assert.equal(rootMetadata.mode & 0o777, 0o700)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      owner: '@chalk/dsh-tui',
      version: 1,
      sessionId: 'session-one',
      text: 'atomic',
    })
  })
})

test('rejects malformed, mismatched, and symlink-backed files without escaping root', async () => {
  await withTempRoot(async root => {
    const store = new SessionDraftStore(root)
    const malformedPath = join(root, sessionDraftFileName('malformed'))
    await writeFile(malformedPath, '{not-json', { mode: 0o600 })
    assert.equal(await store.load('malformed'), undefined)

    const mismatchedPath = join(root, sessionDraftFileName('mismatched'))
    await writeFile(mismatchedPath, JSON.stringify({
      owner: '@chalk/dsh-tui', version: 1, sessionId: 'another-session', text: 'do not load',
    }), { mode: 0o600 })
    assert.equal(await store.load('mismatched'), undefined)

    const outside = join(root, '..', 'dsh-tui-draft-secret')
    await writeFile(outside, 'outside-root', { mode: 0o600 })
    const linkedPath = join(root, sessionDraftFileName('linked'))
    await symlink(outside, linkedPath)
    assert.equal(await store.load('linked'), undefined)

    await store.save('../escape/session', 'still inside')
    assert.equal(await store.load('../escape/session'), 'still inside')
    assert.equal((await readdir(root)).includes('escape'), false)
    await rm(outside, { force: true })
  })
})

test('delete is idempotent and does not create a missing root', async () => {
  await withTempRoot(async root => {
    const missingRoot = join(root, 'not-created')
    const store = new SessionDraftStore(missingRoot)
    await store.delete('session-one')
    await store.flush()
    await assert.rejects(lstat(missingRoot), { code: 'ENOENT' })
  })
})
