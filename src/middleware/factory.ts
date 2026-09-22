/**
 * Middleware factory — wires the detection engine, policy engine and vault
 * into a set of `PiiMiddlewareHooks` that any agent framework can call.
 *
 * Design notes:
 *   - All hooks share the same `(detect -> policy -> apply)` pipeline.
 *   - The action `block` rejects the input; callers must check for a
 *     `BlockedError` if they want to surface a user-friendly message.
 *   - Tokenized values use the session-scoped vault so restoration is
 *     confined to the same session.
 */

import type {
  DetectOptions,
  PiiAction,
  PiiMatch,
  PiiMiddlewareContext,
  PiiMiddlewareHooks,
  PiiVault,
} from '../types.js';
import { DetectionEngine } from '../engine/detection-engine.js';
import { PolicyEngine } from '../engine/policy-engine.js';
import { AuditLogger } from '../audit/receipt.js';
import { HashChain } from '../audit/hashchain.js';

export interface PiiMiddlewareOptions {
  detectionEngine: DetectionEngine;
  policyEngine: PolicyEngine;
  vault: PiiVault;
  auditLogger: AuditLogger;
  /** Default `DetectOptions` applied to every call. */
  detectOptions?: DetectOptions;
}

export class BlockedError extends Error {
  readonly matches: PiiMatch[];
  constructor(matches: PiiMatch[]) {
    super('Blocked: ' + matches.map((m) => `${m.type}@${m.start}-${m.end}`).join(','));
    this.name = 'BlockedError';
    this.matches = matches;
  }
}

/** Replace a span in `text` with `replacement`. */
function replace(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function transform(action: PiiAction, match: PiiMatch, vault: PiiVault): string {
  switch (action) {
    case 'allow':
      return match.value;
    case 'redact':
      return `[REDACTED:${match.type}]`;
    case 'mask':
      return '*'.repeat(Math.max(match.value.length, 4));
    case 'hash':
      return `[HASH:${HashChain.digest(match.value)}]`;
    case 'vault':
      return vault.tokenize(match.value, match.type);
    case 'block':
      return '[BLOCKED]';
  }
}

/**
 * Find detector matches that fall inside `text` (offsets match the literal
 * substring). Returns matches whose offsets correspond 1:1 to the original
 * string the detector was run against.
 */
function findApplicable(text: string, matches: PiiMatch[]): PiiMatch[] {
  return matches.filter((m) => m.start < text.length && text.slice(m.start, m.end) === m.value);
}

/**
 * Apply policy to a single string. Throws `BlockedError` if any match asks
 * to block. Returns the redacted string otherwise.
 */
function transformString(
  text: string,
  matches: PiiMatch[],
  actions: { type: string; action: PiiAction }[],
  vault: PiiVault,
): string {
  if (!text) return text;
  const applicable = findApplicable(text, matches);
  if (applicable.length === 0) return text;

  for (const m of applicable) {
    const action = actions.find((a) => a.type === m.type)?.action ?? 'redact';
    if (action === 'block') throw new BlockedError(matches);
  }

  const sorted = [...applicable].sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of sorted) {
    const action = actions.find((a) => a.type === m.type)?.action ?? 'redact';
    out = replace(out, m.start, m.end, transform(action, m, vault));
  }
  return out;
}

/**
 * Collect every string leaf in a JSON-shaped value. Returns `{text, path}`
 * tuples so we can run detection against each one independently and write
 * the transformed result back without offset mismatch.
 */
interface StringLeaf {
  text: string;
  path: Array<string | number>;
}

function collectStrings(input: unknown, path: Array<string | number> = []): StringLeaf[] {
  if (typeof input === 'string') return [{ text: input, path }];
  if (input === null || input === undefined) return [];
  if (Array.isArray(input)) {
    const out: StringLeaf[] = [];
    for (let i = 0; i < input.length; i++) {
      const child = input[i];
      if (child !== undefined) out.push(...collectStrings(child, [...path, i]));
    }
    return out;
  }
  if (typeof input === 'object') {
    const out: StringLeaf[] = [];
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out.push(...collectStrings(v, [...path, k]));
    }
    return out;
  }
  return [];
}

/** Set `path` inside `target` to `value`. Creates nested objects as needed. */
function setPath(target: unknown, path: Array<string | number>, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const arr = Array.isArray(target) ? [...target] : [];
    arr[head] = setPath(arr[head], rest, value);
    return arr;
  }
  const obj = target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  obj[head] = setPath(obj[head], rest, value);
  return obj;
}

