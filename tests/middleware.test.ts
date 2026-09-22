import { describe, expect, it, beforeEach } from 'vitest';
import { buildPiiKit } from '../src/index.js';
import { BlockedError } from '../src/middleware/factory.js';
import type { PolicyConfig } from '../src/types.js';

const policy: PolicyConfig = {
  mode: 'enforce',
  defaultAction: 'redact',
  rules: [
    { entityType: 'API_KEY', action: 'block' },
    { entityType: 'EMAIL', action: 'vault' },
  ],
};

describe('PII Middleware', () => {
  let kit: ReturnType<typeof buildPiiKit>;

  beforeEach(() => {
    kit = buildPiiKit({ policy, ner: false });
  });

  it('redacts emails via vault tokens on user input', async () => {
    const out = await kit.hooks.onUserMessage!('ping me at jane@example.com', {
      agentId: 'a',
      sessionId: 's',
      channel: 'input',
    });
    expect(out).toContain('[EMAIL:');
    expect(out).not.toContain('jane@example.com');
  });

  it('blocks API keys', async () => {
    await expect(
      kit.hooks.onUserMessage!(
        'use key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
        { agentId: 'a', sessionId: 's', channel: 'input' },
      ),
    ).rejects.toBeInstanceOf(BlockedError);
  });

  it('round-trips tool arguments', async () => {
    const args = { name: 'jane', email: 'jane@example.com' };
    const out = (await kit.hooks.beforeToolCall!('sendEmail', args, {
      agentId: 'a',
      sessionId: 's',
      channel: 'tool',
      toolName: 'sendEmail',
    })) as typeof args;
    expect(out.name).toBe('jane');
    expect(out.email).toContain('[EMAIL:');
    expect(out.email).not.toContain('@example.com');
  });

  it('restores PII on tool results', async () => {
    const token = kit.vault.tokenize('jane@example.com', 'EMAIL');
    const result = { ok: true, recipient: token };
    const restored = (await kit.hooks.afterToolCall!('sendEmail', result, {
      agentId: 'a',
      sessionId: 's',
      channel: 'tool',
      toolName: 'sendEmail',
    })) as typeof result;
    expect(restored.recipient).toBe('jane@example.com');
  });

  it('emits an audit receipt per call', async () => {
    await kit.hooks.onUserMessage!('email me at jane@example.com', {
      agentId: 'a',
      sessionId: 's',
      channel: 'input',
    });
    const receipts = kit.audit.recent();
    expect(receipts.length).toBe(1);
    expect(kit.audit.verify()).toBe(true);
  });
});
