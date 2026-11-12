# Figma Bridge MCP

A local [MCP](https://modelcontextprotocol.io) server and a Figma dev plugin that let an AI agent (Claude Code, Claude Desktop, or any MCP client) **read and edit the file open in the Figma desktop app**.

It runs entirely on your machine. There's no Figma API token, and it doesn't count against the cloud Figma MCP's tool-call quota.

```
MCP client ──stdio──> server/index.js ──ws://localhost:3056──> plugin (ui.html → code.js) ──> Figma file
```

## Tools

| Tool | What it does |
|---|---|
| `figma_status` | Shows the open file, its pages, the current page and the selection |
| `figma_run` | Runs [Plugin API](https://www.figma.com/plugin-docs/) JavaScript in the file. Top-level `await` works; use `return` to send back a result |
| `figma_screenshot` | Exports a node (or the selection or viewport) as a PNG. It returns the image and saves a copy to `shots/` |

## Requirements

- The **Figma desktop app**. Dev plugins don't run in the browser.
- Node.js 18 or newer.

## Setup

1. Install the server's packages:
   ```
   cd server
   npm install
   ```
2. Register the server with your MCP client. For Claude Code:
   ```
   claude mcp add figma-bridge -s user -- node "C:/path/to/Figma-Bridge-MCP/server/index.js"
   ```
   For Claude Desktop, or any client that uses an `mcpServers` JSON config:
   ```json
   {
     "mcpServers": {
       "figma-bridge": { "command": "node", "args": ["C:/path/to/Figma-Bridge-MCP/server/index.js"] }
     }
   }
   ```
3. Import the plugin: in the Figma desktop app, open **Plugins → Development → Import plugin from manifest…** and pick `plugin/manifest.json`.

## Each session

1. Open your file in Figma desktop.
2. Run **Plugins → Development → Figma Bridge**.
3. The dot turns green when it connects. You can collapse the plugin window or cover it, but keep the file open.

## Notes

- **Local only:** the server only listens on loopback (127.0.0.1 and ::1), and the plugin's network access is limited to `ws://localhost:3056`.
- **`figma_run` runs any code it's given** with full edit rights to the open file. Only connect clients you trust, and use Figma's version history to undo.
- **Several agent sessions can share one plugin.** Every MCP client session starts its own server:
  - The first one to start owns port 3056 and acts as the hub. Later sessions relay their requests through it.
  - If the hub closes, a relay takes over within about 2 s.
- **Changing the port:** set `FIGMA_BRIDGE_PORT`, then change the port in `plugin/manifest.json` and `plugin/ui.html` to match.
- **The current page persists between calls,** unlike the cloud `use_figma` tool.

## License

MIT, see [LICENSE](LICENSE). Figma is a trademark of Figma, Inc. This project isn't affiliated with or endorsed by Figma.
