import { describe, it, expect } from 'vitest'
import { buildOrchestratorInput, renderPrompt } from './prompt'

describe('hangman workflow', () => {
  const nodes = [
    {
      id: 'orchestrator-1',
      type: 'orchestrator',
      label: 'Orchestrator',
      description: 'Hangman game controller',
      prompt: 'You are the hangman game controller. You manage all state transitions yourself.',
      stateFields: [
        { name: 'word', type: 'string' as const },
        { name: 'guessedLetters', type: 'string[]' as const },
        { name: 'wrongCount', type: 'number' as const },
        { name: 'maxWrong', type: 'number' as const },
        { name: 'gameOver', type: 'boolean' as const },
      ],
    },
    { id: 'instrument-2', type: 'assessor', label: 'Pick Word', description: 'Selects a secret word', prompt: 'Pick a random common English word (5-7 letters). Return the word.' },
    { id: 'instrument-3', type: 'approval', label: 'Guess Letter', description: 'Wait for player to guess', prompt: 'Ask the player to guess a letter. Return their guess.' },
    { id: 'instrument-4', type: 'end', label: 'End', description: 'Game finished', prompt: '' },
  ]

  const edges = [
    { source: 'orchestrator-1', target: 'instrument-2', label: 'word is not set' },
    { source: 'instrument-2', target: 'orchestrator-1', label: 'word picked' },
    { source: 'orchestrator-1', target: 'instrument-3', label: 'word is set, not game over' },
    { source: 'instrument-3', target: 'orchestrator-1', label: 'letter received' },
    { source: 'orchestrator-1', target: 'instrument-4', label: 'game over' },
  ]

  it('builds the correct state machine structure', () => {
    const input = buildOrchestratorInput(nodes, edges)

    expect(input.directive).toBe('You are the hangman game controller. You manage all state transitions yourself.')
    expect(input.instruments).toHaveLength(1)
    expect(input.instruments[0]).toMatchObject({ type: 'assessor', label: 'Pick Word' })
    expect(input.stateFields).toHaveLength(5)
    expect(input.nodes).toHaveLength(4)
  })

  it('orchestrator has three outgoing transitions with conditions', () => {
    const input = buildOrchestratorInput(nodes, edges)
    const orch = input.nodes.find((n) => n.type === 'orchestrator')!

    expect(orch.transitions).toEqual([
      { target: 'assessor:Pick Word', condition: 'word is not set' },
      { target: 'approval:Guess Letter', condition: 'word is set, not game over' },
      { target: 'end:End', condition: 'game over' },
    ])
  })

  it('assessor returns to orchestrator with condition', () => {
    const input = buildOrchestratorInput(nodes, edges)
    const assessor = input.nodes.find((n) => n.type === 'assessor')!

    expect(assessor.transitions).toEqual([
      { target: 'orchestrator:Orchestrator', condition: 'word picked' },
    ])
  })

  it('approval returns to orchestrator with condition', () => {
    const input = buildOrchestratorInput(nodes, edges)
    const approval = input.nodes.find((n) => n.type === 'approval')!

    expect(approval.transitions).toEqual([
      { target: 'orchestrator:Orchestrator', condition: 'letter received' },
    ])
  })

  it('end node has no transitions', () => {
    const input = buildOrchestratorInput(nodes, edges)
    const end = input.nodes.find((n) => n.type === 'end')!
    expect(end.transitions).toEqual([])
  })

  it('renders a complete prompt with all hangman elements', () => {
    const input = buildOrchestratorInput(nodes, edges)
    const prompt = renderPrompt(input)

    expect(prompt).toContain('hangman game controller')
    expect(prompt).toContain('- word: string')
    expect(prompt).toContain('- guessedLetters: string[]')
    expect(prompt).toContain('- wrongCount: number')
    expect(prompt).toContain('- maxWrong: number')
    expect(prompt).toContain('- gameOver: boolean')
    expect(prompt).toContain('[word is not set]')
    expect(prompt).toContain('[word picked]')
    expect(prompt).toContain('[word is set, not game over]')
    expect(prompt).toContain('[letter received]')
    expect(prompt).toContain('[game over]')
    expect(prompt).toContain('orchestrator:Orchestrator')
    expect(prompt).toContain('assessor:Pick Word')
    expect(prompt).toContain('approval:Guess Letter')
    expect(prompt).toContain('end:End')
    expect(prompt).toContain('STATE MACHINE')
    expect(prompt).toContain('PAUSE and wait for human input')
  })

  it('renders with initial state when provided', () => {
    const input = buildOrchestratorInput(nodes, edges, {
      word: 'hello',
      guessedLetters: ['h', 'e'],
      wrongCount: 1,
      maxWrong: 6,
      gameOver: false,
    })
    const prompt = renderPrompt(input)

    expect(prompt).toContain('"word": "hello"')
    expect(prompt).toContain('"wrongCount": 1')
    expect(prompt).toContain('"gameOver": false')
  })
})
