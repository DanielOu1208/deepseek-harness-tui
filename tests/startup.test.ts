import test from 'node:test'
import assert from 'node:assert/strict'
import { createTuiCommand } from '../src/startup.js'

test('parses resume, cwd, and initial prompt options', async () => {
  let parsed: unknown
  const command = createTuiCommand(options => { parsed = options })
  await command.parseAsync([
    '--resume', 'session-7', '--cwd', '/tmp/work', '--prompt', 'finish', 'the', 'task',
  ], { from: 'user' })

  assert.deepEqual(parsed, {
    resume: 'session-7',
    cwd: '/tmp/work',
    prompt: 'finish the task',
  })
})
