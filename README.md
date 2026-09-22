# pii-agent-kit

End-to-end PII (Personally Identifiable Information) protection for AI agents.
TypeScript / Node.js 18+. Detects PII in user input, model prompts, tool
arguments, tool results, agent memory and logs; redacts per policy; emits
tamper-evident audit receipts; reversible tokenization via a session-scoped
vault. Adapters for LangChain.js, Vercel AI SDK, MCP and OpenAI SDK are
included.

## Reuse vs. own

| Concern | Reused library | Notes |
|---|---|---|
| Regex detection + Luhn/CN-ID validators | [`pii-vault`](https://www.npmjs.com/package/pii-vault) | We layer a curated pattern catalogue on top and expose our own `PiiDetector` contract. |
| Reversible tokenization | `pii-vault` (`Vault`) | We add per-session scoping via a `PiiTokenVault` wrapper. |
| NER inference | [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) | Optional; runs locally on ONNX. Falls back to regex-only when unavailable. |
| Remote NER inference | Self-hosted HTTP endpoint (Ollama, vLLM, TGI, custom) | `RemoteNerDetector`; wire formats: `openai`, `ollama`, `huggingface`, `generic`. |
| Multi-framework adapter libraries (`redactum`, `Lupid`, `Authensor`, `PrivacyLens`) | None — none ship stable ESM adapters on npm as of last check. | We ship thin adapters for LangChain.js / Vercel AI SDK / MCP / OpenAI SDK instead. |
| Detection merge, policy engine, middleware, audit chain, framework adapters | Hand-written | Domain-specific logic; not generalisable. |

## Install

```bash
pnpm add pii-agent-kit
# or
npm install pii-agent-kit
```

The ONNX NER model downloads lazily on first use; pass `ner: false` to
`buildPiiKit` if you only need the regex layer.

## Quick start

```ts
import { buildPiiKit } from 'pii-agent-kit';

const kit = buildPiiKit({
  policy: {
    mode: 'enforce',
    defaultAction: 'redact',
    rules: [
      { entityType: 'EMAIL', action: 'vault' },
      { entityType: 'API_KEY', action: 'block' },
    ],
  },
  ner: false, // disable NER if you don't want the ONNX download
});

const safe = await kit.hooks.onUserMessage!(
  'contact me at jane@example.com with key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  { agentId: 'a1', sessionId: 's1', channel: 'input' },
);
```

The middleware short-circuits with `BlockedError` whenever an action is
`block`; for everything else the match is replaced with a redaction,
mask, hash or vault token depending on the policy.

## Architecture

```
                  ┌──────────────────────┐
   user input ───►│ onUserMessage        │──┐
                  └──────────────────────┘  │
                  ┌──────────────────────┐  │   ┌────────────────┐
   LLM messages ─►│ onModelInput         │──┼──►│ DetectionEngine│──┐
                  └──────────────────────┘  │   └────────────────┘  │
                  ┌──────────────────────┐  │   ┌────────────────┐  │   ┌──────────┐
   tool args ────►│ beforeToolCall       │──┘   │ PolicyEngine   │◄─┼──►│ Vault    │
                  └──────────────────────┘      └────────────────┘  │   └──────────┘
                  ┌──────────────────────┐                          │   ┌──────────┐
   tool result ──►│ afterToolCall        │──────────────────────────┼──►│ AuditLog │
                  └──────────────────────┘                          │   └──────────┘
                  ┌──────────────────────┐                          │
   response ─────►│ onAgentResponse      │──────────────────────────┘
                  └──────────────────────┘
```

## NER via a locally-deployed service

When you already run NER on a GPU server (Ollama, vLLM, TGI, a custom
FastAPI), use `RemoteNerDetector` so the Node.js process does not pull
model weights into memory. Wire formats supported out of the box:

```ts
import { buildPiiKit, RemoteNerDetector } from 'pii-agent-kit';

// Ollama (run `ollama run llama3` and a NER router on :11434)
const ner = new RemoteNerDetector({
  endpoint: 'http://localhost:11434/api/ner',
  format: 'ollama',
  model: 'llama3',
});

// vLLM / TGI (HuggingFace-compatible token-classification endpoint)
const nerHf = new RemoteNerDetector({
  endpoint: 'http://localhost:8080',
  format: 'huggingface',
});

// Any OpenAI-compatible NER router (returns `{entities: [...]}` or
// `choices[0].message.content` containing JSON `entities`)
const nerOai = new RemoteNerDetector({
  endpoint: 'http://gpu-box.local:8000/v1/chat/completions',
  format: 'openai',
  apiKey: process.env.NER_API_KEY,
  model: 'pii-ner',
  timeoutMs: 8000,
});

const kit = buildPiiKit({
  policy: { mode: 'enforce', defaultAction: 'redact', rules: [] },
  ner: false, // disable the in-process ONNX detector
});

// Plug the remote detector into the engine manually.
import { DetectionEngine } from 'pii-agent-kit';
import { RegexDetector } from 'pii-agent-kit';
kit.detectionEngine; // already built
```

If the service is unreachable the detector flips `ready=false` and
returns no matches — the engine then degrades to regex-only.

## Adapter examples

```ts
// LangChain.js (real, see full demo below)
import { createLangChainAdapter } from 'pii-agent-kit/adapters/langchain';

// Vercel AI SDK
import { wrapLanguageModel } from 'pii-agent-kit/adapters/vercel-ai';

// MCP proxy
import { createMcpProxy } from 'pii-agent-kit/adapters/mcp';

// OpenAI SDK
import { wrapOpenAiClient } from 'pii-agent-kit/adapters/openai';
```

Each adapter accepts the same `PiiMiddlewareOptions` plus an `agentId`
and `sessionId` (defaults: `'unknown'` / `'default'`).

### LangChain.js — full demo

Wires `createLangChainAdapter` into LangChain v1's unified `createAgent` API
with two real tools (email + CRM lookup) covering several PII entity types.
Requires `langchain` ≥ 1.0 and `@langchain/openai`.

A runnable version with mocked model/tools (no framework dep needed) lives
in [`examples/multi-pii-demo.ts`](examples/multi-pii-demo.ts).

```ts
import { ChatOpenAI } from '@langchain/openai';
import { tool } from 'langchain';
import { createAgent } from 'langchain';
import { buildPiiKit } from 'pii-agent-kit';
import { createLangChainAdapter } from 'pii-agent-kit/adapters/langchain';

// 1. Build the kit. One rule per entity type:
//    EMAIL/CREDIT_CARD/PHONE → vault (reversible token; tools restore via vault.restoreDeep)
//    SSN/IP/IBAN             → redact (irreversible; do NOT pass to tools that need real values)
//    CN_ID_CARD/API_KEY      → block (throws)
const kit = buildPiiKit({
  policy: {
    mode: 'enforce',
    defaultAction: 'redact',
    rules: [
      { entityType: 'EMAIL', action: 'vault' },
      { entityType: 'CREDIT_CARD', action: 'vault' },
      { entityType: 'PHONE', action: 'vault' },
      { entityType: 'SSN', action: 'redact' },
      { entityType: 'IP_ADDRESS', action: 'redact' },
      { entityType: 'IBAN', action: 'redact' },
      { entityType: 'CN_ID_CARD', action: 'block' },
      { entityType: 'API_KEY', action: 'block' },
    ],
  },
  ner: false,
});

// 2. Wire the adapter as LangChain middleware. Hoist agentId so step 6
//    uses the same value when emitting audit receipts for the API surface.
const AGENT_ID = process.env.AGENT_ID ?? 'support-agent';
const adapter = createLangChainAdapter({
  detectionEngine: kit.detectionEngine,
  policyEngine: kit.policyEngine,
  vault: kit.vault,
  auditLogger: kit.audit,
  agentId: AGENT_ID,
  sessionId: 'session-42',
});

// 3. Real OpenAI model. PII handling on the model boundary is done by
//    `middleware: [adapter]` below — no manual wrapping needed here.
const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });

// 4. Real tools. `wrapToolCall` redacts args; handlers restore real values
//    before talking to downstream providers.
const sendEmail = tool(
  async (args: { to: string; subject: string; body: string }) => {
    const real = kit.vault.restoreDeep(args);
    // e.g. await resend.emails.send(real);
    return `queued: ${real.to} / ${real.subject}`;
  },
  {
    name: 'sendEmail',
    description: 'Send an email.',
    schema: /* zod schema */ {} as never,
  },
);

const lookupCustomer = tool(
  async (args: { phone: string }) => {
    const real = kit.vault.restoreDeep(args);
    // e.g. await crm.findByPhone(real.phone);
    return `customer: ${real.phone}`;
  },
  {
    name: 'lookupCustomer',
    description: 'Look up a customer by phone number.',
    schema: /* zod schema */ {} as never,
  },
);

// 5. Compose with langchain v1's unified createAgent API.
const agent = createAgent({
  model,
  tools: [sendEmail, lookupCustomer],
  systemPrompt: 'You are a helpful assistant. Use the available tools when asked.',
  middleware: [adapter], // wraps wrapModelCall + wrapToolCall automatically
});

// 6. Wrap agent.invoke so the user-input and final-response boundaries also
//    fire (the API surface, not just the LLM/tool boundaries inside). Only
//    the last user message is scrubbed; system/assistant history passes
//    through so prior turns keep their context. sessionId is computed once
//    per call so input and output receipts land on the same audit chain.
const originalInvoke = agent.invoke.bind(agent);
agent.invoke = async (input, options) => {
  const sessionId = options?.configurable?.thread_id ?? crypto.randomUUID();
  const ctx = { agentId: AGENT_ID, sessionId };
  const lastUser = input.messages.at(-1);
  const pre = lastUser
    ? await kit.hooks.onUserMessage?.(String(lastUser.content), { ...ctx, channel: 'input' })
    : undefined;
  const redactedInput = {
    ...input,
    messages: [
      ...input.messages.slice(0, -1),
      { role: 'user', content: pre ?? lastUser?.content ?? '' },
    ],
  };
  const result = await originalInvoke(redactedInput, options);
  const lastReply = result.messages?.at(-1);
  if (lastReply && typeof lastReply.content === 'string') {
    const clean = await kit.hooks.onAgentResponse?.(lastReply.content, { ...ctx, channel: 'output' });
    return {
      ...result,
      messages: [...result.messages.slice(0, -1), { role: 'assistant', content: clean ?? lastReply.content }],
    };
  }
  return result;
};

// 7. Run it. PII in user messages is tokenised before the LLM sees it;
//    tool handlers see real values via vault.restoreDeep.
const result = await agent.invoke(
  { messages: [{ role: 'user', content: 'Send to finance@example.com or call 13912345678.' }] },
  { configurable: { thread_id: 'thread-abc-123' } },
);

// 8. Inspect the audit chain.
console.log('audit verified:', kit.audit.verify()); // true
console.log('recent receipts:', kit.audit.recent().length);
```

What this gives you end-to-end:

| Stage | What runs |
|---|---|
| User input | `onUserMessage` detects `finance@example.com`, replaces with `[EMAIL:...]` vault token. |
| Model prompt | LangChain middleware sends the tokenised messages to OpenAI — the LLM never sees the raw email. |
| Tool call | The agent emits `sendEmail({ to: "[EMAIL:...]" })`; LangChain's `wrapToolCall` lets `beforeToolCall` confirm args, then `afterToolCall` restores the token for the email provider. |
| Tool response | The email service's response is recorded as an audit receipt. |
| Final output | `onAgentResponse` scrubs the model's reply before it returns to the caller. |
| Audit | Each step mints an HMAC-chained `AuditReceipt`; `verify()` confirms integrity. |

## Policy actions

| Action | Effect |
|---|---|
| `allow` | Leave the value untouched. |
| `block` | Throw `BlockedError` so callers can short-circuit. |
| `redact` | Replace with `[REDACTED:TYPE]`. |
| `mask` | Replace with `*` (length preserved, min 4). |
| `hash` | Replace with `[HASH:<sha256-prefix>]`. |
| `vault` | Replace with a deterministic session-scoped token; restored on tool responses. |

## Audit chain

`AuditLogger` mints an HMAC-SHA256 hash chain over every PII event.
Receipts are append-only; any tampering breaks the chain. Configure the
key via `PII_AUDIT_KEY` or pass `auditKey` to `buildPiiKit`.

## Scripts

```bash
pnpm build      # tsup → dist/
pnpm test       # vitest
pnpm lint       # eslint
pnpm typecheck  # tsc --noEmit
```

## License

MIT
