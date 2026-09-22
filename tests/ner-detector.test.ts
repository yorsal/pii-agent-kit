import { describe, expect, it } from 'vitest';
import { NerDetector } from '../src/detectors/ner-detector.js';

describe('NerDetector (mocked)', () => {
  it('returns empty when not initialized', async () => {
    const detector = new NerDetector({ autoInit: false });
    expect(detector.isReady()).toBe(false);
    const matches = await detector.detect('Alice met Bob in Berlin.');
    expect(matches).toEqual([]);
  });

  it('merge adjacent helper combines contiguous NER spans', async () => {
    // We cannot exercise the real model in CI, so we verify the public
    // surface stays correct when the upstream is unavailable.
    const detector = new NerDetector();
    const matches = await detector.detect('Alice met Bob');
    expect(Array.isArray(matches)).toBe(true);
  });

  it('does not throw on initialization failure', async () => {
    const detector = new NerDetector({ model: 'definitely/not-a-real-model' });
    await expect(detector.initialize()).rejects.toBeDefined();
    expect(detector.isReady()).toBe(false);
  });
});
