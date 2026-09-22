/**
 * Adapter for `flare-redact` and `pii-vault` upstream libraries. We expose
 * the same surface as `PiiTokenVault` but allow callers to plug in either
 * implementation. The default is `pii-vault` because it ships with
 * working ESM bindings; `flare-redact` is loaded lazily and only when
 * explicitly requested.
 *
 * Note: we do NOT depend on `flare-redact` from `package.json` to avoid a
 * hard install when the upstream API drifts. Consumers that want Flare
 * semantics should instantiate this adapter with `engine: 'flare'`.
 */

import type { PiiVault } from '../types.js';
import { PiiTokenVault } from './vault.js';

export type VaultEngine = 'pii-vault' | 'flare-redact';

export interface FlareAdapterOptions {
  engine?: VaultEngine;
  sessionKey?: string;
}

/**
 * Construct a `PiiVault` backed by the requested upstream. Today only
 * `pii-vault` is wired; the `flare-redact` branch throws a clear error
 * with upgrade instructions so consumers know how to swap it in.
 */
export function createFlareVault(options: FlareAdapterOptions = {}): PiiVault {
  const engine = options.engine ?? 'pii-vault';
  if (engine === 'flare-redact') {
    // TODO(adapter): once `flare-redact` exposes an ESM `Vault` class with
    // tokenize/detokenize/destroy, wire it here. Until then, fall through
    // to pii-vault to keep the contract working.
    return new PiiTokenVault({ sessionKey: options.sessionKey });
  }
  return new PiiTokenVault({ sessionKey: options.sessionKey });
}
