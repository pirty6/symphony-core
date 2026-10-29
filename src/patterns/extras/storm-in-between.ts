import type { Pattern } from '../../core/types.js';

/** Read any subject as a storm, without filtering it into one answer: the volatile edge, the still center, what a filter would keep and drop, where lightning would strike, and the beat they share, heard from the in-between. */
export const stormInBetween: Pattern = {
  name: 'storm-in-between',
  description:
    'Read any subject as a storm, without filtering it into one answer: the volatile edge, the still center, what a filter would keep and drop, where lightning would strike, and the beat they share, heard from the in-between.',
  verbTriggers: ['storm', 'in between', 'signal and noise', 'listen to the noise'],
  requiredContext: ['subject'],
  goalFrom: 'subject',
  result: [
    'reading',
    'beat',
    'inclinations',
    'edge',
    'center',
    'filtered',
    'dropped',
    'forecast',
    'feltByYou',
  ],
  state: [
    {
      name: 'subject',
      type: 'string',
      description: 'What to sit with: data, a market, a question, a situation, yourself',
    },
    {
      name: 'raindrops',
      type: 'string[]',
      description: 'Everything observed, unfiltered',
    },
    {
      name: 'edge',
      type: 'string[]',
      description: 'Where it is most volatile',
    },
    {
      name: 'center',
      type: 'string[]',
      description: 'What does not move',
    },
    {
      name: 'filtered',
      type: 'string[]',
      description: 'What a filter would keep: the next note that fits',
    },
    {
      name: 'dropped',
      type: 'string[]',
      description: 'What that filter would throw away',
    },
    {
      name: 'forecast',
      type: 'string[]',
      description: 'Where lightning would strike next, from the past',
    },
    {
      name: 'beat',
      type: 'string[]',
      description: 'Rhythms that repeat across every voice',
    },
    {
      name: 'inclinations',
      type: 'string[]',
      description: 'Where things lean, before they happen',
    },
    {
      name: 'felt',
      type: 'boolean',
      description: 'The beat is felt, not guessed',
    },
    {
      name: 'rounds',
      type: 'number',
    },
    {
      name: 'maxRounds',
      type: 'number',
      initial: 3,
    },
    {
      name: 'storm',
      type: 'string[]',
      description: 'Every voice, held together',
    },
    {
      name: 'feltByYou',
      type: 'string',
      description: 'What you feel when you sit with it',
    },
    {
      name: 'reading',
      type: 'string',
      description: 'The reading from the in-between',
    },
  ],
  nodes: [
    {
      id: 'start',
      label: 'Start',
      kind: 'start',
    },
    {
      id: 'gather',
      label: 'Enter the storm',
      kind: 'agent',
      role: 'assessor',
      directive:
        'Take in `subject` as a storm: write every observation you can make about it in `raindrops`, one per entry, the strange and the ordinary alike. Do not filter, rank or explain them yet: if it is there, it goes in. If `subject` points at something in the workspace, read it.',
      reads: ['subject'],
      writes: ['raindrops'],
      checks: [
        {
          expr: 'len(raindrops) > 0',
          message: 'Write raindrops: this voice must be heard.',
        },
      ],
    },
    {
      id: 'edge',
      label: 'The edge',
      kind: 'agent',
      role: 'assessor',
      directive:
        'From `raindrops`, write in `edge` where the storm is most volatile: outliers, extremes, contradictions, what changes fastest. Keep them; do not explain them away.',
      reads: ['subject', 'raindrops'],
      writes: ['edge'],
      checks: [
        {
          expr: 'len(edge) > 0',
          message: 'Write edge: this voice must be heard.',
        },
      ],
    },
    {
      id: 'center',
      label: 'The center',
      kind: 'agent',
      role: 'assessor',
      directive:
        'From `raindrops`, write in `center` what is perfectly still: what does not move, what everything else turns around.',
      reads: ['subject', 'raindrops'],
      writes: ['center'],
      checks: [
        {
          expr: 'len(center) > 0',
          message: 'Write center: this voice must be heard.',
        },
      ],
    },
    {
      id: 'filter',
      label: 'The filter',
      kind: 'agent',
      role: 'assessor',
      directive:
        'Play the filter: choose the pattern most people would look for in `subject`, write in `filtered` the raindrops that fit it (the next correct note), and in `dropped` the ones it would throw away. You are one voice among several, not the answer.',
      reads: ['subject', 'raindrops'],
      writes: ['filtered', 'dropped'],
      checks: [
        {
          expr: 'len(filtered) > 0',
          message: 'Write filtered: this voice must be heard.',
        },
      ],
    },
    {
      id: 'lightning',
      label: 'Chase the lightning',
      kind: 'agent',
      role: 'assessor',
      directive:
        'Play the forecaster: from what has already happened in `raindrops`, write in `forecast` where lightning would strike next and why. You are one voice among several, not the answer.',
      reads: ['subject', 'raindrops'],
      writes: ['forecast'],
      checks: [
        {
          expr: 'len(forecast) > 0',
          message: 'Write forecast: this voice must be heard.',
        },
      ],
    },
    {
      id: 'listen',
      label: 'Sit in the clouds',
      maxVisits: 4,
      kind: 'agent',
      role: 'assessor',
      directive:
        'Sit with every voice at once: `edge`, `center`, `filtered`, `dropped` and `forecast`, and the `raindrops` themselves. Do not pick one. Write in `beat` the rhythms that repeat across them (especially through what the filter dropped: signal and noise are not separable here), and in `inclinations` where things lean before they happen. Set `felt` only when the beat explains the edge AND the center AND the forecast without discarding any of them; otherwise listen again next round, adding to `beat`.',
      reads: [
        'subject',
        'raindrops',
        'edge',
        'center',
        'filtered',
        'dropped',
        'forecast',
        'beat',
        'inclinations',
        'rounds',
      ],
      writes: ['beat', 'inclinations', 'felt'],
      checks: [
        {
          expr: 'len(beat) > 0',
          message: 'Write at least one beat you hear.',
        },
      ],
    },
    {
      id: 'round',
      label: 'One more round',
      kind: 'compute',
      assign: [
        {
          field: 'rounds',
          expr: 'rounds + 1',
        },
      ],
    },
    {
      id: 'heartbeat',
      label: 'Heartbeat in sync?',
      kind: 'condition',
      expression: 'felt || rounds >= maxRounds',
    },
    {
      id: 'hold',
      label: 'Hold the whole storm',
      kind: 'compute',
      assign: [
        {
          field: 'storm',
          expr: 'edge + center + filtered + dropped + forecast + beat',
        },
      ],
    },
    {
      id: 'immerse',
      label: 'Do you feel it?',
      kind: 'approval',
      message:
        'Here is the whole storm: every voice, and the beat heard between them. Sit with it. Write what you feel (optional) and approve to hear the reading from the in-between, or reject to leave the storm unread.',
      writes: ['feltByYou'],
      shows: ['beat', 'inclinations', 'edge', 'center', 'filtered', 'dropped', 'forecast'],
    },
    {
      id: 'inBetween',
      label: 'Speak from the in-between',
      kind: 'agent',
      role: 'assessor',
      directive:
        "Write `reading`: what `subject` is, heard from the in-between. Not the edge, not the center, not the filter's next note, not the forecast: the beat they share. Say what each voice contributes and what the filter would have lost by dropping `dropped`. Include `feltByYou` if it is set. No single voice wins; do not end on one correct answer.",
      reads: [
        'subject',
        'storm',
        'beat',
        'inclinations',
        'edge',
        'center',
        'filtered',
        'dropped',
        'forecast',
        'feltByYou',
      ],
      writes: ['reading'],
      checks: [
        {
          expr: 'len(reading) > 0',
          message: 'Write the reading.',
        },
      ],
      complexityShift: 1,
    },
    {
      id: 'inTheInBetween',
      label: 'In the in-between',
      kind: 'end',
      outcome: 'success',
    },
    {
      id: 'unread',
      label: 'The storm goes on',
      kind: 'end',
      outcome: 'partial',
    },
  ],
  edges: [
    {
      id: 'start-gather',
      from: 'start',
      to: 'gather',
    },
    {
      id: 'gather-edge',
      from: 'gather',
      to: 'edge',
    },
    {
      id: 'edge-center',
      from: 'edge',
      to: 'center',
    },
    {
      id: 'center-filter',
      from: 'center',
      to: 'filter',
    },
    {
      id: 'filter-lightning',
      from: 'filter',
      to: 'lightning',
    },
    {
      id: 'lightning-listen',
      from: 'lightning',
      to: 'listen',
    },
    {
      id: 'listen-round',
      from: 'listen',
      to: 'round',
    },
    {
      id: 'round-heartbeat',
      from: 'round',
      to: 'heartbeat',
    },
    {
      id: 'heartbeat-hold',
      from: 'heartbeat',
      to: 'hold',
      branch: 'then',
    },
    {
      id: 'heartbeat-listen',
      from: 'heartbeat',
      to: 'listen',
      branch: 'else',
      label: 'listen again',
    },
    {
      id: 'hold-immerse',
      from: 'hold',
      to: 'immerse',
    },
    {
      id: 'immerse-inBetween',
      from: 'immerse',
      to: 'inBetween',
      branch: 'approved',
    },
    {
      id: 'immerse-unread',
      from: 'immerse',
      to: 'unread',
      branch: 'rejected',
    },
    {
      id: 'inBetween-end',
      from: 'inBetween',
      to: 'inTheInBetween',
    },
  ],
  start: 'start',
  maxSteps: 60,
  groups: [
    {
      id: 'enter',
      label: 'Enter the storm',
      nodes: ['gather'],
      description: 'Every raindrop, unfiltered',
    },
    {
      id: 'voices',
      label: 'The voices',
      nodes: ['edge', 'center', 'filter', 'lightning'],
      description: 'Edge, center, filter and lightning, each heard on its own',
    },
    {
      id: 'listening',
      label: 'Sit in the clouds',
      nodes: ['listen', 'round', 'heartbeat'],
      description: 'Listen in rounds until the beat is felt',
    },
    {
      id: 'resolution',
      label: 'The in-between',
      nodes: ['hold', 'immerse', 'inBetween'],
      description: 'All voices held; no single one wins',
    },
  ],
};
