/**
 * Re-export the middleware hook types so adapter packages can depend on
 * the same surface without reaching into the central types module.
 */
export type {
  PiiMiddlewareContext,
  PiiMiddlewareHooks,
  PiiMatch,
  PiiAction,
  PiiDetector,
  PiiVault,
  PolicyRule,
  PolicyConfig,
} from '../types.js';
