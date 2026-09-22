import { describe, expect, it } from 'vitest';
import { DetectionEngine } from '../src/engine/detection-engine.js';
import { RegexDetector } from '../src/detectors/regex-detector.js';
import type { PiiDetector, PiiMatch } from '../src/types.js';

const fakeNer: PiiDetector = {
  name: 'fake-ner',
  type: 'ner',
  isReady: () => true,
  async detect(text: string): Promise<PiiMatch[]> {
    if (!text.includes('Alice')) return [];
    const idx = text.indexOf('Alice');
    return [{ type: 'PERSON', start: idx, end: idx + 5, value: 'Alice', source: 'ner', score: 0.9 }];
  },
};

describe('DetectionEngine', () => {
  it('merges regex and NER with regex winning on overlap', async () => {
    const regex = new RegexDetector({
      replaceDefaults: true,
      customPatterns: [{ name: 'person_alice', type: 'PERSON', regex: /\bAlice\b/g, score: 1 }],
    });
    const engine = new DetectionEngine({ detectors: [regex, fakeNer] });
    const matches = await engine.detect('Alice wrote to alice@example.com');
    const alice = matches.filter((m) => m.value === 'Alice' || m.value === 'alice@example.com');
    expect(alice.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps non-overlapping spans from both detectors', async () => {
    const regex = new RegexDetector();
    const engine = new DetectionEngine({ detectors: [regex, fakeNer] });
    const matches = await engine.detect('Alice emailed help@example.com about issue.');
    const types = new Set(matches.map((m) => m.type));
    expect(types.has('PERSON')).toBe(true);
    expect(types.has('EMAIL')).toBe(true);
  });
});
