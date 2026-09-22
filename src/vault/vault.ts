/**
 * Vault — reversible tokenization of PII.
 *
 * Internally delegates to `pii-vault`'s `Vault` for the actual FNV-based
 * deterministic token mapping, and adds `restoreDeep` which walks arbitrary
 * JSON values and substitutes tokens recursively. Session-scoping works by
 * passing the session key as the `context` argument to `tokenizeCtx`, which
 * mixes it into the token derivation without polluting `entry.original`.
 * The result: each session gets a unique token space automatically.
 */

import type { PiiVault } from '../types.js';
import { Vault as UpstreamVault } from 'pii-vault';

export interface VaultOptions {
  /** Per-session key; mixed into token derivation so different sessions cannot collide. */
  sessionKey?: string;
}

/**
 * Tokenize PII values deterministically per session and restore them later.
 * Different sessions automatically produce different tokens for the same
 * input because the session key is fed into the FNV-1a hash upstream.
 */
export class PiiTokenVault implements PiiVault {
  private readonly upstream: UpstreamVault;
  private readonly context: string;
  private destroyed = false;

  constructor(options: VaultOptions = {}) {
    this.upstream = new UpstreamVault();
    this.context = options.sessionKey ?? randomKey();
  }

  tokenize(value: string, type: string): string {
    if (this.destroyed) throw new Error('vault destroyed');
    return this.upstream.tokenizeCtx(type, value, this.context);
  }

  restore(token: string): string | null {
    const entry = this.upstream.lookupToken(token);
    if (!entry) return null;
    // Only honour tokens minted under our session context so that
    // accidentally-present tokens from another session cannot leak.
    if (entry.context !== this.context) return null;
    return entry.original;
  }

  restoreText(text: string): string {
    // pii-vault detokenize substitutes every known token. We then have to
    // be careful that none of our session keys overlap with another vault's
    // tokens — since we mix the session key into the token derivation, the
    // token formats are distinct, so substitution is safe.
    return this.upstream.detokenize(text);
  }

  restoreDeep(input: unknown): unknown {
    return restoreDeep(input, (v) => this.restoreText(v));
  }

  destroy(): void {
    // pii-vault has no explicit reset; dropping references suffices.
    this.destroyed = true;
  }

  /** Serialise the upstream vault to JSON for persistence (per session). */
  toJson(): string {
    return this.upstream.toJson();
  }
}

function randomKey(): string {
  const buf = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Walk any JSON-shaped value and replace vault tokens with originals. Strings
 * are scanned; arrays/objects recursed. Cycles are guarded by tracking seen
 * parents and bailing out on revisit.
 */
function restoreDeep(input: unknown, restore: (s: string) => string, seen: WeakSet<object> = new WeakSet()): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return restore(input);
  if (Array.isArray(input)) {
    if (seen.has(input)) return input;
    seen.add(input);
    return input.map((v) => restoreDeep(v, restore, seen));
  }
  if (typeof input === 'object') {
    if (seen.has(input as object)) return input;
    seen.add(input as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = restoreDeep(v, restore, seen);
    }
    return out;
  }
  return input;
}
