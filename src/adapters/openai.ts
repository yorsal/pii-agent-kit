/**
 * OpenAI SDK adapter.
 *
 * Wraps an OpenAI client instance so every `chat.completions.create` call
 * passes through our PII middleware. We deliberately avoid depending on
 * third-party adapter packages — the SDK surface is small enough that a
 * ~30-line wrapper covers the standard call site.
 */

import { createPiiMiddleware, type PiiMiddlewareOptions } from '../middleware/factory.js';

export interface OpenAiAdapterOptions extends PiiMiddlewareOptions {
  agentId?: string;
  sessionId?: string;
}

export interface OpenAiLikeClient {
  chat: {
    completions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (params: any, options?: any) => Promise<any>;
    };
  };
}

export interface WrappedOpenAiClient extends OpenAiLikeClient {
  __piiWrapped?: boolean;
}

/**
 * Return a wrapped OpenAI client where every chat completion is redacted.
 * Idempotent: re-wrapping the same client is a no-op.
 */
export function wrapOpenAiClient(client: OpenAiLikeClient, options: OpenAiAdapterOptions): WrappedOpenAiClient {
  if ((client as WrappedOpenAiClient).__piiWrapped) return client as WrappedOpenAiClient;
  const hooks = createPiiMiddleware(options);
  const ctx = () => ({
    agentId: options.agentId ?? 'unknown',
    sessionId: options.sessionId ?? 'default',
    channel: 'input' as const,
  });

  const wrapped: WrappedOpenAiClient = {
    ...client,
    chat: {
      ...client.chat,
      completions: {
        ...client.chat.completions,
        async create(params, options) {
          if (hooks.onModelInput && Array.isArray(params?.messages)) {
            const safeMessages = await hooks.onModelInput(params.messages, ctx());
            return client.chat.completions.create({ ...params, messages: safeMessages }, options);
          }
          return client.chat.completions.create(params, options);
        },
      },
    },
  };
  wrapped.__piiWrapped = true;
  return wrapped;
}

export { createPiiMiddleware } from '../middleware/factory.js';
export type { PiiMiddlewareHooks } from '../types.js';
