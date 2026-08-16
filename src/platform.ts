import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function openExternalPath(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  let command: { file: string; args: string[] }
  if (platform === 'darwin') command = { file: 'open', args: ['--', path] }
  else if (platform === 'win32') command = { file: 'explorer.exe', args: [path] }
  else command = { file: 'xdg-open', args: [path] }
  await execFileAsync(command.file, command.args, { timeout: 5000, windowsHide: true })
}
