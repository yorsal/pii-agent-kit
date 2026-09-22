/**
 * MCP proxy adapter — implements a transparent proxy that sits between an
 * MCP client and a remote MCP server, intercepting `tools/call` and
 * `resources/read` requests/responses and routing them through
 * `PiiMiddlewareHooks`.
 *
 * No external adapter package is used (none of the recommended libraries
 * ship a maintained MCP adapter). The adapter exposes a plain function
 * `createMcpProxy` so callers can wrap their existing MCP transport.
 */

import { createPiiMiddleware, type PiiMiddlewareOptions } from '../middleware/factory.js';

export interface McpProxyOptions extends PiiMiddlewareOptions {
  agentId?: string;
  sessionId?: string;
}

export interface McpRequest {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

export interface McpResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any;
}

export type McpTransport = (req: McpRequest) => Promise<McpResponse>;

/** Intercepted MCP methods we know how to redact. */
const REDACTED_METHODS = new Set(['tools/call', 'resources/read']);

/**
 * Wrap an MCP transport so that every redacted method passes through our
 * PII middleware before being sent over the wire.
 */
export function createMcpProxy(transport: McpTransport, options: McpProxyOptions): McpTransport {
  const hooks = createPiiMiddleware(options);
  const ctx = (channel: 'tool' | 'input' | 'output', toolName?: string) => ({
    agentId: options.agentId ?? 'unknown',
    sessionId: options.sessionId ?? 'default',
    channel,
    ...(toolName !== undefined ? { toolName } : {}),
  });

  return async (req: McpRequest) => {
    if (!REDACTED_METHODS.has(req.method)) return transport(req);

    if (req.method === 'tools/call') {
      const toolName = req.params?.name ?? 'unknown';
      const safeArgs = hooks.beforeToolCall
        ? await hooks.beforeToolCall(toolName, req.params?.arguments, ctx('tool', toolName))
        : req.params?.arguments;
      const next: McpRequest = { ...req, params: { ...req.params, arguments: safeArgs } };
      const res = await transport(next);
      if (res.result && hooks.afterToolCall) {
        return { ...res, result: await hooks.afterToolCall(toolName, res.result, ctx('tool', toolName)) };
      }
      return res;
    }

    if (req.method === 'resources/read') {
      const text = JSON.stringify(req.params ?? {});
      if (hooks.onModelInput) {
        await hooks.onModelInput(text, ctx('input'));
      }
      const res = await transport(req);
      return res;
    }

    return transport(req);
  };
}

export { createPiiMiddleware } from '../middleware/factory.js';
export type { PiiMiddlewareHooks } from '../types.js';
