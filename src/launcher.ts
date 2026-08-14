import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  healProfilesModuleFallback,
  initProfile,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import {
  DEEPSEEK_API_KEY_REF,
  describeCredential,
  confirmCredentialLogout,
  openOfficialCredentialService,
  readMaskedSecret,
  type OpenCredentialServiceResult,
} from './auth.js'

const PROFILE = 'tui'
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const TUI_BUNDLE = '@chalk/dsh-tui'

export const HELP = `Usage: deepseek [options] [initial-prompt...]
       deepseek auth [status|logout]

Run the official DeepSeek Harness with the standalone terminal UI.

Options:
  -r, --resume <id>        resume a persisted session
  -C, --cwd <directory>    set the working directory for a new session
  -p, --prompt <words...>  submit an initial prompt after startup
  -h, --help               show this help without changing Harness state
  -V, --version            output the launcher version without changing Harness state

All other arguments are forwarded unchanged to the official Harness tui profile.
`

export interface LauncherDependencies {
  version: string
  stdout(text: string): void
  stderr(text: string): void
  resolveProfileDir(): string
  initProfile(path: string, bundles: string[]): void
  healProfileModules(): void
  readProfileManifest(path: string): ProfileManifest
  writeProfileManifest(path: string, manifest: ProfileManifest): void
  openCredentials(): Promise<OpenCredentialServiceResult>
  readSecret(): Promise<string>
  confirmLogout(): Promise<boolean>
  runDsh(args: string[]): Promise<number>
}

export function ensureTuiProfile(deps: LauncherDependencies): void {
  const dir = deps.resolveProfileDir()
  deps.initProfile(dir, [BASE_BUNDLE, TUI_BUNDLE])
  deps.healProfileModules()
  const manifest = deps.readProfileManifest(dir)
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`deepseek: invalid tui profile manifest at ${join(dir, 'package.json')}`)
  const nextBundles = [
    BASE_BUNDLE,
    ...bundles.filter(bundle => bundle !== BASE_BUNDLE && bundle !== TUI_BUNDLE),
    TUI_BUNDLE,
  ]
  const needsWrite = nextBundles.length !== bundles.length
    || nextBundles.some((bundle, index) => bundle !== bundles[index])
  if (needsWrite) {
    deps.writeProfileManifest(dir, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: { ...manifest.dsh?.profile, bundles: nextBundles },
      },
    })
  }
}

async function runAuth(action: string | undefined, deps: LauncherDependencies): Promise<number> {
  if (action !== undefined && action !== 'status' && action !== 'logout') {
    deps.stderr(`deepseek: unknown auth command ${JSON.stringify(action)}\n`)
    return 2
  }
  const opened = await deps.openCredentials()
  try {
    const info = await opened.credentials.describe(DEEPSEEK_API_KEY_REF)
    if (action === 'status') {
      deps.stdout(`${describeCredential(info)}\n`)
      return info.configured ? 0 : 1
    }
    if (action === 'logout') {
      if (!info.configured) {
        deps.stdout('No stored DeepSeek API key is configured.\n')
        return 0
      }
      if (!info.writable) {
        deps.stderr(`${describeCredential(info)}\n`)
        return 1
      }
      if (info.source === 'project-env' || info.source === 'user-env') {
        deps.stderr(`DeepSeek API key is supplied by ${info.source}. Remove it from that .env file; the Harness credential store cannot delete it.\n`)
        return 1
      }
      if (!await deps.confirmLogout()) {
        deps.stdout('Stored DeepSeek API key unchanged.\n')
        return 0
      }
      await opened.credentials.unset(DEEPSEEK_API_KEY_REF)
      deps.stdout('Stored DeepSeek API key removed.\n')
      return 0
    }
    if (!info.writable) {
      deps.stderr(`${describeCredential(info)}\n`)
      return 1
    }
    const secret = await deps.readSecret()
    if (secret.length === 0) {
      deps.stderr('deepseek: no API key entered; credential unchanged\n')
      return 1
    }
    await opened.credentials.set(DEEPSEEK_API_KEY_REF, secret)
    deps.stdout('DeepSeek API key stored by the official Harness credential service.\n')
    return 0
  } finally {
    await opened.close()
  }
}

export async function runLauncher(argv: string[], deps: LauncherDependencies): Promise<number> {
  const optionArgs = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--'))
  if (optionArgs.includes('--help') || optionArgs.includes('-h')) {
    deps.stdout(HELP)
    return 0
  }
  if (optionArgs.includes('--version') || optionArgs.includes('-V')) {
    deps.stdout(`${deps.version}\n`)
    return 0
  }
  if (argv[0] === 'auth') {
    if (argv.length > 2) {
      deps.stderr('deepseek: auth accepts only `status` or `logout`\n')
      return 2
    }
    return await runAuth(argv[1], deps)
  }
  ensureTuiProfile(deps)
  return await deps.runDsh(argv)
}

function packageManifestPath(): string {
  const candidates = [
    new URL('../package.json', import.meta.url),
    new URL('../../package.json', import.meta.url),
  ]
  const path = candidates.find(candidate => existsSync(candidate))
  if (path === undefined) throw new Error('deepseek: cannot locate the launcher package manifest')
  return fileURLToPath(path)
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(packageManifestPath(), 'utf8')) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

export function runOfficialDsh(args: string[]): Promise<number> {
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = join(dirname(packagePath), 'lib', 'bin.js')
  const child = spawn(process.execPath, [bin, '--profile', PROFILE, ...args], { stdio: 'inherit' })
  const forwarded = (['SIGINT', 'SIGTERM'] as const).map(signal => {
    const handler = () => { child.kill(signal) }
    process.on(signal, handler)
    return [signal, handler] as const
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      for (const [name, handler] of forwarded) process.off(name, handler)
      if (code !== null) return resolve(code)
      const number = signal === null ? undefined : constants.signals[signal]
      resolve(number === undefined ? 1 : 128 + number)
    })
  })
}

export function productionDependencies(): LauncherDependencies {
  return {
    version: packageVersion(),
    stdout: text => { process.stdout.write(text) },
    stderr: text => { process.stderr.write(text) },
    resolveProfileDir: () => resolveProfileDir(PROFILE),
    initProfile,
    healProfileModules: () => { healProfilesModuleFallback(packageManifestPath()) },
    readProfileManifest: dir => readProfileManifest('deepseek', dir),
    writeProfileManifest,
    openCredentials: openOfficialCredentialService,
    readSecret: readMaskedSecret,
    confirmLogout: confirmCredentialLogout,
    runDsh: runOfficialDsh,
  }
}
