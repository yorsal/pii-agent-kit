/**
 * Detection engine — orchestrates one or more `PiiDetector`s and merges
 * their outputs through `mergeMatches`. NER is only triggered when at
 * least one of the requested entity types is not strictly regex-only;
 * callers can pass `nerEnabled: false` to skip it entirely.
 */

import type { DetectOptions, PiiDetector, PiiMatch } from '../types.js';
import { mergeMatches } from '../detectors/merge.js';

export interface DetectionEngineOptions {
  detectors: PiiDetector[];
  /** Default confidence floor applied when callers do not specify one. */
  minConfidence?: number;
  /** Whether to run NER detectors. Defaults to true. */
  nerEnabled?: boolean;
  /** Drop NER results whose entity type the regex layer already covers. */
  nerForUnknownTypesOnly?: boolean;
}

export class DetectionEngine {
  private readonly detectors: PiiDetector[];
  private readonly minConfidence: number;
  private readonly nerEnabled: boolean;
  private readonly nerForUnknownTypesOnly: boolean;

  /** Cached set of entity types the regex layer is known to cover. */
  private readonly regexEntityTypes: Set<string>;

  constructor(options: DetectionEngineOptions) {
    if (options.detectors.length === 0) {
      throw new Error('DetectionEngine requires at least one detector');
    }
    this.detectors = options.detectors;
    this.minConfidence = options.minConfidence ?? 0.6;
    this.nerEnabled = options.nerEnabled ?? true;
    this.nerForUnknownTypesOnly = options.nerForUnknownTypesOnly ?? false;

    this.regexEntityTypes = new Set<string>();
    for (const d of this.detectors) {
      if (d.type === 'regex') {
        // Probe the detector with a sentinel text so we can observe the
        // entity types it knows about without a separate registry.
        // Fire-and-forget; the result feeds into the cache lazily.
        void d
          .detect('probe@example.com 192.168.0.1 4111-1111-1111-1111')
          .then((ms) => {
            for (const m of ms) this.regexEntityTypes.add(m.type);
          })
          .catch(() => undefined);
      }
    }
  }

  /** Run all detectors and return a merged, deduplicated set of matches. */
  async detect(text: string, options?: DetectOptions): Promise<PiiMatch[]> {
    const merged = await this.detectWithMeta(text, options);
    return merged.kept;
  }

  /** Same as `detect`, but also returns the dropped candidates. */
  async detectWithMeta(text: string, options?: DetectOptions): Promise<ReturnType<typeof mergeMatches>> {
    const minConfidence = options?.minConfidence ?? this.minConfidence;
    const requested = options?.entityTypes;
    const detectorOptions: DetectOptions = { ...options, minConfidence };

    const results = await Promise.all(
      this.detectors.map(async (d) => {
        if (d.type !== 'regex' && !this.nerEnabled) return [];
        if (d.type === 'ner' && this.nerForUnknownTypesOnly && requested) {
          // Skip NER for entity types regex already covers.
          const unknown = requested.filter((t) => !this.regexEntityTypes.has(t));
          if (unknown.length === 0) return [];
          return d.detect(text, { ...detectorOptions, entityTypes: unknown });
        }
        return d.detect(text, detectorOptions);
      }),
    );

    return mergeMatches(results.flat());
  }

  /** Returns whether any detector is fully initialized and ready. */
  isReady(): boolean {
    return this.detectors.every((d) => d.isReady());
  }
}
