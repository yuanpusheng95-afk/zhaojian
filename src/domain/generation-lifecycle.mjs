export const GENERATION_TRANSITIONS = new Map([
  ['queued', new Set(['preparing', 'failed', 'cancelled'])],
  ['preparing', new Set(['submitted', 'failed', 'cancelled'])],
  ['submitted', new Set(['provider_processing', 'failed', 'cancelled'])],
  ['provider_processing', new Set(['verifying', 'failed', 'cancelled'])],
  [
    'verifying',
    new Set(['completed', 'partial_failed', 'failed', 'cancelled']),
  ],
]);

export const TERMINAL_GENERATION_STATUSES = new Set([
  'completed',
  'partial_failed',
  'failed',
  'cancelled',
]);

export const SELECTABLE_GENERATION_STATUSES = new Set([
  'completed',
  'partial_failed',
]);
