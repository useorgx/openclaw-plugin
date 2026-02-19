# Setting up Conduit for Figma MCP proxying

This repo integrates OrgX design work with Figma via the [Conduit MCP plugin](https://github.com/eonist/conduit). Conduit stands up a local WebSocket server that the Figma plugin connects to, letting Codex agents send the same "create node"/"update style" commands as a user would in the UI.

## Steps

1. **Clone Conduit**  
   ```bash
   git clone https://github.com/eonist/conduit
   cd conduit
   npm install
   ```

2. **Run the WebSocket server**  
   ```bash
   bun run dist/socket.cjs
   ```  
   The log shows the port (default `3055`) and a `/status` endpoint. While the server is running, `curl http://localhost:3055/status` should return `200 OK` and a JSON payload. If the server logs `handshaking with MCP server failed` or `connection closed: initialize response`, check that Figma is connected before retrying; the server retries every 8 seconds.

   Optional preflight check from this repo:
   ```bash
   npm run verify:conduit-mcp
   npm run verify:conduit-mcp -- --require-channel
   ```
   Use `--require-channel` when you need to fail fast unless a live plugin channel is present.

3. **Open the OrgX dashboard file in Figma** and install the Conduit plugin (`Conduit MCP Plugin`). In the plugin panel, enter the port from step 2 and click **Connect**. If you want it to reconnect automatically, toggle **Auto connect to server**.

4. **Confirm channel readiness**  
   The plugin displays a **Channel id** once Figma has finished loading. Use that channel id (for example, `sk4fx8sp`) when referring to the active session from Codex so the MCP commands are routed correctly.

5. **Command flow**  
   - Codex (or another MCP client) sends a JSON command over the WebSocket.  
   - Conduit forwards the command to the Figma plugin API that creates nodes, sets styles, or adjusts Auto Layout.  
   - Conduit reports status back through the same WebSocket channel.

6. **Use the exported tokens**  
   Run `npm run export:design-tokens` (or `node scripts/export-design-tokens.mjs`) before authoring commands so Conduit can map token names like `colors.lime`, `spacing.3`, `radius.xl`, or `stateTones.active`. The JSON output lives in `artifacts/orgx-design-tokens.json`.

If you see connection errors (`Failed to connect to localhost port 3055`, `handshaking ... connection closed`), restart the Conduit server and re-open the plugin. The server automatically retries and logs each reconnect attempt.
