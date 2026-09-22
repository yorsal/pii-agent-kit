/**
 * Multi-PII demo — runs without installing a framework.
 *
 * Demonstrates every policy action across the entity types the regex layer
 * detects by default, and exercises the four PII boundaries in one pass:
 *
 *   user    ──► agent    (onUserMessage)
 *   agent   ──► model    (wrapModelCall)
 *   tool    ──► handler  (wrapToolCall + vault.restoreDeep)
 *   tool    ──► user     (onAgentResponse)
 *
 * Run: pnpm tsx examples/multi-pii-demo.ts
 */

import { buildPiiKit } from '../src/index.js';
import { createLangChainAdapter } from '../src/adapters/langchain.js';

// One rule per entity type. Coverage:
//   vault   (reversible token)        — EMAIL, CREDIT_CARD
//   mask    (length-preserving)       — PHONE
//   redact  ([REDACTED:TYPE])         — SSN, IP_ADDRESS, IBAN
//   block   (refuse, throws)         — CN_ID_CARD, API_KEY
const kit = buildPiiKit({
  policy: {
    mode: 'enforce',
    defaultAction: 'redact',
    rules: [
      { entityType: 'EMAIL', action: 'vault' },
      { entityType: 'CREDIT_CARD', action: 'vault' },
      { entityType: 'PHONE', action: 'mask' },
      { entityType: 'SSN', action: 'redact' },
      { entityType: 'IP_ADDRESS', action: 'redact' },
      { entityType: 'IBAN', action: 'redact' },
      { entityType: 'CN_ID_CARD', action: 'block' },
      { entityType: 'API_KEY', action: 'block' },
    ],
  },
});

const adapter = createLangChainAdapter({
  detectionEngine: kit.detectionEngine,
  policyEngine: kit.policyEngine,
  vault: kit.vault,
  auditLogger: kit.audit,
  agentId: 'support-agent',
  sessionId: 'demo-session',
});

const ctx = { agentId: 'support-agent', sessionId: 'demo-session' };

// Mock LLM reply that itself contains PII (the LLM may echo or hallucinate).
const mockModel = async (req: {
  messages: Array<{ content: unknown }>;
}): Promise<{ content: string }> => {
  const last = req.messages[req.messages.length - 1];
  const echoed = typeof last?.content === 'string' ? last.content : '';
  // Pretend the LLM echoed the user's email/card back into its reply.
  return { content: `ok, will follow up with jane@example.com about card 4111 1111 1111 1111 (echo: ${echoed})` };
};

// Mock tool handler — receives redacted args, restores them, talks to a
// real-looking downstream provider.
const mockToolHandler = async (req: { tool: { name: string }; input: unknown }): Promise<string> => {
  const real = kit.vault.restoreDeep(req.input) as Record<string, unknown>;
  return `${req.tool.name} sent → ${JSON.stringify(real)}`;
};

/** Run one message through all four boundaries. */
async function demoBoundary(label: string, msg: string): Promise<void> {
  console.log(`\n── ${label} ──`);
  console.log('IN :', msg);
  try {
    // (a) user → agent: scrub the message before the agent sees it.
    const safe = await kit.hooks.onUserMessage!(msg, { ...ctx, channel: 'input' });
    console.log('→ onUserMessage  :', safe);

    // (b) agent → model: scrub each message leaf before the LLM call.
    const modelReq = await adapter.wrapModelCall?.(
      { messages: [{ role: 'user', content: safe }] },
      mockModel,
    );
    console.log('→ wrapModelCall  :', JSON.stringify(modelReq));

    // (c) tool call: scrub args; handler restores real values for the provider.
    const toolOut = await adapter.wrapToolCall?.(
      { tool: { name: 'sendEmail' }, input: { to: 'jane@example.com', subject: 'hi' } },
      mockToolHandler,
    );
    console.log('→ wrapToolCall   :', toolOut);

    // (d) agent → user: scrub the final reply.
    const cleaned = await kit.hooks.onAgentResponse?.(String(toolOut), { ...ctx, channel: 'output' });
    console.log('→ onAgentResponse:', cleaned);
  } catch (err) {
    console.log('BLOCKED         :', (err as Error).message);
  }
}

async function main(): Promise<void> {
  await demoBoundary('clean', 'Hi there, just saying hello.');
  await demoBoundary('email + phone', 'Send to jane@example.com or call 13912345678.');
  await demoBoundary('card + IP', 'Charge 4111 1111 1111 1111 from 192.168.1.1.');
  await demoBoundary('SSN + IBAN', 'SSN 123-45-6789, IBAN GB29NWBK60161331926819.');
  await demoBoundary('CN id (blocked)', 'Verify my CN id 11010519491231002X.');
  await demoBoundary('API key (blocked)', 'Leaked sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD');

  console.log('\n── audit ─────────────────────────────────────────');
  console.log('verified:', kit.audit.verify());
  console.log('receipts:', kit.audit.recent().length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});