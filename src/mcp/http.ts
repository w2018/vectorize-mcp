import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toolSchemas, toolDescriptions, type ToolName } from "./schemas.js";

export interface McpService<C> {
  authenticate(token: string): Promise<C>;
  call(
    context: C,
    tool: ToolName,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  validate(context: C): Promise<void>;
}
function authorizationFailure(res: ServerResponse, error: unknown): void {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") {
    unauthorized(res, code === "FORBIDDEN" ? 403 : 401);
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(503, {
    "Content-Type": "application/json",
    "Retry-After": "1",
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Authorization service unavailable" },
    }),
  );
}
function unauthorized(res: ServerResponse, status = 401): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "WWW-Authenticate": "Bearer",
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Authentication required" },
    }),
  );
}
export function createMcpHandler<C>(service: McpService<C>) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const authorizationCount = req.rawHeaders.filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === "authorization",
    ).length;
    if (authorizationCount !== 1) {
      unauthorized(res);
      return;
    }
    const authorization = req.headers.authorization;
    const match =
      typeof authorization === "string"
        ? /^Bearer ([^\s]+)$/i.exec(authorization)
        : null;
    if (!match?.[1]) {
      unauthorized(res);
      return;
    }
    let context: C;
    try {
      context = await service.authenticate(match[1]);
      await service.validate(context);
    } catch (error) {
      authorizationFailure(res, error);
      return;
    }
    // No reusable session capability exists: credentials bind each request's server closure.
    const server = new McpServer({ name: "vectorize-mcp", version: "0.1.0" });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const originalSend = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try {
        await service.validate(context);
      } catch (error) {
        authorizationFailure(res, error);
        return;
      }
      await originalSend(message, options);
    };
    for (const name of Object.keys(toolSchemas) as ToolName[]) {
      const schema = toolSchemas[name];
      server.registerTool(
        "w_" + name,
        {
          description: toolDescriptions[name],
          inputSchema: schema,
          annotations: {
            readOnlyHint:
              name === "memory_search" ||
              name === "memory_get" ||
              name === "memory_config_get" ||
              name === "memory_bootstrap",
            destructiveHint:
              name === "memory_merge" || name === "memory_archive",
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args: Record<string, unknown>) => {
          try {
            await service.validate(context);
            const result = await service.call(
              context,
              name,
              args as Record<string, unknown>,
            );
            const isError =
              !!result &&
              typeof result === "object" &&
              "ok" in result &&
              result.ok === false;
            const data =
              result && typeof result === "object" && "data" in result
                ? (result.data as { status?: unknown } | undefined)
                : undefined;
            const needsReview =
              name === "memory_add" && data?.status === "needs_review";
            const silent =
              !isError &&
              !needsReview &&
              (name === "memory_add" ||
                name === "memory_update" ||
                (name === "memory_archive" && args.action !== "preview"));
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(silent ? { ok: true } : result),
                },
              ],
              ...(isError ? { isError: true } : {}),
            };
          } catch (error) {
            const candidate = error as { code?: unknown; retryable?: unknown };
            const code =
              typeof candidate?.code === "string" &&
              /^[A-Z_]+$/.test(candidate.code)
                ? candidate.code
                : "INTERNAL_ERROR";
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ok: false,
                    error: {
                      code,
                      message: "Memory operation failed",
                      retryable:
                        candidate.retryable === true ||
                        ["DB_BUSY", "RATE_LIMITED", "OVERLOADED"].includes(
                          code,
                        ),
                    },
                  }),
                },
              ],
            };
          }
        },
      );
    }
    res.once("close", () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "MCP request failed" },
          }),
        );
      } else res.destroy();
    }
  };
}
