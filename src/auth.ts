import { Context } from '@deepseek-ai/cordis'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { ReadStream, WriteStream } from 'node:tty'
import { createInterface } from 'node:readline/promises'

export const DEEPSEEK_API_KEY_REF = credentialRef('DEEPSEEK_API_KEY')

export interface CredentialService {
  describe(ref: typeof DEEPSEEK_API_KEY_REF): Promise<CredentialInfo>
  set(ref: typeof DEEPSEEK_API_KEY_REF, value: string): Promise<void>
  unset(ref: typeof DEEPSEEK_API_KEY_REF): Promise<void>
}

export interface OpenCredentialServiceResult {
  credentials: CredentialService
  close(): Promise<void>
}

export async function openOfficialCredentialService(): Promise<OpenCredentialServiceResult> {
  const root = new Context()
  root.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('deepseek'))
  await root.plugin(LocalCredentialProvider, { watch: false })
  const credentials = root.get('credentials')
  if (credentials === undefined) {
    await root.fiber.dispose()
    throw new Error('deepseek: the official Harness credential service did not start')
  }
  return {
    credentials,
    close: async () => { await root.fiber.dispose() },
  }
}

export async function readMaskedSecret(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('deepseek auth requires an interactive terminal so the API key can be entered without echoing it')
  }

  output.write('DeepSeek API key: ')
  const wasRaw = input.isRaw
  input.setRawMode(true)
  input.resume()

  return await new Promise<string>((resolve, reject) => {
    let secret = ''
    const cleanup = () => {
      input.off('data', onData)
      input.setRawMode(Boolean(wasRaw))
      input.pause()
    }
    const finish = (error?: Error) => {
      cleanup()
      output.write('\n')
      if (error !== undefined) reject(error)
      else resolve(secret)
    }
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u0003') return finish(new Error('authentication cancelled'))
        if (character === '\u007f' || character === '\b') {
          if (secret.length > 0) {
            secret = secret.slice(0, -1)
            output.write('\b \b')
          }
          continue
        }
        if (character >= ' ') {
          secret += character
          output.write('*')
        }
      }
    }
    input.on('data', onData)
  })
}

export async function confirmCredentialLogout(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
  if (!(input as { isTTY?: boolean }).isTTY || !(output as { isTTY?: boolean }).isTTY) {
    throw new Error('deepseek auth logout requires an interactive terminal for confirmation')
  }
  const prompt = createInterface({ input, output, terminal: true })
  try {
    const answer = await prompt.question('Remove the stored DeepSeek API key? [y/N] ')
    return answer.trim().toLocaleLowerCase() === 'y' || answer.trim().toLocaleLowerCase() === 'yes'
  } finally {
    prompt.close()
  }
}

export function describeCredential(info: CredentialInfo): string {
  if (!info.configured) return 'Not authenticated. Run `deepseek auth` to store a DeepSeek API key.'
  if (!info.writable) {
    return `Authenticated from ${info.source ?? 'the launch environment'} (read-only). Unset DEEPSEEK_API_KEY in that environment to manage the stored credential.`
  }
  return `Authenticated from ${info.source ?? 'the official Harness credential store'}.`
}
