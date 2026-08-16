import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import { projectWorkflowActivity } from './activity.js'
import { deliverableBasename, deriveDeliverables, type PresentedToolMutation } from './deliverables.js'
import {
  defaultSessionExportFilename,
  SESSION_EXPORT_DISCLOSURE,
  writeSessionExport,
  type SessionExportFormat,
} from './export.js'
import type { PickerItem } from './interaction.js'
import { openExternalPath } from './platform.js'
import { projectSession, type ToolPresenter } from './projection.js'
import type { DeepSeekTui } from './ui.js'
import { projectVisibility, type VisibilitySnapshot, type VisibilityToolRecord } from './visibility.js'

interface CurrentSession {
  agent: Agent
  generation: number
}

export interface SessionInsightsDependencies {
  ctx: Context
  ui: DeepSeekTui
  startupCwd?: string
  getCurrentSession: () => CurrentSession
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return 'n/a'
  if (milliseconds < 1_000) return `${String(Math.round(milliseconds))}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)}s`
  return `${(milliseconds / 60_000).toFixed(1)}m`
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat('en-US').format(tokens)
}

export class SessionInsightsController {
  private activityLoadAbort?: AbortController

  constructor(private readonly dependencies: SessionInsightsDependencies) {}

  private get ctx(): Context {
    return this.dependencies.ctx
  }

  private get ui(): DeepSeekTui {
    return this.dependencies.ui
  }

  private presentedToolMutations(agent: Agent): PresentedToolMutation[] {
    const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
    const output: PresentedToolMutation[] = []
    for (const event of agent.session.events) {
      if (event.type === 'tool/call') {
        calls.set(String(event.data.callId), event)
        continue
      }
      if (event.type !== 'tool/result') continue
      const block = event.data.message.content[0]
      const call = block?.type === 'tool-result' ? calls.get(String(block.toolCallId)) : undefined
      if (call === undefined) continue
      let argumentsValue: unknown = call.data.arguments
      try { argumentsValue = JSON.parse(call.data.arguments) } catch {}
      const callView = this.ctx.tools.get(call.data.name, agent)?.presentCall?.(argumentsValue)
      output.push({
        seq: event.seq,
        turn: event.data.turn,
        failed: event.data.error !== undefined || (block?.type === 'tool-result' && block.isError === true),
        ...(callView === undefined ? {} : { callView }),
      })
    }
    return output
  }

  async chooseDeliverable(): Promise<void> {
    const { agent } = this.dependencies.getCurrentSession()
    const deliverables = deriveDeliverables(this.presentedToolMutations(agent))
    if (deliverables.length === 0) {
      this.ui.appendNotice('No successful mutation tools have reported produced files in this session.')
      return
    }
    const choice = await this.ui.chooseSearchable('Produced files', deliverables.map(item => ({
      value: item.path,
      label: deliverableBasename(item.path),
      description: `turn ${item.turn} · ${item.path}`,
      searchText: item.path,
    })))
    if (choice === undefined) return
    const currentAgent = this.dependencies.getCurrentSession().agent
    const cwd = currentAgent.session.header.cwd ?? resolve(this.dependencies.startupCwd ?? process.cwd())
    const absolute = resolve(cwd, choice.value)
    const action = await this.ui.choose(choice.value, [
      { value: 'copy', label: 'Copy path', description: absolute },
      { value: 'open', label: 'Open externally', description: 'Use the operating system’s default application' },
      { value: 'cancel', label: 'Cancel' },
    ], undefined, { initialValue: 'cancel' })
    if (action?.value === 'copy') {
      this.ui.copyToClipboard(absolute)
      return
    }
    if (action?.value === 'open') {
      const metadata = await stat(absolute)
      if (!metadata.isFile()) throw new Error(`deliverable is not a file: ${choice.value}`)
      await openExternalPath(absolute)
      this.ui.setStatus(`opened ${choice.value}`)
    }
  }

  private visibilitySnapshot(agent: Agent): VisibilitySnapshot {
    return projectVisibility(agent.session.events, String(agent.id))
  }

