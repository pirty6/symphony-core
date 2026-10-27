/**
 * Shape validation for state values and AI responses. Pure.
 * Every agent response must pass `validateNodeResult` before the engine
 * lets it touch state.
 */
import type { FieldType, MoveVerdict, NodeResult, StateField } from './types.js';
import { FIELD_TYPES } from './types.js';

export const RESERVED_NAMES: readonly string[] = ['state', 'verdict', 'true', 'false', 'null'];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidFieldName(name: string): boolean {
  return IDENT.test(name) && !RESERVED_NAMES.includes(name);
}

export function zeroValue(type: FieldType): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string[]':
    case 'number[]':
      return [];
    case 'object':
      return {};
  }
}

export function checkValue(type: FieldType, value: unknown): string | undefined {
  const got = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  switch (type) {
    case 'string':
    case 'boolean':
      return typeof value === type ? undefined : `expected ${type}, got ${got}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? undefined
        : `expected finite number, got ${got}`;
    case 'string[]':
    case 'number[]': {
      if (!Array.isArray(value)) return `expected ${type}, got ${got}`;
      const inner = type === 'string[]' ? 'string' : 'number';
      const bad = value.findIndex((v) => typeof v !== inner);
      return bad === -1 ? undefined : `expected ${type}, item ${bad} is ${typeof value[bad]}`;
    }
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? undefined
        : `expected object, got ${got}`;
  }
}

export function isFieldType(t: unknown): t is FieldType {
  return typeof t === 'string' && (FIELD_TYPES as readonly string[]).includes(t);
}

export function validateVerdict(v: unknown): string[] {
  if (v === null || typeof v !== 'object') return ['verdict must be an object'];
  const r = v as Record<string, unknown>;
  const errors: string[] = [];
  if (!['applied', 'failed', 'skipped'].includes(r.outcome as string)) {
    errors.push(`verdict.outcome must be applied|failed|skipped, got ${JSON.stringify(r.outcome)}`);
  }
  if (
    typeof r.confidence !== 'number' ||
    Number.isNaN(r.confidence) ||
    r.confidence < 0 ||
    r.confidence > 1
  ) {
    errors.push('verdict.confidence must be a number in [0,1]');
  }
  if (typeof r.shouldTerminate !== 'boolean')
    errors.push('verdict.shouldTerminate must be boolean');
  if (typeof r.reason !== 'string') errors.push('verdict.reason must be a string');
  return errors;
}

/** Validate updates against the allowed fields; unknown keys are rejected. */
export function validateUpdates(
  updates: unknown,
  allowed: readonly StateField[],
  requireAll: boolean,
): string[] {
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    return ['updates must be an object'];
  }
  const errors: string[] = [];
  const byName = new Map(allowed.map((f) => [f.name, f]));
  for (const [k, v] of Object.entries(updates)) {
    const field = byName.get(k);
    if (!field) {
      errors.push(
        `updates.${k} is not writable here (allowed: ${[...byName.keys()].join(', ') || 'none'})`,
      );
      continue;
    }
    const err = checkValue(field.type, v);
    if (err) errors.push(`updates.${k}: ${err}`);
  }
  if (requireAll) {
    for (const f of allowed) {
      if (!(f.name in (updates as object))) errors.push(`updates.${f.name} is required`);
    }
  }
  return errors;
}

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: string[] };

export function validateNodeResult(
  raw: unknown,
  writes: readonly StateField[],
): Checked<NodeResult> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['result must be an object with { updates, verdict }'] };
  }
  const r = raw as Record<string, unknown>;
  const verdictErrors = validateVerdict(r.verdict);
  if (verdictErrors.length > 0) return { ok: false, errors: verdictErrors };
  const verdict = r.verdict as MoveVerdict;
  const updates = r.updates ?? {};
  const errors = validateUpdates(updates, writes, verdict.outcome === 'applied');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { updates: updates as Record<string, unknown>, verdict },
  };
}

function jsonProp(f: StateField): Record<string, unknown> {
  const base: Record<string, unknown> = (() => {
    switch (f.type) {
      case 'string[]':
        return { type: 'array', items: { type: 'string' } };
      case 'number[]':
        return { type: 'array', items: { type: 'number' } };
      default:
        return { type: f.type };
    }
  })();
  return f.description ? { ...base, description: f.description } : base;
}

/** JSON Schema for an agent node's `submit_result` tool. */
export function resultJsonSchema(writes: readonly StateField[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      updates: {
        type: 'object',
        properties: Object.fromEntries(writes.map((f) => [f.name, jsonProp(f)])),
        required: writes.map((f) => f.name),
        additionalProperties: false,
      },
      verdict: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['applied', 'failed', 'skipped'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          shouldTerminate: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['outcome', 'confidence', 'shouldTerminate', 'reason'],
        additionalProperties: false,
      },
    },
    required: ['updates', 'verdict'],
    additionalProperties: false,
  };
}

/** Parse a human-typed string into a value of `type` (CLI flags and studio forms). */
export function parseFieldInput(type: FieldType, raw: string): unknown {
  const t = raw.trim();
  switch (type) {
    case 'number':
      return t === '' ? 0 : Number(t);
    case 'boolean':
      return /^(true|yes|y|1)$/i.test(t);
    case 'string[]':
    case 'number[]': {
      if (t === '') return [];
      const items = t.startsWith('[')
        ? (JSON.parse(t) as unknown[])
        : t
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      return type === 'number[]' ? items.map(Number) : items.map(String);
    }
    case 'object':
      return t === '' ? {} : (JSON.parse(t) as unknown);
    default:
      return raw;
  }
}

/** Inverse of parseFieldInput, for pre-filling inputs. */
export function formatFieldInput(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value === undefined || value === null ? '' : String(value);
}
