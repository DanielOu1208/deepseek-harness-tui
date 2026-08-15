import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'

const execFileAsync = promisify(execFile)

export interface ClipboardCommand {
  file: string
  args: string[]
  outputFile?: string
}

export type ClipboardCommandRunner = (
  command: ClipboardCommand,
  signal?: AbortSignal,
) => Promise<Uint8Array | undefined>

export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const ascii = (start: number, length: number): string => Buffer.from(data.subarray(start, start + length)).toString('ascii')
  if (data.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  return undefined
}

async function defaultRunner(command: ClipboardCommand, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  if (command.outputFile !== undefined) {
    await execFileAsync(command.file, command.args, { signal, timeout: 5000, windowsHide: true })
    return new Uint8Array(await readFile(command.outputFile))
  }
  const { stdout } = await execFileAsync(command.file, command.args, {
    signal,
    timeout: 5000,
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: 25 * 1024 * 1024,
  })
  return new Uint8Array(stdout)
}

function macCommand(outputFile: string): ClipboardCommand {
  const script = [
    'set imageData to the clipboard as «class PNGf»',
    `set targetFile to open for access POSIX file ${JSON.stringify(outputFile)} with write permission`,
    'set eof targetFile to 0',
    'write imageData to targetFile',
    'close access targetFile',
  ].join('\n')
  return { file: 'osascript', args: ['-e', script], outputFile }
}

function windowsCommand(outputFile: string): ClipboardCommand {
  const escaped = outputFile.replace(/'/gu, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if (-not [Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
    `$image = [Windows.Forms.Clipboard]::GetImage(); $image.Save('${escaped}', [Drawing.Imaging.ImageFormat]::Png); $image.Dispose()`,
  ].join('; ')
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], outputFile }
}

function linuxCommands(): ClipboardCommand[] {
  return [
    { file: 'wl-paste', args: ['--no-newline', '--type', 'image/png'] },
    { file: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] },
  ]
}

function clipboardCommands(platform: NodeJS.Platform, outputFile: string): ClipboardCommand[] {
  if (platform === 'darwin') return [macCommand(outputFile)]
  if (platform === 'win32') return [windowsCommand(outputFile)]
  return linuxCommands()
}

export async function readClipboardImage(
  options: {
    platform?: NodeJS.Platform
    signal?: AbortSignal
    runner?: ClipboardCommandRunner
  } = {},
): Promise<SaveImageAttachment | undefined> {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? defaultRunner
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-tui-clipboard-'))
  try {
    const outputFile = join(tempRoot, 'clipboard.png')
    for (const command of clipboardCommands(platform, outputFile)) {
      options.signal?.throwIfAborted()
      try {
        const data = await runner(command, options.signal)
        if (data === undefined || data.byteLength === 0) continue
        const mediaType = detectImageMediaType(data)
        if (mediaType !== undefined) return { data, mediaType, name: 'clipboard.png' }
      } catch (error) {
        options.signal?.throwIfAborted()
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
      }
    }
    return undefined
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
