/**
 * LangChain.js adapter example (mocked — no real LangChain dep needed).
 *
 * Demonstrates wiring `createLangChainAdapter` into a model/tool call site
 * without depending on any framework-specific runtime. The mock transport
 * stands in for an actual LLM/tool.
 */

import { buildPiiKit } from '../src/index.js';
import { createLangChainAdapter } from '../src/adapters/langchain.js';

const kit = buildPiiKit({
  policy: {
    mode: 'enforce',
    defaultAction: 'redact',
    rules: [
      { entityType: 'EMAIL', action: 'vault' },
      { entityType: 'API_KEY', action: 'block' },
    ],
  },
});

const adapter = createLangChainAdapter({
  detectionEngine: kit.detectionEngine,
  policyEngine: kit.policyEngine,
  vault: kit.vault,
  auditLogger: kit.audit,
  agentId: 'demo',
  sessionId: 'demo-session',
});

// Mock model handler that simply echoes the (possibly redacted) messages.
const mockModel = async (req: { messages: Array<{ content: unknown }> }) => ({
  content: 'echo: ' + JSON.stringify(req.messages),
});

const mockTool = async (req: { tool?: { name?: string }; input?: unknown }) => ({
  ok: true,
  echoed: req.input,
});

async function main(): Promise<void> {
  const modelResult = await adapter.wrapModelCall?.(
    { messages: [{ content: 'ping me at jane@example.com' }] },
    mockModel,
  );
  // eslint-disable-next-line no-console
  console.log('model:', JSON.stringify(modelResult));

  const toolResult = await adapter.wrapToolCall?.(
    { tool: { name: 'sendEmail' }, input: { to: 'jane@example.com', subject: 'hi' } },
    mockTool,
  );
  // eslint-disable-next-line no-console
  console.log('tool:', JSON.stringify(toolResult));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
