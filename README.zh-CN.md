# pii-agent-kit

面向 AI Agent 的端到端 PII（个人可识别信息）保护库。TypeScript / Node.js 18+。
覆盖用户输入、模型提示词、工具参数、工具结果、Agent 记忆与日志的全链路 PII 检测；
按策略脱敏；输出防篡改的审计收据；通过 session 隔离的 vault 实现可逆令牌化。
内置 LangChain.js、Vercel AI SDK、MCP、OpenAI SDK 四个官方薄适配器。

> 本文为中文版，与 [README.md](./README.md) 保持一致；如有不一致，以英文版为准。

---

## 复用 vs 自研

| 关注点 | 复用的库 | 说明 |
|---|---|---|
| 正则检测 + Luhn / CN-ID 校验 | [`pii-vault`](https://www.npmjs.com/package/pii-vault) | 在其上封装了一层精选 pattern 目录，并暴露自有的 `PiiDetector` 契约。 |
| 可逆令牌化 | `pii-vault`（`Vault`） | 通过 `PiiTokenVault` 包装层增加 session 作用域。 |
| NER 推理 | [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) | 可选；本地 ONNX 推理。无法加载时降级为 regex-only。 |
| 远端 NER 推理 | 自建 HTTP 端点（Ollama、vLLM、TGI、自定义） | `RemoteNerDetector`；支持的 wire 格式：`openai`、`ollama`、`huggingface`、`generic`。 |
| 多框架适配器库（`redactum`、`Lupid`、`Authensor`、`PrivacyLens`） | — | 截至最后一次检查，npm 上没有稳定的 ESM 适配器。改为内置 LangChain.js / Vercel AI SDK / MCP / OpenAI SDK 四个薄适配器。 |
| 检测合并、策略引擎、中间件、审计链、框架适配器 | 自研 | 领域特定逻辑，无法通用化。 |

---

## 安装

```bash
pnpm add pii-agent-kit
# 或
npm install pii-agent-kit
```

ONNX NER 模型在首次使用时按需下载；若只需要正则层，请传 `ner: false` 给 `buildPiiKit`。

---

## 快速开始

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
  ner: false, // 不下载 ONNX 模型
});

const safe = await kit.hooks.onUserMessage!(
  '联系我 jane@example.com，密钥 sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  { agentId: 'a1', sessionId: 's1', channel: 'input' },
);
```

当 action 为 `block` 时，中间件会抛 `BlockedError` 短路；其它动作会按策略替换为 `redact` / `mask` / `hash` / vault token。

---

## 架构

```
                  ┌──────────────────────┐
   用户输入 ────►│ onUserMessage          │──┐
                  └──────────────────────┘  │
                  ┌──────────────────────┐  │   ┌────────────────┐
   LLM 消息 ────►│ onModelInput           │──┼──►│ DetectionEngine│──┐
                  └──────────────────────┘  │   └────────────────┘  │
                  ┌──────────────────────┐  │   ┌────────────────┐  │   ┌──────────┐
   工具参数 ────►│ beforeToolCall         │──┘   │ PolicyEngine   │◄─┼──►│ Vault    │
                  └──────────────────────┘      └────────────────┘  │   └──────────┘
                  ┌──────────────────────┐                            │   ┌──────────┐
   工具结果 ────►│ afterToolCall          │────────────────────────────┼──►│ AuditLog │
                  └──────────────────────┘                            │   └──────────┘
                  ┌──────────────────────┐                            │
   模型响应 ────►│ onAgentResponse        │────────────────────────────┘
                  └──────────────────────┘
```

---

## 通过本地部署的 NER 服务

当 NER 已经在 GPU 服务器上跑起来（Ollama、vLLM、TGI、自建 FastAPI），用 `RemoteNerDetector` 让 Node 进程不加载模型权重。开箱即用的 wire 格式：

```ts
import { buildPiiKit, RemoteNerDetector } from 'pii-agent-kit';

// Ollama（`ollama run llama3` + NER 路由）
const ner = new RemoteNerDetector({
  endpoint: 'http://localhost:11434/api/ner',
  format: 'ollama',
  model: 'llama3',
});

// vLLM / TGI（HuggingFace 兼容 token-classification）
const nerHf = new RemoteNerDetector({
  endpoint: 'http://localhost:8080',
  format: 'huggingface',
});

// 任意 OpenAI 兼容 NER 路由（返回 `{entities: [...]}` 或
// `choices[0].message.content` 内含 JSON `entities`）
const nerOai = new RemoteNerDetector({
  endpoint: 'http://gpu-box.local:8000/v1/chat/completions',
  format: 'openai',
  apiKey: process.env.NER_API_KEY,
  model: 'pii-ner',
  timeoutMs: 8000,
});

const kit = buildPiiKit({
  policy: { mode: 'enforce', defaultAction: 'redact', rules: [] },
  ner: false, // 关闭进程内 ONNX detector
});

// 把远端 detector 手动接入 engine。
import { DetectionEngine } from 'pii-agent-kit';
import { RegexDetector } from 'pii-agent-kit';
kit.detectionEngine; // 已经构建好
```

服务不可达时 detector 将 `ready` 置为 `false`，`detect()` 返回 `[]` —— 引擎降级为 regex-only。

---

## 框架适配示例

```ts
// LangChain.js（真实调用，见下方完整 demo）
import { createLangChainAdapter } from 'pii-agent-kit/adapters/langchain';

// Vercel AI SDK
import { wrapLanguageModel } from 'pii-agent-kit/adapters/vercel-ai';

// MCP 代理
import { createMcpProxy } from 'pii-agent-kit/adapters/mcp';

