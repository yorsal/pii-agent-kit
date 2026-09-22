/**
 * Policy engine — maps `(entityType, scope)` tuples to a `PiiAction`.
 *
 * Rules can be global (no `scope`) or scoped (e.g. a specific tool name).
 * When multiple rules match, the most specific scope wins; ties resolve
 * to the rule declared first in the config.
 *
 * In `monitor` mode the engine still returns actions but the caller is
 * expected to use them for logging only.
 */

import type { PiiAction, PiiMatch, PolicyConfig, PolicyRule } from '../types.js';

export interface ResolvedAction {
  type: string;
  action: PiiAction;
  rule: PolicyRule | null;
}

/** Concrete scope tags we recognise. Anything else falls through to global. */
const SCOPED_KEYS: Array<'tool' | 'channel' | 'agent' | 'session'> = [
  'tool',
  'channel',
  'agent',
  'session',
];

export class PolicyEngine {
  private readonly config: PolicyConfig;
  private readonly rulesByType: Map<string, PolicyRule[]>;

  constructor(config: PolicyConfig) {
    this.config = config;
    this.rulesByType = new Map();
    for (const r of config.rules) {
      const list = this.rulesByType.get(r.entityType) ?? [];
      list.push(r);
      this.rulesByType.set(r.entityType, list);
    }
  }

  /** Whether the engine is in `enforce` mode (apply actions) or just record. */
  get mode(): PolicyConfig['mode'] {
    return this.config.mode;
  }

  /** Action for a single match, given the surrounding context. */
  resolve(match: PiiMatch, scope?: { tool?: string; channel?: string; agentId?: string; sessionId?: string; agent?: string; session?: string }): ResolvedAction {
    const candidates = this.rulesByType.get(match.type) ?? [];
    let best: PolicyRule | null = null;
    let bestScore = -1;

    for (const r of candidates) {
      const s = scopeScore(r, scope);
      if (s < 0) continue;
      if (typeof r.threshold === 'number' && (match.score ?? 1) < r.threshold) continue;
      if (s > bestScore || (s === bestScore && best && rulesOrder(this.config, r) < rulesOrder(this.config, best))) {
        best = r;
        bestScore = s;
      }
    }

    return {
      type: match.type,
      action: best?.action ?? this.config.defaultAction,
      rule: best,
    };
  }

  /** Batch resolve a list of matches. */
  resolveAll(matches: PiiMatch[], scope?: Parameters<PolicyEngine['resolve']>[1]): ResolvedAction[] {
    return matches.map((m) => this.resolve(m, scope));
  }
}

/** Specificity score: higher is better. -1 means rule does not apply. */
function scopeScore(rule: PolicyRule, scope?: { tool?: string; channel?: string; agentId?: string; sessionId?: string; agent?: string; session?: string }): number {
  if (!rule.scope) return 0; // global rule, always matches
  if (!scope) return -1; // no scope to compare against

  for (const key of SCOPED_KEYS) {
    const ruleScope = readScopePrefix(rule.scope, key);
    if (ruleScope === undefined) continue;
    const actual = scope[key] ?? (key === 'agent' ? scope.agentId : key === 'session' ? scope.sessionId : undefined);
    if (ruleScope === actual) return 10 + SCOPED_KEYS.indexOf(key);
    return -1; // scope mismatch
  }
  return -1;
}

/** Parse scope strings like `tool:search` or `channel:output`. */
function readScopePrefix(scope: string, key: string): string | undefined {
  const prefix = `${key}:`;
  if (!scope.startsWith(prefix)) return undefined;
  return scope.slice(prefix.length);
}

/** Declared order in the original config — used as a tie-breaker. */
function rulesOrder(config: PolicyConfig, r: PolicyRule): number {
  return config.rules.indexOf(r);
}
