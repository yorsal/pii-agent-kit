/**
 * Vercel AI SDK adapter example with a mocked model.
 */

import { buildPiiKit } from '../src/index.js';
import { wrapLanguageModel } from '../src/adapters/vercel-ai.js';

const kit = buildPiiKit({
  policy: {
    mode: 'enforce',
    defaultAction: 'redact',
    rules: [{ entityType: 'EMAIL', action: 'vault' }],
  },
  ner: false,
});

interface MockParams {
  messages: Array<{ role: string; content: string }>;
}

const mockModel = {
  modelId: 'mock-gpt',
  async doGenerate(params: MockParams) {
    return { text: 'ok: ' + (params.messages[0]?.content ?? '') };
  },
};

const wrapped = wrapLanguageModel(mockModel, {
  detectionEngine: kit.detectionEngine,
  policyEngine: kit.policyEngine,
  vault: kit.vault,
  auditLogger: kit.audit,
  agentId: 'demo',
  sessionId: 'demo',
});

async function main(): Promise<void> {
  const result = await wrapped.doGenerate?.({
    messages: [{ role: 'user', content: 'send to jane@example.com' }],
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
