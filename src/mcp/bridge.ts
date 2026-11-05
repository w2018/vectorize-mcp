import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { toolSchemas, type ToolName } from "./schemas.js";

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
function transient(error: unknown): boolean {
  if (error instanceof StreamableHTTPError)
    return (
      error.code === 408 ||
      error.code === 429 ||
      error.code === 502 ||
      error.code === 503 ||
      error.code === 504
    );
  if (error instanceof TypeError) return true; // fetch transport failures only
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
/** Retries immutable logical operations, never regenerating request IDs or changing arguments. */
export async function callWithRetry<T>(
  tool: string,
  args: Record<string, unknown>,
  call: (tool: string, args: Record<string, unknown>) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5)
    throw new Error("Retry attempts must be 1–5");
  // Validate before touching the network. Unknown tools are forwarded once only.
  // Public tool names carry the w_ prefix; schema keys stay unprefixed.
  const internal = tool.startsWith("w_") ? tool.slice(2) : tool;
  const known = Object.prototype.hasOwnProperty.call(toolSchemas, internal);
  if (known) toolSchemas[internal as ToolName].parse(args);
  const snapshot = JSON.stringify(args);
  const safe =
    known &&
    (internal === "memory_get" ||
      internal === "memory_config_get" ||
      typeof args.request_id === "string");
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await call(
        tool,
        JSON.parse(snapshot) as Record<string, unknown>,
      );
      // Domain/schema/conflict errors are returned intact, never automatically retried.
      return result;
    } catch (error) {
      if (!safe || attempt + 1 >= attempts || !transient(error)) throw error;
      const ceiling = Math.min(2000, (options.delayMs ?? 150) * 2 ** attempt);
      await (
        options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(Math.floor(ceiling * (0.5 + (options.random ?? Math.random)() * 0.5)));
    }
  }
}
export interface BridgeOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export function createBridge(options: BridgeOptions): {
  server: Server;
  client: Client;
  connect(): Promise<void>;
  close(): Promise<void>;
} {
  const url = new URL(options.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("Invalid MCP URL");
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Remote MCP connections require HTTPS");
  if (!options.token || /\s/.test(options.token))
    throw new Error("MCP token is required");
  const client = new Client({
    name: "vectorize-stdio-bridge",
    version: "0.1.0",
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: "Bearer " + options.token },
      redirect: "error",
    },
    fetch: async (input, init) =>
      (options.fetch ?? fetch)(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([
              init.signal,
              AbortSignal.timeout(options.timeoutMs ?? 15000),
            ])
          : AbortSignal.timeout(options.timeoutMs ?? 15000),
        redirect: "error",
      }),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const server = new Server(
    { name: "vectorize-stdio-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    client.listTools(request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callWithRetry(
      request.params.name,
      request.params.arguments ?? {},
      async (name, args) =>
        (await client.callTool({ name, arguments: args }, undefined, {
          timeout: options.timeoutMs ?? 15000,
        })) as CallToolResult,
    ),
  );
  return {
    server,
    client,
    connect: async () => {
      await client.connect(transport);
      await server.connect(new StdioServerTransport());
    },
    close: async () => {
      await server.close();
      await client.close();
    },
  };
}
export function bridgeOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BridgeOptions {
  if (!env.MCP_URL || !env.MCP_TOKEN)
    throw new Error("Set MCP_URL and MCP_TOKEN in the environment");
  return { url: env.MCP_URL, token: env.MCP_TOKEN };
}
