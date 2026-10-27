/**
 * Classical vs jazz.
 *
 * The orchestra plays a Score. How much the musicians (AI) may improvise is a
 * single knob, `improvisation`, fixed in the Score (and hashed into its id):
 *
 *   0 Classical  same song -> exactly the same notes: recorded answers for an identical
 *                move are replayed instead of asking the AI again; routes are scripted.
 *   1 Cool       every performance is a fresh take; routes are scripted.
 *   2 Swing      + at solo points the AI chooses where the tune goes next.
 *   3 Bebop      + read-only agents play 2 independent takes, merged by an integrator.
 *   4 Free       + 3 takes, and agents are invited to try unconventional angles.
 *
 * Every performance at every level is recorded and replays exactly.
 */
import type { Improvisation, Role } from './types.js';

export interface ImprovisationLevel {
  readonly level: Improvisation;
  readonly name: string;
  readonly icon: string;
  readonly summary: string;
}

export const IMPROVISATION_LEVELS: readonly ImprovisationLevel[] = [
  {
    level: 0,
    name: 'Classical',
    icon: '🎻',
    summary: 'Same song, same notes: recorded answers are replayed; routes are scripted.',
  },
  {
    level: 1,
    name: 'Cool',
    icon: '🎷',
    summary: 'Fresh takes every performance; routes are scripted.',
  },
  { level: 2, name: 'Swing', icon: '🎷', summary: 'AI chooses the route at solo points.' },
  {
    level: 3,
    name: 'Bebop',
    icon: '🎺',
    summary: 'Solos, and read-only agents play 2 takes that are merged.',
  },
  {
    level: 4,
    name: 'Free',
    icon: '🥁',
    summary: 'Solos, 3 merged takes, and unconventional angles welcome.',
  },
];

export const isImprovisation = (v: unknown): v is Improvisation =>
  v === 0 || v === 1 || v === 2 || v === 3 || v === 4;

/** Classical replays recorded notes for an identical move (repertoire). */
export const playsFromRepertoire = (level: Improvisation): boolean => level === 0;

/** Solo points let the AI choose the route from Swing up. */
export const solosActive = (level: Improvisation): boolean => level >= 2;

/** Independent takes per agent call. Executors act on the world, so they always play once. */
export function takesFor(level: Improvisation, role: Role): number {
  if (role !== 'assessor') return 1;
  return level >= 4 ? 3 : level >= 3 ? 2 : 1;
}
