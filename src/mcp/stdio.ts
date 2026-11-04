import { createBridge, bridgeOptionsFromEnv } from "./bridge.js";

// stdout belongs exclusively to the official MCP stdio transport. Never log credentials.
try {
  const bridge = createBridge(bridgeOptionsFromEnv());
  await bridge.connect();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void bridge.close().finally(() => {
        process.exitCode = 0;
      });
    });
  process.stdin.once("end", () => {
    void bridge.close();
  });
} catch {
  process.stderr.write(
    "MCP bridge could not connect. Check URL, token and server availability.\n",
  );
  process.exitCode = 1;
}
