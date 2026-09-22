/**
 * Core public types for pii-agent-kit.
 *
 * Source-of-truth interfaces consumed by detectors, engines, vault,
 * middleware hooks and framework adapters. All other modules import
 * from here rather than re-declaring shapes.
 */

/** A single PII detection span, produced by a detector and merged by the engine. */
export interface PiiMatch {
  /** Entity category, e.g. `EMAIL`, `SSN`, `PERSON`, `PHONE`. */
  type: string;
  /** Inclusive start offset in the source text. */
  start: number;
  /** Exclusive end offset in the source text. */
  end: number;
  /** Original substring that matched. */
  value: string;
  /** Which detector produced this match. */
  source: 'regex' | 'ner';
  /** Confidence in [0, 1]. Regex is 1.0 by default, NER is model output. */
  score?: number;
}

/** What to do with a PII match once detected. */
export type PiiAction = 'allow' | 'block' | 'redact' | 'mask' | 'hash' | 'vault';

/** Per-call detection tuning. */
export interface DetectOptions {
  /** Restrict to a subset of entity categories. */
  entityTypes?: string[];
  /** Drop matches below this score. Defaults to engine threshold. */
  minConfidence?: number;
  /** Language hint, e.g. `'en'`, `'zh'`. Forwarded to detectors. */
  language?: string;
}

/** Pluggable detector contract. Regex, NER, or hybrid implementations all conform. */
export interface PiiDetector {
  readonly name: string;
  readonly type: 'regex' | 'ner' | 'hybrid';
  detect(text: string, options?: DetectOptions): Promise<PiiMatch[]>;
  initialize?(): Promise<void>;
  isReady(): boolean;
}

/** Reversible tokenization surface used to swap PII out and back. */
export interface PiiVault {
  tokenize(value: string, type: string): string;
  restore(token: string): string | null;
  restoreText(text: string): string;
  restoreDeep(input: unknown): unknown;
  destroy(): void;
}

/** Single policy rule mapping an entity type to an action, optionally scoped. */
export interface PolicyRule {
  entityType: string;
  action: PiiAction;
  /** Scope qualifier: tool name, channel, or arbitrary tag. */
  scope?: string;
  /** Confidence threshold below which the rule does not fire. */
  threshold?: number;
}

export interface PolicyConfig {
  /** `enforce` applies actions; `monitor` only records matches. */
  mode: 'enforce' | 'monitor';
  defaultAction: PiiAction;
  rules: PolicyRule[];
}

/** Per-call context propagated through middleware hooks. */
export interface PiiMiddlewareContext {
  agentId: string;
  sessionId: string;
  channel: 'input' | 'output' | 'tool' | 'memory' | 'log';
  toolName?: string;
  /** Optional scope tag consumed by the policy engine. */
  scope?: string;
}

/**
 * Hooks fired at each interception point. All hooks return the (possibly
 * redacted) value to keep flowing downstream. A hook returning the input
 * unchanged is a valid no-op.
 */
export interface PiiMiddlewareHooks {
  onUserMessage?(message: string, ctx: PiiMiddlewareContext): Promise<string>;
  onModelInput?(messages: unknown, ctx: PiiMiddlewareContext): Promise<unknown>;
  beforeToolCall?(toolName: string, args: unknown, ctx: PiiMiddlewareContext): Promise<unknown>;
  afterToolCall?(toolName: string, result: unknown, ctx: PiiMiddlewareContext): Promise<unknown>;
  onAgentResponse?(response: string, ctx: PiiMiddlewareContext): Promise<string>;
  onMemoryWrite?(entry: unknown, ctx: PiiMiddlewareContext): Promise<unknown>;
  onLog?(entry: Record<string, unknown>, ctx: PiiMiddlewareContext): Promise<Record<string, unknown>>;
}

/** Audit receipt describing one PII event in the chain. */
export interface AuditReceipt {
  /** Monotonic counter within a session. */
  sequence: number;
  /** Hash of the previous receipt, or genesis for sequence 0. */
  prevHash: string;
  /** HMAC-SHA256 of receipt body. */
  hash: string;
  agentId: string;
  sessionId: string;
  channel: PiiMiddlewareContext['channel'];
  toolName?: string;
  matches: PiiMatch[];
  actions: Array<{ type: string; action: PiiAction }>;
  timestamp: string;
  textDigest: string;
  /** Truncated sample of the source text fed into the hash chain. */
  sample: string;
}

/** Custom regex pattern contributed to the regex detector. */
export interface CustomPattern {
  name: string;
  type: string;
  /** Either a regex source string or a compiled RegExp. */
  regex: string | RegExp;
  /** Confidence score assigned to matches (0..1). Defaults to 1.0. */
  score?: number;
  /** Optional validator function (e.g. Luhn for credit cards). */
  validate?: (value: string) => boolean;
}
