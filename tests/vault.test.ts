import { describe, expect, it } from 'vitest';
import { PiiTokenVault } from '../src/vault/vault.js';

describe('PiiTokenVault', () => {
  it('tokenizes and restores a value', () => {
    const vault = new PiiTokenVault();
    const token = vault.tokenize('jane@example.com', 'EMAIL');
    expect(token).toMatch(/EMAIL/);
    expect(vault.restore(token)).toBe('jane@example.com');
  });

  it('produces deterministic tokens for the same input', () => {
    const v1 = new PiiTokenVault();
    const v2 = new PiiTokenVault();
    expect(v1.tokenize('foo', 'NAME')).not.toBe(v2.tokenize('foo', 'NAME'));
    // Same session: deterministic.
    expect(v1.tokenize('foo', 'NAME')).toBe(v1.tokenize('foo', 'NAME'));
  });

  it('restores nested objects', () => {
    const vault = new PiiTokenVault();
    const token = vault.tokenize('123-45-6789', 'SSN');
    const input = {
      user: { id: 1, ssn: token, history: [{ ssn: token, when: '2024-01-01' }] },
    };
    const restored = vault.restoreDeep(input) as typeof input;
    expect(restored.user.ssn).toBe('123-45-6789');
    expect(restored.user.history[0]?.ssn).toBe('123-45-6789');
  });

  it('round-trips multiple tokens in one string', () => {
    const vault = new PiiTokenVault();
    const a = vault.tokenize('a@example.com', 'EMAIL');
    const b = vault.tokenize('b@example.com', 'EMAIL');
    const text = `from ${a} to ${b}`;
    expect(vault.restoreText(text)).toBe('from a@example.com to b@example.com');
  });
});