  private inspectorToolDetail(tool: VisibilityToolRecord): string {
    return [
      `${tool.kind === 'subtool' ? 'Nested tool' : 'Tool'} · ${tool.name}`,
      `- Call: ${tool.callId}`,
      `- Status: ${tool.status}`,
      `- Turn/step: ${tool.turn === undefined ? 'n/a' : String(tool.turn)}/${tool.step === undefined ? 'n/a' : String(tool.step)}`,
      `- Started: ${new Date(tool.startedAt).toLocaleString()} · seq ${String(tool.startSeq)}`,
      `- Duration: ${formatDuration(tool.durationMs)}`,
      ...(tool.parentCallId === undefined ? [] : [`- Parent call: ${tool.parentCallId}`]),
      ...(tool.rootCallId === undefined ? [] : [`- Root call: ${tool.rootCallId}`]),
      ...(tool.argumentsText === undefined ? [] : ['', 'Arguments', tool.argumentsText]),
      ...(tool.resultText === undefined ? [] : ['', tool.resultIsError === true ? 'Error result' : 'Result', tool.resultText]),
      ...(tool.resultMetaText === undefined ? [] : ['', 'Result metadata', tool.resultMetaText]),
    ].join('\n')
  }

  async chooseInspectorEntry(): Promise<void> {
    const { agent } = this.dependencies.getCurrentSession()
    const snapshot = this.visibilitySnapshot(agent)
    const choices: PickerItem[] = [
      ...snapshot.tools.map((tool, index) => ({
        value: `tool:${String(index)}`,
        label: `${tool.kind === 'subtool' ? '↳ ' : ''}${tool.name}`,
        description: `${tool.status} · ${formatDuration(tool.durationMs)} · call ${tool.callId}`,
        searchText: [tool.name, tool.callId, tool.argumentsText, tool.resultText].filter(Boolean).join(' '),
      })).reverse(),
      ...snapshot.steps.map((step, index) => ({
        value: `step:${String(index)}`,
        label: `Turn ${String(step.turn)} · step ${String(step.step)}`,
        description: `${step.status} · model ${formatDuration(step.modelMs)} · first token ${formatDuration(step.ttftMs)}`,
      })).reverse(),
    ]
    if (choices.length === 0) {
      this.ui.appendNotice('No model steps or tool calls have been recorded in this session.')
      return
    }
    const choice = await this.ui.chooseSearchable('Session inspector', choices)
    if (choice === undefined) return
    const [kind, rawIndex] = choice.value.split(':')
    const index = Number(rawIndex)
    if (kind === 'tool') {
      const tool = snapshot.tools[index]
      if (tool !== undefined) this.ui.appendNotice(this.inspectorToolDetail(tool))
      return
    }
    const step = snapshot.steps[index]
    if (step === undefined) return
    this.ui.appendNotice([
      `Turn ${String(step.turn)} · step ${String(step.step)}`,
      `- Status: ${step.status}`,
      `- Started: ${new Date(step.startedAt).toLocaleString()} · seq ${String(step.startSeq)}`,
      `- Model time: ${formatDuration(step.modelMs)}`,
      `- First token: ${formatDuration(step.ttftMs)}`,
      `- Decode: ${formatDuration(step.decodeMs)}`,
      `- Output tokens: ${step.outputTokens === undefined ? 'n/a' : formatTokenCount(step.outputTokens)}`,
    ].join('\n'))
  }

  showSessionStats(): void {
    const { agent } = this.dependencies.getCurrentSession()
    const visibility = this.visibilitySnapshot(agent)
    const official = this.ctx.sessionProjections.snapshot(agent.session).values.sessionStats
    const timing = official ?? visibility.timing
    const tokens = visibility.tokens
    const averageTtft = timing.ttftSteps === 0 ? undefined : timing.ttftMs / timing.ttftSteps
    const decodeRate = timing.decodeMs === 0 ? undefined : timing.decodeTokens / (timing.decodeMs / 1_000)
    this.ui.appendNotice([
      'Session statistics',
      `- Turns / steps: ${String(timing.turns)} / ${String(timing.steps)}`,
      `- Model / tool time: ${formatDuration(timing.llmMs)} / ${formatDuration(timing.toolMs)}`,
      `- Average first-token latency: ${formatDuration(averageTtft)}`,
      `- Decode: ${formatDuration(timing.decodeMs)} · ${decodeRate === undefined ? 'n/a' : `${decodeRate.toFixed(1)} tokens/s`}`,
      `- Nested Code Mode tool time: ${formatDuration(visibility.timing.subtoolMs)}`,
      '',
      'Provider-reported tokens',
      `- Uncached input: ${formatTokenCount(tokens.uncachedInputTokens)}`,
      `- Cache read: ${formatTokenCount(tokens.cacheReadTokens)}`,
      `- Cache write: ${formatTokenCount(tokens.cacheWriteTokens)}`,
      `- Output: ${formatTokenCount(tokens.outputTokens)}`,
    ].join('\n'))
  }

