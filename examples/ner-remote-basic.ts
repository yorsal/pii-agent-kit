/**
 * Remote NER example — wires `RemoteNerDetector` into the kit against a
 * locally-mocked HTTP service. Drop the `fetchImpl` to use a real Ollama /
 * vLLM / TGI endpoint.
 */

import { RemoteNerDetector } from '../src/detectors/ner-detector.js';
import { buildPiiKit } from '../src/index.js';

// Mock fetch that pretends to be a vLLM-style OpenAI-compatible NER router.
const fetchImpl: typeof fetch = (async (url, init) => {
  if (init?.method === 'GET') {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  const body = JSON.parse(String(init?.body));
  const text: string = body.messages[0].content;
  // Toy extractor: any capitalised word in the input is a PERSON.
  const re = /\b([A-Z][a-z]{2,})\b/g;
  const entities: Array<{ text: string; label: string; score: number; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    entities.push({ text: m[1], label: 'PER', score: 0.92, start: m.index, end: m.index + m[1].length });
  }
  return new Response(JSON.stringify({ entities }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

const ner = new RemoteNerDetector({
  endpoint: 'http://localhost:9999/ner',
  format: 'openai',
  model: 'pii-ner-mock',
  fetchImpl,
});

const kit = buildPiiKit({
  policy: {
    mode: 'enforce',
    defaultAction: 'redact',
    rules: [
      { entityType: 'PERSON', action: 'vault' },
      { entityType: 'EMAIL', action: 'vault' },
    ],
  },
  ner: false,
});

// Swap the regex-only engine for one that includes the remote detector.
// (In production code you'd build the engine up-front; this example keeps
//  buildPiiKit's ergonomics for the audit + vault + policy stack.)
const { DetectionEngine, RegexDetector } = await import('../src/index.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(kit.detectionEngine as any).detectors.length = 0;
(kit.detectionEngine as any).detectors.push(new RegexDetector(), ner);

await ner.initialize();

const out = await kit.hooks.onUserMessage!('Alice met Bob at jane@example.com', {
  agentId: 'demo',
  sessionId: 'demo',
  channel: 'input',
});

// eslint-disable-next-line no-console
console.log('redacted:', out);
// eslint-disable-next-line no-console
console.log('restored:', kit.vault.restoreText(out));
