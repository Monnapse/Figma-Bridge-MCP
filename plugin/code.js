/*
 *	Figma Bridge Plugin (main thread)
 *
 *	Runs scripts sent by the local MCP server,
 *	exports nodes as PNG,
 *	reports file and page status
 */

figma.showUI(__html__, { width: 240, height: 72, themeColors: true });

// Matches the cloud use_figma helper so the same scripts run here.
function createAutoLayout(dir = "HORIZONTAL", props = {})
{
	const f = figma.createFrame();
	f.layoutMode = dir;
	f.primaryAxisSizingMode = "AUTO";
	f.counterAxisSizingMode = "AUTO";
	f.fills = [];
	f.clipsContent = false;
	return Object.assign(f, props);
}

// The real figma global is non-extensible, so scripts get a proxy that adds the cloud-only helpers.
// The target is an empty object because proxying figma itself breaks the invariants of its locked properties.
const figmaExt = new Proxy({}, {
	get: (_, k) =>
	{
		if (k === "createAutoLayout" && !figma.createAutoLayout) return createAutoLayout;
		const v = figma[k];
		return typeof v === "function" ? v.bind(figma) : v;
	},
	set: (_, k, v) => { figma[k] = v; return true; },
	has: (_, k) => k === "createAutoLayout" || k in figma,
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Strips functions, cycles and Figma handles so the result survives postMessage and JSON.
function toPlain(value)
{
	if (value === undefined) return null;
	const seen = new WeakSet();
	return JSON.parse(JSON.stringify(value, (k, v) =>
	{
		if (typeof v === "bigint") return Number(v);
		if (v && typeof v === "object")
		{
			if (seen.has(v)) return "[circular]";
			seen.add(v);
			if ("id" in v && "type" in v && typeof v.type === "string" && "parent" in v) return { id: v.id, type: v.type, name: v.name };
		}
		return v;
	}));
}

function status()
{
	return {
		fileName: figma.root.name,
		fileKey: figma.fileKey || null,
		currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
		pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
		selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type })),
	};
}

async function exportNode(msg)
{
	let node = msg.nodeId ? await figma.getNodeByIdAsync(msg.nodeId) : figma.currentPage.selection[0];
	if (!node) throw new Error(msg.nodeId ? `node ${msg.nodeId} not found` : "no nodeId and nothing selected");
	if (!("exportAsync" in node) || node.type === "PAGE") throw new Error(`${node.type} cannot be exported; pass a frame/section id`);
	const longest = Math.max(node.width, node.height, 1);
	const scale = msg.scale || Math.min(4, msg.maxSize / longest);
	const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
	return { nodeId: node.id, name: node.name, width: Math.round(node.width * scale), height: Math.round(node.height * scale), bytes };
}

figma.ui.onmessage = async (msg) =>
{
	if (msg.type === "ui-ready") { figma.ui.postMessage({ type: "info", info: status() }); return; }
	const reply = (ok, payload) => figma.ui.postMessage({ type: "reply", id: msg.id, ok, ...payload });
	try
	{
		if (msg.type === "status") reply(true, { result: status() });
		else if (msg.type === "run") reply(true, { result: toPlain(await new AsyncFunction("figma", msg.code)(figmaExt)) });
		else if (msg.type === "export") reply(true, { result: await exportNode(msg) });
		else reply(false, { error: `unknown request type ${msg.type}` });
	}
	catch (e)
	{
		reply(false, { error: e && e.message ? `${e.message}
${e.stack || ""}` : String(e) });
	}
};