  async showActivity(): Promise<void> {
    const category = await this.ui.choose('Session activity', [
      { value: 'jobs', label: 'Background jobs', description: 'Process-local work visible to this session' },
      { value: 'workflows', label: 'Workflows', description: 'Durable workflow runs recorded in this session' },
      { value: 'subagents', label: 'Subagents', description: 'Durable descendant sessions and current residency' },
    ])
    if (category === undefined) return
    const { agent, generation } = this.dependencies.getCurrentSession()
    if (category.value === 'jobs') {
      const jobs = this.ctx.jobs.list(agent)
      if (jobs.length === 0) {
        this.ui.appendNotice('No background jobs are registered for this session.\n\nJob state is process-local and is not restored after the Harness exits.')
        return
      }
      const choice = await this.ui.chooseSearchable('Background jobs', jobs.map((job, index) => ({
        value: String(index),
        label: `${job.id} · ${job.label}`,
        description: `${job.status}${job.detail === undefined ? '' : ` · ${job.detail}`}`,
        searchText: `${job.id} ${job.kind} ${job.label} ${job.status} ${job.detail ?? ''}`,
      })))
      const job = choice === undefined ? undefined : jobs[Number(choice.value)]
      if (job !== undefined) {
        this.ui.appendNotice([
          `${job.id} · ${job.label}`,
          `- Kind / status: ${job.kind} / ${job.status}`,
          `- Started: ${new Date(job.startedAt).toLocaleString()}`,
          ...(job.finishedAt === undefined ? [] : [`- Finished: ${new Date(job.finishedAt).toLocaleString()}`]),
          ...(job.detail === undefined ? [] : [`- Detail: ${job.detail}`]),
          `- Reported: ${job.reported ? 'yes' : 'no'}`,
          '',
          'Job state is process-local. This inspector does not consume job output or change its reported state.',
        ].join('\n'))
      }
      return
    }
    if (category.value === 'workflows') {
      const workflows = projectWorkflowActivity(agent.session.events)
      if (workflows.length === 0) {
        this.ui.appendNotice('No durable workflow runs have been recorded in this session.')
        return
      }
      const choice = await this.ui.chooseSearchable('Workflow runs', workflows.map((workflow, index) => ({
        value: String(index),
        label: workflow.name,
        description: `${workflow.stopReason ?? 'active/incomplete'} · ${String(workflow.members.length)} agents · ${workflow.id}`,
        searchText: `${workflow.name} ${workflow.id} ${workflow.members.map(member => member.label).join(' ')}`,
      })))
      const workflow = choice === undefined ? undefined : workflows[Number(choice.value)]
      if (workflow !== undefined) {
        this.ui.appendNotice([
          `${workflow.name} · ${workflow.id}`,
          `- Status: ${workflow.stopReason ?? 'active/incomplete'}`,
          `- Started: ${new Date(workflow.startedAt).toLocaleString()}`,
          ...(workflow.endedAt === undefined ? [] : [`- Duration: ${formatDuration(workflow.endedAt - workflow.startedAt)}`]),
          ...(workflow.members.length === 0
            ? ['- Agents: none recorded']
            : ['', 'Agents', ...workflow.members.map(member => `- ${member.phase === undefined ? '' : `${member.phase} · `}${member.label} · ${member.outcome} · ${member.childId}`)]),
          '',
          'This view comes from top-level durable tool-workflow records. A missing end can mean active work, a crash, or incomplete recording; live phase/log text and result values are not persisted by Harness rc.6.',
        ].join('\n'))
      }
      return
    }

    const abort = new AbortController()
    this.activityLoadAbort?.abort(new Error('activity loading superseded'))
    this.activityLoadAbort = abort
    this.ui.setStatus('loading subagent tree…')
    try {
      const descendants = await this.ctx.subagents.listDescendants(agent.id, abort.signal)
      const current = this.dependencies.getCurrentSession()
      if (generation !== current.generation || current.agent !== agent) return
      if (descendants.length === 0) {
        this.ui.appendNotice('No durable subagent descendants were found for this session.')
        return
      }
      const choice = await this.ui.chooseSearchable('Subagent descendants', descendants.map((entry, index) => ({
        value: String(index),
        label: `${'  '.repeat(Math.max(0, entry.depth - 1))}${entry.kind === 'child' ? entry.label ?? String(entry.id) : String(entry.id)}`,
        description: entry.kind === 'child'
          ? `${entry.mode} · ${entry.activity}${entry.hasChildren ? ' · has children' : ''}`
          : `diagnostic · ${entry.reason}`,
        searchText: entry.kind === 'child'
          ? `${entry.id} ${entry.label ?? ''} ${entry.mode} ${entry.activity}`
          : `${entry.id} ${entry.reason}`,
      })))
      const entry = choice === undefined ? undefined : descendants[Number(choice.value)]
      if (entry !== undefined) {
        this.ui.appendNotice(entry.kind === 'child'
          ? [
              `${entry.label ?? entry.id}`,
              `- Session: ${entry.id}`,
              `- Parent: ${entry.parentId}`,
              `- Depth: ${String(entry.depth)}`,
              `- Mode: ${entry.mode}`,
              `- Activity: ${entry.activity}`,
              `- Has children: ${entry.hasChildren ? 'yes' : 'no'}`,
              '',
              'Activity means resident or persisted; it is not a durable success/failure outcome.',
            ].join('\n')
          : `Subagent diagnostic\n- Session: ${entry.id}\n- Parent: ${entry.parentId}\n- Depth: ${String(entry.depth)}\n- Reason: ${entry.reason}`)
      }
    } finally {
      if (this.activityLoadAbort === abort) this.activityLoadAbort = undefined
    }
  }

