/**
 * Re-export the detector contract from the central types module so callers
 * can `import { PiiDetector } from 'pii-agent-kit/detectors/detector'` without
 * reaching into the internals.
 */
export type { PiiDetector, PiiMatch, DetectOptions } from '../types.js';
