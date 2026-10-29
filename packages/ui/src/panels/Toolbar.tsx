import { IMPROVISATION_LEVELS } from '@core/jazz'
import type { Complexity, Improvisation } from '@core/types'
import type { RunStatus } from '../lib/model'

const TIER_NAMES: Record<Complexity, string> = { 1: 'routine', 2: 'some judgement', 3: 'risky', 4: 'novel' }

function tierHint(tiers?: Tiers): string {
  const lines = ([1, 2, 3, 4] as const).map(
    (c) => `${c} ${TIER_NAMES[c]}: ${tiers?.[c] ? `${tiers[c]!.model}${tiers[c]!.effort ? ` (${tiers[c]!.effort})` : ''}` : 'default model'}`,
  )
  return `Model tier per complexity (Copilot):\n${lines.join('\n')}\nauto = rated from the problem (investigate, fix, implement rate it before they start; the maestro for scores it composes). Each step then plays its own tier above or below that.`
}

export interface RunSettings {
  provider: 'scripted' | 'copilot'
  model: string
  autoApprove: boolean
  stepMode: boolean
  /** 0 = the pattern's default (the maestro decides for composed scores). */
  complexity: 0 | Complexity
  improvisation: Improvisation
}

export type Tiers = Partial<Record<Complexity, { model: string; effort?: string }>>

interface Props {
  title: string
  mode: 'idle' | 'live' | 'replay'
  status: RunStatus
  settings: RunSettings
  canRun: boolean
  onSettings: (s: RunSettings) => void
  onRun: () => void
  onPause: () => void
  onResume: () => void
  onStep: () => void
  onStop: () => void
  onEdit: () => void
  tiers?: Tiers
}

const ACTIVE = new Set<RunStatus>(['running', 'paused', 'awaiting-approval'])

export function Toolbar(p: Props) {
  const active = p.mode === 'live' && ACTIVE.has(p.status)
  const set = (patch: Partial<RunSettings>) => p.onSettings({ ...p.settings, ...patch })
  const level = IMPROVISATION_LEVELS[p.settings.improvisation]!
  return (
    <header className="toolbar">
      <div className="tb-title">
        <span className="tb-logo">♪</span> {p.title}
        <span className={`status-pill status-${p.status}`} data-testid="run-status">
          {p.mode === 'replay' ? `replay · ${p.status}` : p.status}
        </span>
      </div>
      <div className="tb-group">
        <label title="Who answers agent nodes">
          AI
          <select
            value={p.settings.provider}
            disabled={active}
            onChange={(e) => set({ provider: e.target.value as RunSettings['provider'] })}
            aria-label="provider"
          >
            <option value="scripted">Scripted (offline demo)</option>
            <option value="copilot">GitHub Copilot</option>
          </select>
        </label>
        {p.settings.provider === 'copilot' && (
          <input
            className="tb-model"
            placeholder="model (overrides tiers)"
            value={p.settings.model}
            disabled={active}
            onChange={(e) => set({ model: e.target.value })}
            aria-label="model"
          />
        )}
        <label title={tierHint(p.tiers)}>
          Complexity
          <select
            value={p.settings.complexity}
            disabled={active}
            onChange={(e) => set({ complexity: Number(e.target.value) as RunSettings['complexity'] })}
            aria-label="complexity"
          >
            <option value={0}>auto</option>
            {([1, 2, 3, 4] as const).map((c) => (
              <option key={c} value={c}>
                {c} · {TIER_NAMES[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="knob" title={level.summary}>
          <span className="knob-icon">{level.icon}</span>
          <input
            type="range"
            min={0}
            max={4}
            step={1}
            value={p.settings.improvisation}
            disabled={active}
            onChange={(e) => set({ improvisation: Number(e.target.value) as Improvisation })}
            aria-label="improvisation"
          />
          <span className="knob-name">{level.name}</span>
        </label>
        <label title="Answer approval nodes with the pattern's scripted answers">
          <input type="checkbox" checked={p.settings.autoApprove} disabled={active} onChange={(e) => set({ autoApprove: e.target.checked })} />
          auto-approve
        </label>
        <label title="Pause before every node and after every AI answer">
          <input type="checkbox" checked={p.settings.stepMode} onChange={(e) => set({ stepMode: e.target.checked })} aria-label="step mode" />
          step mode
        </label>
      </div>
      <div className="tb-group tb-controls">
        {!active ? (
          <>
            {p.mode !== 'idle' && (
              <button type="button" onClick={p.onEdit}>
                ✎ Edit
              </button>
            )}
            <button type="button" className="primary" onClick={p.onRun} disabled={!p.canRun} title={p.canRun ? 'Run' : 'Fix the problems first'}>
              ▶ Run
            </button>
          </>
        ) : (
          <>
            {p.status === 'running' && (
              <button type="button" onClick={p.onPause}>
                ⏸ Pause
              </button>
            )}
            {p.status === 'paused' && (
              <>
                <button type="button" className="primary" onClick={p.onResume}>
                  ▶ Resume
                </button>
                <button type="button" onClick={p.onStep}>
                  ⏭ Step
                </button>
              </>
            )}
            <button type="button" className="danger" onClick={p.onStop}>
              ⏹ Stop
            </button>
          </>
        )}
      </div>
    </header>
  )
}
