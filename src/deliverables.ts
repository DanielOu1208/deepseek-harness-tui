import type { ToolCallView } from '@deepseek-ai/dsh-tools'

export interface PresentedToolMutation {
  seq: number
  turn: number
  failed: boolean
  callView?: ToolCallView
}

export interface Deliverable {
  path: string
  firstSeq: number
  turn: number
}

function mutationLocations(view: ToolCallView | undefined): readonly { path: string }[] {
  if (view?.card === 'diff') return view.locations ?? []
  if (view?.card === 'generic' && view.kind === 'edit') return view.locations ?? []
  return []
}

export function deriveDeliverables(records: readonly PresentedToolMutation[]): Deliverable[] {
  const seen = new Set<string>()
  const output: Deliverable[] = []
  for (const record of records) {
    if (record.failed) continue
    for (const location of mutationLocations(record.callView)) {
      const path = location.path.trim()
      if (path === '' || seen.has(path)) continue
      seen.add(path)
      output.push({ path, firstSeq: record.seq, turn: record.turn })
    }
  }
  return output
}

export function deliverableBasename(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts.at(-1) ?? path
}
