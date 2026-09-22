/**
 * MCP proxy example with a mocked transport.
 */

import { buildPiiKit } from '../src/index.js';
import { createMcpProxy } from '../src/adapters/mcp.js';

const kit = buildPiiKit({
  policy: {
    mode: 'enforce',
    defaultAction: 'redact',
    rules: [{ entityType: 'EMAIL', action: 'vault' }],
  },
});

const transport = async (req: { method: string; params?: unknown }) => ({
  result: { method: req.method, echoed: req.params },
});

const proxy = createMcpProxy(transport, {
  detectionEngine: kit.detectionEngine,
  policyEngine: kit.policyEngine,
  vault: kit.vault,
  auditLogger: kit.audit,
  agentId: 'demo',
  sessionId: 'demo',
});

async function main(): Promise<void> {
  const res = await proxy({
    method: 'tools/call',
    params: { name: 'sendEmail', arguments: { to: 'jane@example.com' } },
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
