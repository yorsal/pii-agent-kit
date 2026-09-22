import { describe, expect, it } from 'vitest';
import { RegexDetector } from '../src/detectors/regex-detector.js';

describe('RegexDetector', () => {
  const detector = new RegexDetector();

  it('detects email addresses', async () => {
    const matches = await detector.detect('contact me at jane.doe@example.com');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.type).toBe('EMAIL');
    expect(matches[0]?.value).toBe('jane.doe@example.com');
  });

  it('detects US SSNs', async () => {
    const matches = await detector.detect('My SSN is 123-45-6789');
    expect(matches.length).toBeGreaterThan(0);
    const ssn = matches.find((m) => m.type === 'SSN');
    expect(ssn).toBeDefined();
  });

  it('validates credit card with Luhn', async () => {
    const visa = '4111 1111 1111 1111';
    const bad = '4111 1111 1111 1112';
    expect((await detector.detect(visa)).some((m) => m.type === 'CREDIT_CARD')).toBe(true);
    expect((await detector.detect(bad)).some((m) => m.type === 'CREDIT_CARD')).toBe(false);
  });

  it('detects IPv4 addresses', async () => {
    const matches = await detector.detect('Server 10.0.0.1 responded');
    expect(matches.some((m) => m.type === 'IP_ADDRESS')).toBe(true);
  });

  it('detects API keys', async () => {
    const openai = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const matches = await detector.detect(openai);
    expect(matches.some((m) => m.type === 'API_KEY')).toBe(true);
  });

  it('detects Chinese phone numbers', async () => {
    const matches = await detector.detect('call 13800138000');
    expect(matches.some((m) => m.type === 'PHONE')).toBe(true);
  });

  it('supports custom patterns', async () => {
    const custom = new RegexDetector({
      replaceDefaults: true,
      customPatterns: [
        { name: 'employee_id', type: 'EMPLOYEE_ID', regex: /\bEMP-\d{6}\b/g, score: 0.9 },
      ],
    });
    const matches = await custom.detect('see EMP-123456 for details');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.type).toBe('EMPLOYEE_ID');
  });

  it('filters by entityTypes', async () => {
    const matches = await detector.detect('foo@bar.com 192.168.0.1', { entityTypes: ['EMAIL'] });
    expect(matches.every((m) => m.type === 'EMAIL')).toBe(true);
  });
});