/**
 * Run the full pipeline against a value: detect across each string leaf,
 * aggregate matches, resolve policy, apply per-leaf. Returns the rebuilt
 * value (original untouched).
 */
async function processValue(
  detectionEngine: DetectionEngine,
  policyEngine: PolicyEngine,
  vault: PiiVault,
  ctx: PiiMiddlewareContext,
  input: unknown,
  auditLogger: AuditLogger,
  detectOptions?: DetectOptions,
): Promise<unknown> {
  const leaves = collectStrings(input);
  if (leaves.length === 0) {
    // Audit even when there is nothing to detect so call sites are consistent.
    await auditLogger.record(ctx, [], [], HashChain.digest(''), '');
    if (policyEngine.mode === 'monitor') return input;
    return input;
  }

  // Run detection against every leaf and concatenate matches with a synthetic
  // offset shift so each leaf's offsets remain valid within its own string.
  const detections = await Promise.all(
    leaves.map(async (leaf) => {
      const matches = await detectionEngine.detect(leaf.text, detectOptions);
      return { leaf, matches };
    }),
  );

  const allMatches: PiiMatch[] = [];
  const leavesToTransform: Array<{ leaf: StringLeaf; matches: PiiMatch[] }> = [];
  for (const { leaf, matches } of detections) {
    if (matches.length === 0) continue;
    allMatches.push(...matches);
    leavesToTransform.push({ leaf, matches });
  }

  // Audit aggregate view (no offset shifting needed for the receipt).
  const actions = policyEngine.resolveAll(allMatches, {
    ...(ctx.toolName !== undefined ? { tool: ctx.toolName } : {}),
    channel: ctx.channel,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
  });
  await auditLogger.record(
    ctx,
    allMatches,
    actions,
    HashChain.digest(leaves.map((l) => l.text).join('\n')),
    leaves.map((l) => l.text).join('\n').slice(0, 200),
  );

  if (policyEngine.mode === 'monitor') return input;

  // Apply per-leaf. We must reject on block before transforming anything.
  for (const { matches } of leavesToTransform) {
    for (const m of matches) {
      const action = actions.find((a) => a.type === m.type)?.action ?? 'redact';
      if (action === 'block') throw new BlockedError(allMatches);
    }
  }

  let out: unknown = input;
  for (const { leaf, matches } of leavesToTransform) {
    const next = transformString(leaf.text, matches, actions, vault);
    out = setPath(out, leaf.path, next);
  }
  return out;
}

/** Public factory: build a `PiiMiddlewareHooks` instance from shared components. */
export function createPiiMiddleware(options: PiiMiddlewareOptions): PiiMiddlewareHooks {
  const { detectionEngine, policyEngine, vault, auditLogger, detectOptions } = options;

  return {
    async onUserMessage(message, ctx) {
      const out = await processValue(detectionEngine, policyEngine, vault, ctx, message, auditLogger, detectOptions);
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
    async onModelInput(messages, ctx) {
      return processValue(detectionEngine, policyEngine, vault, ctx, messages, auditLogger, detectOptions);
    },
    async beforeToolCall(toolName, args, ctx) {
      return processValue(detectionEngine, policyEngine, vault, { ...ctx, toolName }, args, auditLogger, detectOptions);
    },
    async afterToolCall(toolName, result, ctx) {
      const out = await processValue(detectionEngine, policyEngine, vault, { ...ctx, toolName, channel: 'tool' }, result, auditLogger, detectOptions);
      // Restore tokens so the model receives the real PII.
      return vault.restoreDeep(out);
    },
    async onAgentResponse(response, ctx) {
      const out = await processValue(detectionEngine, policyEngine, vault, { ...ctx, channel: 'output' }, response, auditLogger, detectOptions);
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
    async onMemoryWrite(entry, ctx) {
      return processValue(detectionEngine, policyEngine, vault, { ...ctx, channel: 'memory' }, entry, auditLogger, detectOptions);
    },
    async onLog(entry, ctx) {
      const out = await processValue(detectionEngine, policyEngine, vault, { ...ctx, channel: 'log' }, entry, auditLogger, detectOptions);
      return (out ?? entry) as Record<string, unknown>;
    },
  };
}
