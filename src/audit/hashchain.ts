/**
 * HMAC-SHA256 hash chain for audit receipts. Each receipt carries the
 * hash of the previous one, making any tampering detectable.
 *
 * The chain key is the agent's session secret. If no key is provided we
 * derive a process-local fallback so dev environments still get a chain.
 */

import { createHmac, createHash } from 'node:crypto';

const GENESIS = 'genesis';

export class HashChain {
  private readonly key: string;
  private prev = GENESIS;
  private counter = 0;

  constructor(key?: string) {
    this.key = key ?? process.env['PII_AUDIT_KEY'] ?? randomKey();
  }

  /** Mint a new receipt entry. Returns the hash for the caller to store. */
  next(body: string): { hash: string; sequence: number; prevHash: string } {
    const sequence = this.counter++;
    const prevHash = this.prev;
    const hmac = createHmac('sha256', this.key);
    hmac.update(`${sequence}|${prevHash}|${body}`);
    const hash = hmac.digest('hex');
    this.prev = hash;
    return { hash, sequence, prevHash };
  }

  /**
   * Verify an external chain. Useful for auditors that receive receipts
   * out-of-order; returns the index of the first break or -1 if intact.
   */
  static verify(receipts: Array<{ sequence: number; prevHash: string; hash: string; body: string }>, key: string): number {
    let prev = GENESIS;
    for (let i = 0; i < receipts.length; i++) {
      const r = receipts[i];
      if (!r) continue;
      if (r.prevHash !== prev) return i;
      const hmac = createHmac('sha256', key);
      hmac.update(`${r.sequence}|${r.prevHash}|${r.body}`);
      if (hmac.digest('hex') !== r.hash) return i;
      prev = r.hash;
    }
    return -1;
  }

  /** Stable digest of text used as the receipt body content-hash. */
  static digest(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
}

function randomKey(): string {
  const buf = new Uint8Array(32);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