  async exportSession(argument: string): Promise<void> {
    let format = argument.trim() as SessionExportFormat | ''
    if (format !== '' && format !== 'json' && format !== 'markdown') {
      throw new Error('usage: /export [markdown|json]')
    }
    if (format === '') {
      const selected = await this.ui.choose('Export format', [
        { value: 'markdown', label: 'Markdown', description: 'Readable transcript plus a lossless event-log appendix' },
        { value: 'json', label: 'JSON', description: 'Versioned portable data envelope' },
      ], undefined, { initialValue: 'markdown' })
      if (selected === undefined) return
      format = selected.value as SessionExportFormat
    }

    const { agent } = this.dependencies.getCurrentSession()
    const cwd = agent.session.header.cwd ?? resolve(this.dependencies.startupCwd ?? process.cwd())
    const defaultPath = join(cwd, defaultSessionExportFilename(agent.session.header, format))
    const destinationChoice = await this.ui.choose(`Export current session\n\n${SESSION_EXPORT_DISCLOSURE}`, [
      { value: 'default', label: 'Save in workspace', description: defaultPath },
      { value: 'custom', label: 'Choose another path…', description: 'Enter an absolute or working-directory-relative path' },
      { value: 'cancel', label: 'Cancel' },
    ], undefined, { initialValue: 'default' })
    if (destinationChoice === undefined || destinationChoice.value === 'cancel') return
    let destination = defaultPath
    if (destinationChoice.value === 'custom') {
      const customPath = await this.ui.promptText('Export destination path:')
      if (customPath === undefined || customPath.trim() === '') return
      destination = resolve(cwd, customPath.trim())
    }
    const session = agent.session
    await this.ctx.sessions.flush(session)
    const official = this.ctx.sessionProjections.snapshot(session)
    const events = session.events.filter(event => event.seq <= official.asOfSeq)
    const sessionId = String(agent.id)
    const presenter: ToolPresenter = {
      presentCall: (name, argumentsValue) => this.ctx.tools.get(name, agent)?.presentCall?.(argumentsValue),
      presentResult: (name, argumentsValue, result) => this.ctx.tools.get(name, agent)?.presentResult?.(
        argumentsValue,
        result as ToolResult,
      ),
    }
    const input = {
      header: session.header,
      events,
      projections: {
        transcript: projectSession(sessionId, events, presenter),
        visibility: projectVisibility(events, sessionId),
        official,
      },
    }
    try {
      const written = await writeSessionExport(input, destination, { format })
      this.ui.appendNotice(`Exported ${format} session to ${written.path} (${formatTokenCount(written.bytes)} bytes).\n${SESSION_EXPORT_DISCLOSURE}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const overwrite = await this.ui.choose(`Replace existing export?\n\n${destination}`, [
        { value: 'cancel', label: 'Cancel', description: 'Keep the existing file' },
        { value: 'overwrite', label: 'Replace file', description: 'Atomically overwrite this exact path' },
      ], undefined, { initialValue: 'cancel' })
      if (overwrite?.value !== 'overwrite') return
      const written = await writeSessionExport(input, destination, { format, overwrite: true })
      this.ui.appendNotice(`Exported ${format} session to ${written.path} (${formatTokenCount(written.bytes)} bytes).\n${SESSION_EXPORT_DISCLOSURE}`)
    }
  }

  interrupt(): void {
    this.activityLoadAbort?.abort(new Error('activity loading cancelled'))
  }

  shutdown(): void {
    this.activityLoadAbort?.abort(new Error('TUI shutting down'))
  }
}
