/*
 *	Figma Bridge MCP Server
 *
 *	Exposes the open Figma desktop file to MCP clients,
 *	relays scripts to the companion dev plugin over a localhost WebSocket,
 *	returns script results and PNG exports
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3056);
const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "shots");
const log = (...a) => console.error("[figma-bridge]", ...a);

// Every Claude session spawns its own copy of this server. The first one to bind the port becomes the
// hub that owns the plugin connection; later copies connect to the hub as relays, so any session can drive Figma.
let mode = null;
let plugin = null;
let pluginInfo = null;
let upstream = null;
let nextId = 1;
const pending = new Map();

const PLUGIN_HINT = "Figma plugin not connected. In Figma desktop run Plugins > Development > Figma Bridge.";

// Tracks one in-flight request and rejects it if no reply arrives in time.
function track(timeoutMs, resolve, reject)
{
	const id = nextId++;
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs);
	pending.set(id, { resolve, reject, timer });
	return id;
}

function settle(msg)
{
	const p = pending.get(msg.id);
	if (!p) return;
	pending.delete(msg.id);
	clearTimeout(p.timer);
	if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || "plugin error"));
}

function rejectAll(reason)
{
	for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); pending.delete(id); }
}

// Hub only: sends a request straight to the plugin.
function forwardToPlugin(type, payload, timeoutMs)
{
	if (!plugin || plugin.readyState !== 1) return Promise.reject(new Error(PLUGIN_HINT));
	return new Promise((resolve, reject) =>
	{
		const id = track(timeoutMs, resolve, reject);
		plugin.send(JSON.stringify({ ...payload, id, type }));
	});
}

// Sends one request to the plugin, directly when hub or through the hub when relay.
function request(type, payload, timeoutMs = 60000)
{
	if (mode === "hub") return forwardToPlugin(type, payload, timeoutMs);
	if (!upstream || upstream.readyState !== 1) return Promise.reject(new Error("Figma Bridge hub not reachable yet; try again in a few seconds."));
	return new Promise((resolve, reject) =>
	{
		const id = track(timeoutMs + 2000, resolve, reject);
		upstream.send(JSON.stringify({ ...payload, id, type, timeoutMs }));
	});
}

// Hub only: a socket is either the plugin (sends "hello") or another session's relay (sends "relay-hello").
function handleConnection(ws)
{
	let role = null;
	ws.on("message", async (raw) =>
	{
		let msg;
		try { msg = JSON.parse(raw.toString()); } catch { return; }
		if (msg.type === "hello")
		{
			if (plugin && plugin !== ws) plugin.close(4000, "replaced by newer plugin connection");
			role = "plugin"; plugin = ws; pluginInfo = msg.info;
			log("plugin connected:", pluginInfo?.fileName);
			return;
		}
		if (msg.type === "relay-hello") { role = "relay"; return; }
		if (role === "plugin") { settle(msg); return; }
		if (role === "relay")
		{
			const { id, type, timeoutMs, ...payload } = msg;
			try { ws.send(JSON.stringify({ id, ok: true, result: await forwardToPlugin(type, payload, timeoutMs || 60000) })); }
			catch (e) { if (ws.readyState === 1) ws.send(JSON.stringify({ id, ok: false, error: String(e?.message || e) })); }
		}
	});
	ws.on("close", () =>
	{
		if (role !== "plugin" || plugin !== ws) return;
		plugin = null; pluginInfo = null;
		rejectAll("plugin disconnected");
	});
}

function becomeRelay()
{
	mode = "relay";
	upstream = new WebSocket(`ws://127.0.0.1:${PORT}`);
	upstream.on("open", () => { upstream.send(JSON.stringify({ type: "relay-hello" })); log("relaying through existing hub"); });
	upstream.on("message", (raw) => { try { settle(JSON.parse(raw.toString())); } catch {} });
	upstream.on("error", () => {});
	upstream.on("close", () => { upstream = null; rejectAll("hub went away"); setTimeout(start, 1000 + Math.random() * 1000); });
}

// Bind to loopback only (IPv4 and IPv6) so nothing outside this PC can drive Figma.
// The plugin connects to "localhost", which Chromium may resolve to either family.
function start()
{
	mode = null;
	const v4 = new WebSocketServer({ host: "127.0.0.1", port: PORT });
	v4.on("error", (e) => { log("hub bind failed:", e.message); v4.close(); becomeRelay(); });
	v4.on("listening", () =>
	{
		mode = "hub";
		log(`hub listening on 127.0.0.1:${PORT}`);
		v4.on("connection", handleConnection);
		const v6 = new WebSocketServer({ host: "::1", port: PORT });
		v6.on("error", (e) => log("IPv6 bind failed:", e.message));
		v6.on("connection", handleConnection);
	});
}
start();

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });

const server = new McpServer({ name: "figma-bridge", version: "1.0.0" });

server.registerTool("figma_status", {
	description: "Report whether the Figma Bridge plugin is connected, and which file, page and pages are open.",
	inputSchema: {},
}, async () =>
{
	try { return text({ connected: true, via: mode, ...(await request("status", {}, 15000)) }); }
	catch (e) { return text({ connected: false, via: mode, reason: String(e?.message || e) }); }
});

server.registerTool("figma_run", {
	description: "Run Figma Plugin API JavaScript in the open file. Top-level await is allowed; use `return` to send back a JSON-serialisable value. `figma` is the global. Page context persists between calls (unlike the cloud use_figma tool).",
	inputSchema: {
		code: z.string().describe("Plugin API JavaScript body"),
		timeoutMs: z.number().int().min(1000).max(600000).optional().describe("Default 120000"),
	},
}, async ({ code, timeoutMs }) =>
{
	try { return text(await request("run", { code }, timeoutMs ?? 120000) ?? null); }
	catch (e) { return fail(e); }
});

server.registerTool("figma_screenshot", {
	description: "Export a node (or the current page's selection/viewport if omitted) as PNG. Returns the image and saves a copy under shots/ in the project folder.",
	inputSchema: {
		nodeId: z.string().optional().describe("Node ID like 5:2"),
		scale: z.number().min(0.05).max(4).optional().describe("Export scale; default fits the longest side to maxSize"),
		maxSize: z.number().int().min(64).max(4096).optional().describe("Longest side in px when scale is omitted (default 1600)"),
	},
}, async ({ nodeId, scale, maxSize }) =>
{
	try
	{
		const r = await request("export", { nodeId, scale, maxSize: maxSize ?? 1600 }, 120000);
		mkdirSync(SHOTS_DIR, { recursive: true });
		const file = join(SHOTS_DIR, `${(r.nodeId || "node").replace(/[^\w-]/g, "_")}.png`);
		writeFileSync(file, Buffer.from(r.base64, "base64"));
		return { content: [
			{ type: "image", data: r.base64, mimeType: "image/png" },
			{ type: "text", text: JSON.stringify({ nodeId: r.nodeId, name: r.name, width: r.width, height: r.height, saved: file }) },
		] };
	}
	catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
log("MCP stdio ready");
