import test from 'node:test'
import assert from 'node:assert/strict'
import { projectWorkflowActivity } from '../src/activity.js'

test('pairs durable workflow runs and members while preserving incomplete records', () => {
  const events = [
    { type: 'tool-workflow/run-start', seq: 0, time: 100, data: { runId: 'run-1', name: 'Review' } },
    { type: 'tool-workflow/agent-start', seq: 1, time: 110, data: { runId: 'run-1', seq: 1, label: 'Scout', phase: 'read', childId: 'child-1' } },
    { type: 'tool-workflow/agent-end', seq: 2, time: 140, data: { runId: 'run-1', seq: 1, outcome: 'completed' } },
    { type: 'tool-workflow/run-end', seq: 3, time: 150, data: { runId: 'run-1', stopReason: 'completed' } },
    { type: 'tool-workflow/run-start', seq: 4, time: 200, data: { runId: 'run-2', name: 'Build' } },
  ]

  assert.deepEqual(projectWorkflowActivity(events), [
    {
      id: 'run-1', name: 'Review', startedAt: 100, endedAt: 150, stopReason: 'completed',
      members: [{ seq: 1, label: 'Scout', phase: 'read', childId: 'child-1', outcome: 'completed' }],
    },
    { id: 'run-2', name: 'Build', startedAt: 200, members: [] },
  ])
})

test('ignores malformed and orphaned workflow records', () => {
  const events = [
    { type: 'tool-workflow/agent-start', seq: 0, time: 1, data: { runId: 'missing', seq: 1, childId: 'child' } },
    { type: 'tool-workflow/run-start', seq: 1, time: 2, data: { name: 'Missing id' } },
    { type: 'user/message', seq: 2, time: 3, data: {} },
  ]
  assert.deepEqual(projectWorkflowActivity(events), [])
})
