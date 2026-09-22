/**
 * LangChain.js adapter.
 *
 * We do NOT depend on `redactum`/`Lupid`/`Authensor` because they do not
 * ship stable, ESM-friendly adapters on npm as of the last check. Instead
 * we wrap the official LangChain `wrapModelCall`/`wrapToolCall` middleware
 * hooks with our `PiiMiddlewareHooks` pipeline.
 *
 * If/when an official adapter appears, drop it in here without touching
 * the rest of the kit.
 */

import { createPiiMiddleware, type PiiMiddlewareOptions } from '../middleware/factory.js';

export interface LangChainAdapterOptions extends PiiMiddlewareOptions {
  agentId?: string;
  sessionId?: string;
}

/** Shape LangChain's middleware expects (loose; we only consume what we need). */
export interface LangChainMiddleware {
  name?: string;
  wrapModelCall?: (
    request: { messages?: Array<{ content: unknown }> },
    handler: (req: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  wrapToolCall?: (
    request: { tool?: { name?: string }; input?: unknown },
    handler: (req: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
}

/**
 * Build a LangChain middleware object backed by `PiiMiddlewareHooks`.
 * The adapter flattens message content to strings for detection, then
 * replaces them with redacted equivalents in the response.
 *
 * The returned object is a bare middleware shape — no `langchain` import.
 * To plug into `createAgent({ middleware })`, pass it through
 * `createMiddleware({ name: 'PiiMiddleware', ...adapter })` on the
 * consumer side, or hand the shape directly if your LangChain version
 * accepts plain objects in the middleware array.
 */
export function createLangChainAdapter(options: LangChainAdapterOptions): LangChainMiddleware {
  const hooks = createPiiMiddleware(options);
  const ctx = (channel: 'input' | 'tool' | 'output', toolName?: string) => ({
    agentId: options.agentId ?? 'unknown',
    sessionId: options.sessionId ?? 'default',
    channel,
    ...(toolName !== undefined ? { toolName } : {}),
  });

  return {
    // `name` is required by LangChain's middleware dispatcher for logging
    // and error attribution; without it the object is silently skipped.
    name: 'PiiMiddleware',
    async wrapModelCall(request, handler) {
      if (hooks.onModelInput && Array.isArray(request.messages)) {
        const redacted = await hooks.onModelInput(request.messages, ctx('input'));
        const next = { ...request, messages: redacted };
        return handler(next);
      }
      return handler(request);
    },
    async wrapToolCall(request, handler) {
      const toolName = request.tool?.name ?? 'unknown';
      if (hooks.beforeToolCall) {
        const safeArgs = await hooks.beforeToolCall(toolName, request.input, ctx('tool', toolName));
        const next = { ...request, input: safeArgs };
        const result = await handler(next);
        if (hooks.afterToolCall) return hooks.afterToolCall(toolName, result, ctx('tool', toolName));
        return result;
      }
      return handler(request);
    },
  };
}

/** Convenience: thin function that other adapters can re-use. */
export { createPiiMiddleware } from '../middleware/factory.js';
export type { PiiMiddlewareHooks, PiiMiddlewareContext } from '../types.js';
