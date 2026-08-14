import test from 'node:test'
import assert from 'node:assert/strict'
import { runLauncher, type LauncherDependencies } from '../src/launcher.js'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials'

function fixture(info: CredentialInfo = { configured: false, writable: true }) {
  const calls: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  let manifest = {
    name: 'fixture',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }
  const credentials = {
    describe: async () => info,
    set: async (_ref: unknown, value: string) => { calls.push(`set:${value}`) },
    unset: async () => { calls.push('unset') },
  }
  const deps: LauncherDependencies = {
    version: '0.1.0',
    stdout: text => { stdout.push(text) },
    stderr: text => { stderr.push(text) },
    resolveProfileDir: () => '/fake/profiles/tui',
    initProfile: (_path, bundles) => { calls.push(`init:${bundles.join(',')}`) },
    healProfileModules: () => { calls.push('heal-modules') },
    readProfileManifest: () => manifest,
    writeProfileManifest: (_path, next) => {
      manifest = next as typeof manifest
      calls.push('write-profile')
    },
    openCredentials: async () => ({
      credentials,
      close: async () => { calls.push('close') },
    }),
    readSecret: async () => 'sk-secret',
    confirmLogout: async () => true,
    runDsh: async args => { calls.push(`dsh:${args.join('|')}`); return 7 },
  }
  return { calls, deps, stdout, stderr, credentials, get manifest() { return manifest } }
}

test('help and version never initialize a profile or open credentials', async () => {
  for (const argument of ['--help', '--version']) {
    const subject = fixture()
    assert.equal(await runLauncher(['--cwd', '.', argument], subject.deps), 0)
    assert.deepEqual(subject.calls, [])
  }
})

test('ordinary arguments initialize the tui bundle and forward verbatim', async () => {
  const subject = fixture()
  assert.equal(await runLauncher(['--resume', 'session-7', 'hello world'], subject.deps), 7)
  assert.deepEqual(subject.calls, [
    'init:@deepseek-ai/dsh-base,@chalk/dsh-tui',
    'heal-modules',
    'write-profile',
    'dsh:--resume|session-7|hello world',
  ])
  assert.deepEqual(subject.manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@chalk/dsh-tui',
  ])
})

test('repairs a profile missing the official base without disturbing other bundles', async () => {
  const subject = fixture()
  subject.manifest.dsh.profile.bundles = ['third-party', '@chalk/dsh-tui']
  await runLauncher([], subject.deps)
  assert.deepEqual(subject.manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    'third-party',
    '@chalk/dsh-tui',
  ])
})

test('normalizes the tui profile to base first and the TUI bundle last', async () => {
  const subject = fixture()
  subject.manifest.dsh.profile.bundles = ['@chalk/dsh-tui', 'third-party', '@deepseek-ai/dsh-base']
  await runLauncher([], subject.deps)
  assert.deepEqual(subject.manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    'third-party',
    '@chalk/dsh-tui',
  ])
})

test('auth stores the masked-reader result through the credential service without printing it', async () => {
  const subject = fixture()
  assert.equal(await runLauncher(['auth'], subject.deps), 0)
  assert.deepEqual(subject.calls, ['set:sk-secret', 'close'])
  assert.doesNotMatch(subject.stdout.join('') + subject.stderr.join(''), /sk-secret/)
})

test('auth status reports an environment-backed credential as read-only', async () => {
  const subject = fixture({ configured: true, source: 'env', writable: false })
  assert.equal(await runLauncher(['auth', 'status'], subject.deps), 0)
  assert.match(subject.stdout.join(''), /env \(read-only\)/)
  assert.deepEqual(subject.calls, ['close'])
})

test('auth logout refuses to pretend it removed an environment-backed credential', async () => {
  const subject = fixture({ configured: true, source: 'env', writable: false })
  assert.equal(await runLauncher(['auth', 'logout'], subject.deps), 1)
  assert.match(subject.stderr.join(''), /Unset DEEPSEEK_API_KEY/)
  assert.deepEqual(subject.calls, ['close'])
})

test('auth logout uses the official credential service for writable storage', async () => {
  const subject = fixture({ configured: true, source: 'file', writable: true })
  assert.equal(await runLauncher(['auth', 'logout'], subject.deps), 0)
  assert.deepEqual(subject.calls, ['unset', 'close'])
})

test('auth logout keeps the credential when confirmation is declined', async () => {
  const subject = fixture({ configured: true, source: 'file', writable: true })
  subject.deps.confirmLogout = async () => false
  assert.equal(await runLauncher(['auth', 'logout'], subject.deps), 0)
  assert.deepEqual(subject.calls, ['close'])
  assert.match(subject.stdout.join(''), /unchanged/)
})

for (const source of ['project-env', 'user-env']) {
  test(`auth logout explains that ${source} cannot be deleted by the credential store`, async () => {
    const subject = fixture({ configured: true, source, writable: true })
    assert.equal(await runLauncher(['auth', 'logout'], subject.deps), 1)
    assert.deepEqual(subject.calls, ['close'])
    assert.match(subject.stderr.join(''), new RegExp(source))
  })
}
