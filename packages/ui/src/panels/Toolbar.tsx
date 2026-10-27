import type { RunStatus } from '../lib/model'

export interface RunSettings {
  provider: 'scripted' | 'copilot'
  model: string
  autoApprove: boolean
  stepMode: boolean
}

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
}

const ACTIVE = new Set<RunStatus>(['running', 'paused', 'awaiting-approval'])

export function Toolbar(p: Props) {
  const active = p.mode === 'live' && ACTIVE.has(p.status)
  const set = (patch: Partial<RunSettings>) => p.onSettings({ ...p.settings, ...patch })
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
            placeholder="model (optional)"
            value={p.settings.model}
            disabled={active}
            onChange={(e) => set({ model: e.target.value })}
            aria-label="model"
          />
        )}
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
