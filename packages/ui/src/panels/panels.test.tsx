import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_FRAME, reduceFrame } from '@core/replay'
import type { ApprovalPause, StuckPause } from '@core/types'
import { startLive, type RunView } from '../lib/model'
import { ApprovalCard, GateCard, NodeEditor, RecoveryCard, StateView } from './Inspector'
import { newNode } from '../lib/model'
import { PatternPanel } from './PatternPanel'
import { Library } from './Library'
import { describeEvent } from '../lib/events'
import { Timeline } from './Timeline'
import { Toolbar } from './Toolbar'

const approvalPause: ApprovalPause = {
  kind: 'approval',
  pauseId: 'p1',
  step: 3,
  nodeId: 'ask',
  label: 'Guess a letter',
  message: 'Guess one letter.',
  state: { experiments: ['hyperfine oxlint', 'hyperfine eslint'] },
  shows: ['experiments'],
  outputSchema: [
    { name: 'letter', type: 'string' },
    { name: 'tries', type: 'number' },
  ],
  feedback: ['updates.letter is required'],
  moveKey: 'm',
}

describe('ApprovalCard', () => {
  it('collects typed values and approves', () => {
    const onAnswer = vi.fn()
    const view: RunView = { ...startLive('r'), status: 'awaiting-approval', pause: approvalPause }
    render(<ApprovalCard view={view} onAnswer={onAnswer} />)
    expect(screen.getByTestId('approval-shows')).toHaveTextContent('hyperfine oxlint')
    expect(screen.getByText('updates.letter is required')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('letter'), { target: { value: 'e' } })
    fireEvent.change(screen.getByLabelText('tries'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Approve'))
    expect(onAnswer).toHaveBeenCalledWith({ approved: true, updates: { letter: 'e', tries: 3 } })
    fireEvent.click(screen.getByText('Scripted answer'))
    expect(onAnswer).toHaveBeenLastCalledWith({ approved: true, scripted: true })
  })

  it('is hidden unless a human is needed', () => {
    const { container } = render(<ApprovalCard view={startLive('r')} onAnswer={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('RecoveryCard', () => {
  const stuck: StuckPause = {
    kind: 'stuck',
    pauseId: 's1',
    step: 4,
    nodeId: 'deepRead',
    label: 'Deep read',
    feedback: ['Account for EVERY item of deepBatch'],
    attempts: 3,
    complexity: 2,
    moveKey: 'm',
  }
  const view: RunView = { ...startLive('r'), status: 'awaiting-approval', pause: stuck }

  it('retries with a hint and a smarter tier, or stops', () => {
    const onAnswer = vi.fn()
    const { rerender } = render(<RecoveryCard view={view} onAnswer={onAnswer} />)
    expect(screen.getByTestId('recovery-card')).toHaveTextContent('Account for EVERY item of deepBatch')
    fireEvent.change(screen.getByLabelText('recovery hint'), { target: { value: 'report 429 pages as unreadable' } })
    fireEvent.change(screen.getByLabelText('recovery tier'), { target: { value: '4' } })
    fireEvent.click(screen.getByText('↻ Retry step'))
    expect(onAnswer).toHaveBeenCalledWith({ action: 'retry', hint: 'report 429 pages as unreadable', complexity: 4 })
    rerender(<RecoveryCard view={{ ...view, pause: { ...stuck, pauseId: 's2' } }} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByText('✕ Stop run'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'stop' })
  })

  it('is hidden unless a step is stuck', () => {
    const { container } = render(<RecoveryCard view={startLive('r')} onAnswer={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('GateCard', () => {
  it('shows the AI result held before the engine applies it', () => {
    const onResume = vi.fn()
    const view: RunView = { ...startLive('r'), status: 'paused', gate: { nodeId: 'pick', phase: 'after', proposed: { updates: { word: 'cat' } } } }
    render(<GateCard view={view} onResume={onResume} onStep={() => {}} onStop={() => {}} />)
    expect(screen.getByText(/after AI answered at “pick”/)).toBeInTheDocument()
    expect(screen.getByTestId('proposed-result')).toHaveTextContent('"word": "cat"')
    fireEvent.click(screen.getByText('▶ Resume'))
    expect(onResume).toHaveBeenCalled()
  })
})

describe('StateView', () => {
  it('highlights changed keys with before values', () => {
    let f = reduceFrame(EMPTY_FRAME, { type: 'run-started', scoreId: 's', state: { word: '', n: 1 } })
    f = reduceFrame(f, { type: 'node-completed', step: 1, nodeId: 'a', changes: [{ key: 'word', before: '', after: 'cat' }], stateHash: 'h' })
    render(<StateView frame={f} />)
    expect(screen.getByTestId('state-word')).toHaveClass('changed')
    expect(screen.getByTestId('state-word')).toHaveTextContent('"cat"')
    expect(screen.getByTestId('state-n')).not.toHaveClass('changed')
  })
})

describe('Timeline', () => {
  it('lists events and seeks', () => {
    const frames = [
      reduceFrame(EMPTY_FRAME, { type: 'run-started', scoreId: 's', state: {} }),
    ]
    frames.push(reduceFrame(frames[0]!, { type: 'node-entered', step: 1, nodeId: 'start', kind: 'start', stateHash: 'h', moveKey: 'm' }))
    const onSeek = vi.fn()
    render(<Timeline frames={frames} cursor={null} onSeek={onSeek} />)
    expect(screen.getByText(/#1 enter start/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/run started/))
    expect(onSeek).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByText('● live'))
    expect(onSeek).toHaveBeenLastCalledWith(null)
  })

  it('describes every event kind', () => {
    expect(describeEvent({ type: 'guard-evaluated', nodeId: 'c', expression: 'x > 1', result: true })).toBe('x > 1 → true')
    expect(describeEvent({ type: 'run-failed', error: 'boom' })).toBe('failed: boom')
  })
})

describe('Toolbar', () => {
  const settings = { provider: 'scripted' as const, model: '', autoApprove: false, stepMode: false, complexity: 0 as const, improvisation: 0 as const }
  const handlers = { onSettings: vi.fn(), onRun: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onStep: vi.fn(), onStop: vi.fn(), onEdit: vi.fn() }

  it('runs when valid and shows pause/stop while running', () => {
    const { rerender } = render(<Toolbar title="t" mode="idle" status="idle" settings={settings} canRun {...handlers} />)
    fireEvent.click(screen.getByText('▶ Run'))
    expect(handlers.onRun).toHaveBeenCalled()
    rerender(<Toolbar title="t" mode="live" status="running" settings={settings} canRun {...handlers} />)
    fireEvent.click(screen.getByText('⏸ Pause'))
    fireEvent.click(screen.getByText('⏹ Stop'))
    expect(handlers.onPause).toHaveBeenCalled()
    expect(handlers.onStop).toHaveBeenCalled()
    rerender(<Toolbar title="t" mode="live" status="paused" settings={settings} canRun {...handlers} />)
    fireEvent.click(screen.getByText('⏭ Step'))
    expect(handlers.onStep).toHaveBeenCalled()
  })

  it('disables run with problems and shows the model box for copilot', () => {
    render(<Toolbar title="t" mode="idle" status="idle" settings={{ ...settings, provider: 'copilot' }} canRun={false} {...handlers} />)
    expect(screen.getByText('▶ Run')).toBeDisabled()
    expect(screen.getByLabelText('model')).toBeInTheDocument()
  })
})

describe('PatternPanel', () => {
  it('asks for a goal only when no input states it', () => {
    const onMeta = vi.fn()
    const props = {
      editable: true,
      goal: '',
      context: {},
      errors: [],
      warnings: [],
      onMeta,
      onGoal: () => {},
      onContext: () => {},
      onSelect: () => {},
      onExport: async () => '',
      onSave: async () => '',
    }
    const meta = { name: 'x', description: 'd', requiredContext: ['question'], verbTriggers: [], state: [{ name: 'question', type: 'string' as const }] }
    const { rerender } = render(<PatternPanel {...props} meta={meta} />)
    expect(screen.getByLabelText('goal')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('goal input'), { target: { value: 'question' } })
    expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({ goalFrom: 'question' }))
    rerender(<PatternPanel {...props} meta={{ ...meta, goalFrom: 'question' }} />)
    expect(screen.queryByLabelText('goal')).toBeNull()
    expect(screen.getByLabelText('context question').closest('label')).toHaveTextContent('the goal')
  })

  it('adds state fields and lists problems', () => {
    const onMeta = vi.fn()
    const onSelect = vi.fn()
    render(
      <PatternPanel
        meta={{ name: 'x', description: 'd', requiredContext: [], verbTriggers: [], state: [] }}
        editable
        goal=""
        context={{}}
        errors={[{ message: 'node broken', nodeId: 'n1' }]}
        warnings={[]}
        onMeta={onMeta}
        onGoal={() => {}}
        onContext={() => {}}
        onSelect={onSelect}
        onExport={async () => ''}
        onSave={async () => ''}
      />,
    )
    fireEvent.click(screen.getByTestId('issue-error'))
    expect(onSelect).toHaveBeenCalledWith('n1')
    fireEvent.change(screen.getByLabelText('new field name'), { target: { value: 'score' } })
    fireEvent.change(screen.getByLabelText('new field type'), { target: { value: 'number' } })
    fireEvent.click(screen.getByText('Add'))
    expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({ state: [{ name: 'score', type: 'number' }] }))
    expect(screen.getByText('View TypeScript')).toBeDisabled()
  })
})

describe('NodeEditor', () => {
  it('edits capabilities and acceptance checks of agents', () => {
    const onChange = vi.fn()
    render(<NodeEditor node={newNode('assessor', 'a', { x: 0, y: 0 })} state={[]} editable onChange={onChange} onDelete={() => {}} />)
    fireEvent.click(screen.getByLabelText('capability web'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ capabilities: ['web'] }))
    fireEvent.change(screen.getByLabelText('checks'), { target: { value: 'subset(batch, triaged) | list every file\nlen(x) > 0' } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ checks: [{ expr: 'subset(batch, triaged)', message: 'list every file' }, { expr: 'len(x) > 0', message: '' }] }),
    )
  })

  it('edits tool and output mapping of tool nodes', () => {
    const onChange = vi.fn()
    render(<NodeEditor node={newNode('tool', 't', { x: 0, y: 0 })} state={[]} editable onChange={onChange} onDelete={() => {}} />)
    fireEvent.change(screen.getByLabelText('tool'), { target: { value: 'sources.catalog' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'sources.catalog' }))
    fireEvent.change(screen.getByLabelText('tool output'), { target: { value: 'files = repoFiles\nexcluded = skipped' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ output: { files: 'repoFiles', excluded: 'skipped' } }))
  })
})


describe('Library saved runs', () => {
  const run = (file: string, demo: boolean) => ({
    file,
    pattern: file,
    goal: 'g',
    scoreId: 's',
    outcome: 'success',
    startedAt: '2026-10-28T00:00:00Z',
    steps: 3,
    demo,
  })
  const props = {
    library: [],
    activeName: '',
    editable: true,
    asking: false,
    onLoad: () => {},
    onNew: () => {},
    onOpenSaved: () => {},
    onRefreshSaved: () => {},
    onPrune: () => {},
    onAsk: () => {},
  }

  it('hides offline-demo runs until asked', () => {
    render(<Library {...props} saved={[run('real', false), run('demo1', true), run('demo2', true)]} />)
    expect(screen.getByText('real')).toBeInTheDocument()
    expect(screen.queryByText('demo1')).toBeNull()
    fireEvent.click(screen.getByText('Show 2 offline-demo runs'))
    expect(screen.getByText('demo1')).toBeInTheDocument()
    expect(screen.getAllByText('demo')).toHaveLength(2)
    fireEvent.click(screen.getByText('Hide 2 offline-demo runs'))
    expect(screen.queryByText('demo2')).toBeNull()
  })

  it('says so when every run is a demo', () => {
    render(<Library {...props} saved={[run('demo1', true)]} />)
    expect(screen.getByText('No runs with a real AI yet.')).toBeInTheDocument()
  })

  it('lists the runs playing now and opens another one', () => {
    const opened: string[] = []
    const live = [
      { id: 'a', pattern: 'investigate', goal: 'why?', status: 'running' },
      { id: 'b', pattern: 'fix', goal: 'the bug', status: 'awaiting-approval' },
      { id: 'c', pattern: 'review', goal: 'old', status: 'done' },
    ]
    render(<Library {...props} saved={[]} live={live} liveId="a" onOpenLive={(id) => opened.push(id)} />)
    const section = screen.getByTestId('live-runs')
    expect(section).toHaveTextContent('investigate')
    expect(section).toHaveTextContent('on screen')
    expect(section).not.toHaveTextContent('review')
    fireEvent.click(screen.getByTitle('the bug'))
    fireEvent.click(screen.getByTitle('why?'))
    expect(opened).toEqual(['b'])
  })

  it('has no running section when nothing is playing', () => {
    render(<Library {...props} saved={[]} live={[{ id: 'c', pattern: 'review', goal: 'g', status: 'done' }]} />)
    expect(screen.queryByTestId('live-runs')).toBeNull()
  })

  it('has a clean-up button for saved runs', () => {
    let pruned = 0
    render(<Library {...props} saved={[]} onPrune={() => (pruned += 1)} />)
    fireEvent.click(screen.getByTestId('prune-runs'))
    expect(pruned).toBe(1)
  })
})
