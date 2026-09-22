/**
 * Vercel AI SDK adapter.
 *
 * Wraps the language model so that every `doGenerate`/`doStream` call
 * routes its prompt through `onModelInput` and every result through
 * `onAgentResponse`. We do NOT depend on any external adapter package —
 * the Vercel AI SDK exposes a clean `wrapLanguageModel` seam and our
 * `PiiMiddlewareHooks` are sufficient.
 */

import type { PiiMiddlewareHooks } from '../types.js';
import { createPiiMiddleware, type PiiMiddlewareOptions } from '../middleware/factory.js';

export interface VercelAiAdapterOptions extends PiiMiddlewareOptions {
  agentId?: string;
  sessionId?: string;
}

/** Minimal interface of the Vercel AI SDK model we need. */
export interface VercelLanguageModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doGenerate?: (options: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doStream?: (options: any) => Promise<any>;
  modelId?: string;
}

export interface VercelWrappedModel extends VercelLanguageModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __piiWrapped?: boolean;
}

/**
 * Wrap a Vercel AI SDK language model so every call passes through our
 * PII hooks. Idempotent: calling it twice on the same model is safe.
 */
export function wrapLanguageModel(
  model: VercelLanguageModel,
  options: VercelAiAdapterOptions,
): VercelWrappedModel {
  if ((model as VercelWrappedModel).__piiWrapped) return model as VercelWrappedModel;
  const hooks = createPiiMiddleware(options);
  const ctx = {
    agentId: options.agentId ?? 'unknown',
    sessionId: options.sessionId ?? 'default',
    channel: 'input' as const,
  };

  const wrapped: VercelWrappedModel = {
    ...model,
    async doGenerate(opts) {
      if (hooks.onModelInput && model.doGenerate) {
        const safe = await hooks.onModelInput(opts?.prompt ?? opts, ctx);
        return model.doGenerate({ ...opts, prompt: safe });
      }
      return model.doGenerate?.(opts);
    },
    async doStream(opts) {
      if (hooks.onModelInput && model.doStream) {
        const safe = await hooks.onModelInput(opts?.prompt ?? opts, ctx);
        return model.doStream({ ...opts, prompt: safe });
      }
      return model.doStream?.(opts);
    },
  };
  wrapped.__piiWrapped = true;
  return wrapped;
}

/** Streaming transformer: buffer partial output until we have a whole word. */
export class StreamScrubber {
  private buffer = '';
  private readonly flushSize: number;
  private readonly hooks: PiiMiddlewareHooks;
  private readonly ctx: Parameters<NonNullable<PiiMiddlewareHooks['onAgentResponse']>>[1];

  constructor(hooks: PiiMiddlewareHooks, ctx: Parameters<NonNullable<PiiMiddlewareHooks['onAgentResponse']>>[1], flushSize = 32) {
    this.hooks = hooks;
    this.ctx = ctx;
    this.flushSize = flushSize;
  }

  /** Feed a token; return any cleaned text that is safe to forward. */
  async feed(chunk: string): Promise<string> {
    this.buffer += chunk;
    if (this.buffer.length < this.flushSize) return '';
    return this.flush();
  }

  /** End-of-stream: flush remaining buffered text. */
  async end(): Promise<string> {
    return this.flush();
  }

  private async flush(): Promise<string> {
    const text = this.buffer;
    this.buffer = '';
    if (!this.hooks.onAgentResponse) return text;
    return this.hooks.onAgentResponse(text, this.ctx);
  }
}

export { createPiiMiddleware } from '../middleware/factory.js';
export type { PiiMiddlewareHooks } from '../types.js';
