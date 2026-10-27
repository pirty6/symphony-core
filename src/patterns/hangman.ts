import type { Pattern } from '../core/types.js';

const DEMO_GUESSES = ['e', 'x', 'p', 'l', 'a', 'n', 't'];

/**
 * Hangman: one AI node (pick a word), one human gate (guess), and the
 * rules computed deterministically by the engine.
 */
export const hangman: Pattern = {
  name: 'hangman',
  description: 'AI picks a secret word; a human guesses letters; the engine keeps score.',
  verbTriggers: ['play', 'game', 'hangman'],
  requiredContext: [],
  state: [
    { name: 'word', type: 'string', description: 'Secret lowercase word' },
    { name: 'letter', type: 'string', description: 'Latest single-letter guess' },
    { name: 'guessed', type: 'string[]' },
    { name: 'wrongCount', type: 'number' },
    { name: 'maxWrong', type: 'number', initial: 6 },
    { name: 'won', type: 'boolean' },
  ],
  start: 'start',
  maxSteps: 200,
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'pick',
      kind: 'agent',
      role: 'assessor',
      label: 'Pick word',
      directive:
        'Pick one random common English word of 5 to 7 lowercase letters (a-z only). Return it as `word`.',
      reads: [],
      writes: ['word'],
      retries: 2,
    },
    {
      id: 'ask',
      kind: 'approval',
      label: 'Guess a letter',
      message: 'Guess one letter.',
      writes: ['letter'],
      maxVisits: 26,
    },
    {
      id: 'judge',
      kind: 'compute',
      label: 'Score guess',
      assign: [
        { field: 'letter', expr: 'lower(letter)' },
        { field: 'guessed', expr: 'append(guessed, letter)' },
        { field: 'wrongCount', expr: 'if(includes(word, letter), wrongCount, wrongCount + 1)' },
        { field: 'won', expr: 'subset(chars(word), guessed)' },
      ],
    },
    {
      id: 'over',
      kind: 'condition',
      label: 'Game over?',
      expression: 'won || wrongCount >= maxWrong',
    },
    { id: 'result', kind: 'condition', label: 'Won?', expression: 'won' },
    { id: 'win', kind: 'end', label: 'You win', outcome: 'success' },
    { id: 'lose', kind: 'end', label: 'You lose', outcome: 'partial' },
  ],
  edges: [
    { id: 'start-pick', from: 'start', to: 'pick' },
    { id: 'pick-ask', from: 'pick', to: 'ask', guard: 'len(word) >= 3', label: 'word ready' },
    { id: 'pick-retry', from: 'pick', to: 'pick', label: 'word too short' },
    { id: 'ask-judge', from: 'ask', to: 'judge', branch: 'approved' },
    { id: 'judge-over', from: 'judge', to: 'over' },
    { id: 'over-result', from: 'over', to: 'result', branch: 'then' },
    { id: 'over-ask', from: 'over', to: 'ask', branch: 'else', label: 'next guess' },
    { id: 'result-win', from: 'result', to: 'win', branch: 'then' },
    { id: 'result-lose', from: 'result', to: 'lose', branch: 'else' },
  ],
  demo: {
    goal: 'Play a round of hangman',
    agents: {
      pick: () => ({
        updates: { word: 'planet' },
        verdict: {
          outcome: 'applied',
          confidence: 1,
          shouldTerminate: false,
          reason: 'picked a word',
        },
      }),
    },
    approvals: {
      ask: (_state, visit) => ({ approved: true, updates: { letter: DEMO_GUESSES[visit] ?? 'z' } }),
    },
  },
};
