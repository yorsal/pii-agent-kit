/**
 * Public entry point for `pii-agent-kit`.
 *
 * Consumers should import from here rather than reaching into internal
 * modules — subpath exports under `./adapters/*` are for adapter-specific
 * usage and may have heavier dependencies.
 */

// Core types — re-exported for ergonomic single-import usage.
export type {
  PiiMatch,
  PiiAction,
  DetectOptions,
  PiiDetector,
  PiiVault,
  PolicyRule,
  PolicyConfig,
  PiiMiddlewareContext,
  PiiMiddlewareHooks,
  CustomPattern,
  AuditReceipt,
} from './types.js';

// Detection layer.
export { RegexDetector } from './detectors/regex-detector.js';
export type { RegexDetectorOptions } from './detectors/regex-detector.js';
export { NerDetector, RemoteNerDetector } from './detectors/ner-detector.js';
export type { NerDetectorOptions, RemoteNerDetectorOptions, RemoteNerFormat } from './detectors/ner-detector.js';
export { mergeMatches } from './detectors/merge.js';
export type { MergeDecision } from './detectors/merge.js';

// Engines.
export { DetectionEngine } from './engine/detection-engine.js';
export type { DetectionEngineOptions } from './engine/detection-engine.js';
export { PolicyEngine } from './engine/policy-engine.js';
export type { ResolvedAction } from './engine/policy-engine.js';

// Vault.
export { PiiTokenVault } from './vault/vault.js';
export type { VaultOptions } from './vault/vault.js';
export { createFlareVault } from './vault/flare-vault-adapter.js';
export type { FlareAdapterOptions, VaultEngine } from './vault/flare-vault-adapter.js';

// Middleware.
export { createPiiMiddleware, BlockedError } from './middleware/factory.js';
export type { PiiMiddlewareOptions } from './middleware/factory.js';

// Audit.
export { AuditLogger } from './audit/receipt.js';
export type { AuditLoggerOptions } from './audit/receipt.js';
export { HashChain } from './audit/hashchain.js';

/** Convenience: build a fully-wired middleware with sane defaults. */
import { DetectionEngine } from './engine/detection-engine.js';
import { PolicyEngine } from './engine/policy-engine.js';
import { PiiTokenVault } from './vault/vault.js';
import { AuditLogger } from './audit/receipt.js';
import { createPiiMiddleware } from './middleware/factory.js';
import { RegexDetector } from './detectors/regex-detector.js';
import { NerDetector } from './detectors/ner-detector.js';
import type { NerDetectorOptions } from './detectors/ner-detector.js';
import type { PiiDetector, PiiMiddlewareHooks } from './types.js';
import type { RegexDetectorOptions } from './detectors/regex-detector.js';
import type { PolicyConfig } from './types.js';

export interface BuildKitOptions {
  regex?: RegexDetectorOptions;
  ner?: NerDetectorOptions | false;
  policy: PolicyConfig;
  sessionKey?: string;
  auditKey?: string;
}

/**
 * Construct a ready-to-use middleware with regex (always on) and NER (opt-in).
 * For tests, `ner: false` keeps the surface synchronous.
 */
export function buildPiiKit(options: BuildKitOptions): {
  hooks: PiiMiddlewareHooks;
  detectionEngine: DetectionEngine;
  policyEngine: PolicyEngine;
  vault: PiiTokenVault;
  audit: AuditLogger;
} {
  const regex = new RegexDetector(options.regex ?? {});
  const detectors: PiiDetector[] = [regex];
  if (options.ner !== false) {
    detectors.push(new NerDetector(options.ner ?? {}));
  }
  const detectionEngine = new DetectionEngine({ detectors });
  const policyEngine = new PolicyEngine(options.policy);
  const vault = new PiiTokenVault({ sessionKey: options.sessionKey });
  const audit = new AuditLogger({ ...(options.auditKey !== undefined ? { key: options.auditKey } : {}) });
  const hooks = createPiiMiddleware({ detectionEngine, policyEngine, vault, auditLogger: audit });
  return { hooks, detectionEngine, policyEngine, vault, audit };
}