// OpenAI SDK
import { wrapOpenAiClient } from 'pii-agent-kit/adapters/openai';
```

每个适配器接受相同的 `PiiMiddlewareOptions`，外加 `agentId`（默认 `'unknown'`）和 `sessionId`（默认 `'default'`）。

### LangChain.js — 完整 demo

把 `createLangChainAdapter` 接入 LangChain v1 的统一 `createAgent` API，配两个真实工具（邮件 + CRM 查询）覆盖多种 PII 实体类型。依赖：`langchain` ≥ 1.0 与 `@langchain/openai`。

可运行的 mock 版本（无需 framework 依赖）在 [`examples/multi-pii-demo.ts`](examples/multi-pii-demo.ts)。

```ts
import { ChatOpenAI } from '@langchain/openai';
import { tool } from 'langchain';
import { createAgent } from 'langchain';
import { buildPiiKit } from 'pii-agent-kit';
import { createLangChainAdapter } from 'pii-agent-kit/adapters/langchain';

// 1. 构建 kit。每种实体一条规则：
//    EMAIL/CREDIT_CARD/PHONE → vault（可逆 token；工具通过 vault.restoreDeep 还原）
//    SSN/IP/IBAN             → redact（不可逆；不要传给需要真实值的工具）
//    CN_ID_CARD/API_KEY      → block（抛错）
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

// 2. 把 adapter 作为 LangChain middleware 接入。把 agentId 提到顶部 const，
//    让 step 6 发出审计收据时也用同一个值。
const AGENT_ID = process.env.AGENT_ID ?? 'support-agent';
const adapter = createLangChainAdapter({
  detectionEngine: kit.detectionEngine,
  policyEngine: kit.policyEngine,
  vault: kit.vault,
  auditLogger: kit.audit,
  agentId: AGENT_ID,
  sessionId: 'session-42',
});

// 3. 真实的 OpenAI 模型。模型边界的 PII 处理由下面的
//    `middleware: [adapter]` 自动完成 —— 这里不需要再手动包一层。
const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });

// 4. 真实工具。`wrapToolCall` 脱敏参数；handler 在请求下游服务前还原真实值。
const sendEmail = tool(
  async (args: { to: string; subject: string; body: string }) => {
    const real = kit.vault.restoreDeep(args);
    // e.g. await resend.emails.send(real);
    return `已排队: ${real.to} / ${real.subject}`;
  },
  {
    name: 'sendEmail',
    description: '发送邮件。',
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
    description: '通过手机号查询客户。',
    schema: /* zod schema */ {} as never,
  },
);

// 5. 用 LangChain v1 的统一 createAgent API 组装。
const agent = createAgent({
  model,
  tools: [sendEmail, lookupCustomer],
  systemPrompt: '你是一个乐于助人的助手，按需调用可用工具。',
  middleware: [adapter], // 自动接入 wrapModelCall + wrapToolCall
});

// 6. 包装 agent.invoke，让用户输入和最终响应两个边界也走 PII 链路
//   （即 API 表面，而不仅仅是 LLM/工具内部边界）。只对最后一条 user 消息
//   做脱敏；system/assistant 历史原样透传，保留上下文。
//   sessionId 每次调用只算一次，让输入/输出收据落在同一条审计链上。
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

// 7. 运行。用户消息中的 PII 在 LLM 看到之前已被 token 化；
//    工具 handler 通过 vault.restoreDeep 拿到真实值。
const result = await agent.invoke(
  { messages: [{ role: 'user', content: '把本季报告发给 finance@example.com，或打 13912345678。' }] },
  { configurable: { thread_id: 'thread-abc-123' } },
);

// 8. 检查审计链。
console.log('audit verified:', kit.audit.verify()); // true
console.log('recent receipts:', kit.audit.recent().length);
```

端到端流程：

| 阶段 | 发生了什么 |
|---|---|
| 用户输入 | `onUserMessage` 检测到 `finance@example.com`，替换为 `[EMAIL:...]` vault token。 |
| 模型提示词 | LangChain middleware 把 token 化后的消息发给 OpenAI —— LLM 永远看不到真实邮箱。 |
| 工具调用 | agent 发出 `sendEmail({ to: "[EMAIL:...]" })`；LangChain 的 `wrapToolCall` 让 `beforeToolCall` 校验参数，`afterToolCall` 在调邮件服务前把 token 还原。 |
| 工具响应 | 邮件服务的返回被记入审计收据。 |
| 最终输出 | `onAgentResponse` 在结果交回调用方前再清洗一次。 |
| 审计 | 每一步都生成 HMAC 链式 `AuditReceipt`；`verify()` 可校验完整性。 |

---

## 策略动作

| 动作 | 效果 |
|---|---|
| `allow` | 保留原值 |
| `block` | 抛 `BlockedError`，调用方可据此短路 |
| `redact` | 替换为 `[REDACTED:TYPE]` |
| `mask` | 替换为 `*`（保留长度，最少 4 个字符） |
| `hash` | 替换为 `[HASH:<sha256 前缀>]` |
| `vault` | 替换为 session-scoped token，工具响应时自动还原 |

---

## 审计链

`AuditLogger` 为每个 PII 事件生成 HMAC-SHA256 哈希链收据。收据只能追加；任何篡改都会破坏链。配置方式：
环境变量 `PII_AUDIT_KEY`，或给 `buildPiiKit` 传 `auditKey`。

---

## 开发脚本

```bash
pnpm build      # tsup → dist/
pnpm test       # vitest
pnpm lint       # eslint
pnpm typecheck  # tsc --noEmit
```

---

## 许可

MIT
