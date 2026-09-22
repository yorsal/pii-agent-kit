import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/engine/policy-engine.js';
import type { PiiMatch, PolicyConfig } from '../src/types.js';

const cfg: PolicyConfig = {
  mode: 'enforce',
  defaultAction: 'allow',
  rules: [
    { entityType: 'EMAIL', action: 'vault' },
    { entityType: 'API_KEY', action: 'block' },
    { entityType: 'EMAIL', action: 'redact', scope: 'tool:search' },
  ],
};

describe('PolicyEngine', () => {
  const engine = new PolicyEngine(cfg);
  const emailMatch: PiiMatch = { type: 'EMAIL', start: 0, end: 1, value: 'x', source: 'regex' };

  it('returns default action when no rule matches', () => {
    const m: PiiMatch = { type: 'IP_ADDRESS', start: 0, end: 1, value: 'x', source: 'regex' };
    expect(engine.resolve(m).action).toBe('allow');
  });

  it('respects scoped rules over global rules', () => {
    const scope = engine.resolve(emailMatch, { tool: 'search' });
    expect(scope.action).toBe('redact');
    const global = engine.resolve(emailMatch, { tool: 'other' });
    expect(global.action).toBe('vault');
  });

  it('enforces threshold on a rule', () => {
    const e = new PolicyEngine({
      mode: 'enforce',
      defaultAction: 'allow',
      rules: [{ entityType: 'PERSON', action: 'redact', threshold: 0.9 }],
    });
    const low: PiiMatch = { type: 'PERSON', start: 0, end: 1, value: 'x', source: 'ner', score: 0.5 };
    const high: PiiMatch = { type: 'PERSON', start: 0, end: 1, value: 'x', source: 'ner', score: 0.95 };
    expect(e.resolve(low).action).toBe('allow');
    expect(e.resolve(high).action).toBe('redact');
  });
});
