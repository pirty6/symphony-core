import type { Pattern } from '../core/types.js';

const v = (reason: string, confidence = 0.9) => ({
  outcome: 'applied' as const,
  confidence,
  shouldTerminate: false,
  reason,
});

/** Read-only investigation loop: gather evidence until confident, ask a human when stuck. */
export const investigate: Pattern = {
  name: 'investigate',
  description: 'Answer a question about the codebase with evidence; loop until confident.',
  verbTriggers: ['investigate', 'explain', 'why', 'how does', 'find out'],
  requiredContext: ['question'],
  state: [
    { name: 'question', type: 'string', description: 'What to find out' },
    { name: 'hint', type: 'string', description: 'Optional human clarification' },
    { name: 'findings', type: 'string[]', description: 'Evidence with file paths' },
    {
      name: 'confidence',
      type: 'number',
      description: '0..1 confidence the findings answer the question',
    },
    { name: 'answer', type: 'string', description: 'Final answer citing findings' },
  ],
  start: 'start',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    {
      id: 'gather',
      kind: 'agent',
      role: 'assessor',
      label: 'Gather evidence',
      directive:
        'Investigate the workspace (read-only) to answer `question`. Use `hint` if present. Return ALL findings so far (previous + new) as short bullet strings that cite file paths, and your confidence that they answer the question.',
      reads: ['question', 'hint', 'findings'],
      writes: ['findings', 'confidence'],
      maxVisits: 3,
    },
    { id: 'confident', kind: 'condition', label: 'Confident?', expression: 'confidence >= 0.7' },
    {
      id: 'clarify',
      kind: 'approval',
      label: 'Ask for a hint',
      message: 'Confidence is low. Give a hint (where to look, what you mean) or reject to stop.',
      writes: ['hint'],
      maxVisits: 2,
    },
    {
      id: 'answer',
      kind: 'agent',
      role: 'assessor',
      label: 'Write answer',
      directive: 'Write a concise answer to `question` using only `findings`. Cite file paths.',
      reads: ['question', 'findings'],
      writes: ['answer'],
    },
    { id: 'done', kind: 'end', label: 'Answered' },
  ],
  edges: [
    { id: 'start-gather', from: 'start', to: 'gather' },
    { id: 'gather-confident', from: 'gather', to: 'confident' },
    { id: 'confident-answer', from: 'confident', to: 'answer', branch: 'then' },
    { id: 'confident-clarify', from: 'confident', to: 'clarify', branch: 'else' },
    { id: 'clarify-gather', from: 'clarify', to: 'gather', branch: 'approved' },
    { id: 'answer-done', from: 'answer', to: 'done' },
  ],
  demo: {
    goal: 'Find where run state is validated',
    context: { question: 'Where are AI responses validated before they change state?' },
    agents: {
      gather: (_s, visit) =>
        visit === 0
          ? {
              updates: { findings: ['src/core/engine.ts drives nodes'], confidence: 0.4 },
              verdict: v('partial', 0.4),
            }
          : {
              updates: {
                findings: [
                  'src/core/engine.ts drives nodes',
                  'src/core/schema.ts validateNodeResult checks updates + verdict',
                ],
                confidence: 0.85,
              },
              verdict: v('found validator'),
            },
      answer: () => ({
        updates: {
          answer:
            'validateNodeResult in src/core/schema.ts, called by advance() in src/core/engine.ts.',
        },
        verdict: v('answered'),
      }),
    },
    approvals: {
      clarify: () => ({ approved: true, updates: { hint: 'look at src/core/schema.ts' } }),
    },
  },
};
