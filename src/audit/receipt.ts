/**
 * Audit logger — emits tamper-evident receipts for every PII event.
 *
 * Each call to `record()` mints an `AuditReceipt` chained via `HashChain`.
 * The logger is intentionally synchronous so callers can `await` without
 * worrying about out-of-order writes.
 */

import type { AuditReceipt, PiiMatch, PiiMiddlewareContext } from '../types.js';
import type { ResolvedAction } from '../engine/policy-engine.js';
import { HashChain } from './hashchain.js';

export interface AuditLoggerOptions {
  /** HMAC key for the hash chain. Falls back to PII_AUDIT_KEY env. */
  key?: string;
  /** Sink function for receipts; defaults to console. */
  sink?: (receipt: AuditReceipt) => void | Promise<void>;
}

export class AuditLogger {
  private readonly chain: HashChain;
  private readonly sink: (receipt: AuditReceipt) => void | Promise<void>;
  private receipts: AuditReceipt[] = [];

  constructor(options: AuditLoggerOptions = {}) {
    this.chain = new HashChain(options.key);
    this.sink =
      options.sink ??
      ((r) => {
        // Default sink writes to stderr so logs don't pollute stdout-based tooling.
        process.stderr.write(JSON.stringify(r) + '\n');
      });
  }

  /**
   * Record a PII event. `text` is the original input (already processed),
   * `digest` is the SHA-256 prefix of the source text so receipts do not
   * contain the actual PII.
   */
  async record(
    ctx: PiiMiddlewareContext,
    matches: PiiMatch[],
    actions: ResolvedAction[],
    textDigest: string,
    sample: string,
  ): Promise<AuditReceipt> {
    const timestamp = new Date().toISOString();
    const body = serializeBody({
      ctx,
      matches,
      actions,
      textDigest,
      sample,
      timestamp,
    });
    const { hash, sequence, prevHash } = this.chain.next(body);
    const receipt: AuditReceipt = {
      sequence,
      prevHash,
      hash,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      channel: ctx.channel,
      ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
      matches,
      actions: actions.map((a) => ({ type: a.type, action: a.action })),
      timestamp,
      textDigest,
      sample,
    };
    this.receipts.push(receipt);
    await this.sink(receipt);
    return receipt;
  }

  /** Local receipt buffer (most recent N). Useful for tests. */
  recent(limit = 100): AuditReceipt[] {
    return this.receipts.slice(-limit);
  }

  /** Verify integrity of every receipt recorded so far. */
  verify(): boolean {
    const bodies = this.receipts.map((r) =>
      serializeBody({
        ctx: {
          agentId: r.agentId,
          sessionId: r.sessionId,
          channel: r.channel,
          ...(r.toolName !== undefined ? { toolName: r.toolName } : {}),
        },
        matches: r.matches,
        actions: r.actions,
        textDigest: r.textDigest,
        sample: r.sample,
        timestamp: r.timestamp,
      }),
    );
    return (
      HashChain.verify(
        this.receipts.map((r, i) => ({
          sequence: r.sequence,
          prevHash: r.prevHash,
          hash: r.hash,
          body: bodies[i] ?? '',
        })),
        (this.chain as unknown as { key: string }).key,
      ) === -1
    );
  }
}

/** Single source of truth for the body bytes fed into the hash chain. */
function serializeBody(input: {
  ctx: PiiMiddlewareContext;
  matches: PiiMatch[];
  actions: Array<{ type: string; action: string }>;
  textDigest: string;
  sample: string;
  timestamp: string;
}): string {
  return JSON.stringify({
    agentId: input.ctx.agentId,
    sessionId: input.ctx.sessionId,
    channel: input.ctx.channel,
    toolName: input.ctx.toolName,
    matches: input.matches.map((m) => ({ type: m.type, start: m.start, end: m.end, source: m.source, score: m.score })),
    actions: input.actions.map((a) => ({ type: a.type, action: a.action })),
    textDigest: input.textDigest,
    sample: input.sample,
    timestamp: input.timestamp,
  });
}
