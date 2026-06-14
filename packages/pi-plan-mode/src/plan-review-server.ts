import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export type PlanReviewAction = "approve" | "refine" | "exit";

export type PlanReviewAnnotation = {
	id: string;
	type: "comment" | "global";
	text: string;
	originalText?: string;
	location?: string;
	createdAt?: number;
};

export type PlanReviewDecision = {
	action: PlanReviewAction;
	feedback?: string;
	annotations: PlanReviewAnnotation[];
};

export type PlanReviewServer = {
	url: string;
	waitForDecision: () => Promise<PlanReviewDecision>;
	stop: () => void;
};

type StartPlanReviewServerOptions = {
	planFilePath: string;
	planHtml: string;
};

type DecisionBody = {
	action?: unknown;
	annotations?: unknown;
	note?: unknown;
};

export function formatPlanReviewFeedback(options: {
	planFilePath: string;
	annotations: PlanReviewAnnotation[];
	note?: string;
}): string {
	const { planFilePath, annotations, note } = options;
	const lines = [
		`Revise the HTML plan at \`${planFilePath}\` using this review feedback.`,
		"Address each comment directly in the plan, then call `exit_plan_mode` again for review.",
		"",
		"# Plan Review Feedback",
		"",
	];

	if (note?.trim()) {
		lines.push("## General reviewer note", "", blockquote(note.trim()), "");
	}

	if (annotations.length === 0) {
		lines.push("No inline annotations were submitted.");
		return lines.join("\n").trimEnd();
	}

	lines.push(`The reviewer left ${annotations.length} annotation${annotations.length === 1 ? "" : "s"}:`, "");

	annotations.forEach((annotation, index) => {
		const title = annotation.type === "global" ? "Global comment" : "Inline comment";
		lines.push(`## ${index + 1}. ${title}`, "");
		if (annotation.location) lines.push(`Location: ${annotation.location}`, "");
		if (annotation.originalText?.trim()) {
			lines.push("Selected plan text:", "", fenced(annotation.originalText.trim()), "");
		}
		lines.push("Reviewer comment:", "", blockquote(annotation.text.trim()), "");
	});

	return lines.join("\n").trimEnd();
}

export async function startPlanReviewServer(options: StartPlanReviewServerOptions): Promise<PlanReviewServer> {
	const basePath = `/review/${randomBytes(18).toString("hex")}`;
	let resolveDecision!: (decision: PlanReviewDecision) => void;
	const decisionPromise = new Promise<PlanReviewDecision>((resolve) => {
		resolveDecision = resolve;
	});
	let settled = false;

	const publishDecision = (decision: PlanReviewDecision): boolean => {
		if (settled) return false;
		settled = true;
		resolveDecision(decision);
		return true;
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		try {
			if (req.method === "GET" && url.pathname === "/") {
				res.writeHead(302, { location: `${basePath}/` });
				res.end();
				return;
			}

			if (req.method === "GET" && (url.pathname === basePath || url.pathname === `${basePath}/`)) {
				sendHtml(res, buildReviewHtml(options.planFilePath, basePath));
				return;
			}

			if (req.method === "GET" && url.pathname === `${basePath}/plan`) {
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
				});
				res.end(options.planHtml);
				return;
			}

			if (req.method === "POST" && url.pathname === `${basePath}/decision`) {
				const body = await parseJsonBody(req);
				const decision = parseDecisionBody(body, options.planFilePath);
				const accepted = publishDecision(decision);
				sendJson(res, { ok: true, duplicate: !accepted });
				return;
			}

			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("Not found");
		} catch (error) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid request" }));
		}
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Plan review server did not bind to a TCP port.");
	}

	const port = (address as AddressInfo).port;

	return {
		url: `http://127.0.0.1:${port}${basePath}/`,
		waitForDecision: () => decisionPromise,
		stop: () => server.close(),
	};
}

function parseDecisionBody(body: DecisionBody, planFilePath: string): PlanReviewDecision {
	const action = body.action === "approve" || body.action === "refine" || body.action === "exit"
		? body.action
		: undefined;
	if (!action) throw new Error("Invalid review action.");

	const annotations = normalizeAnnotations(body.annotations);
	const note = typeof body.note === "string" ? body.note.trim() : "";
	const feedback = action === "refine"
		? formatPlanReviewFeedback({ planFilePath, annotations, note })
		: note || undefined;

	return { action, feedback, annotations };
}

function normalizeAnnotations(value: unknown): PlanReviewAnnotation[] {
	if (!Array.isArray(value)) return [];

	return value.flatMap((raw): PlanReviewAnnotation[] => {
		if (!raw || typeof raw !== "object") return [];
		const item = raw as Record<string, unknown>;
		const text = typeof item.text === "string" ? item.text.trim() : "";
		if (!text) return [];
		const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `annotation-${Date.now()}`;
		const type = item.type === "global" ? "global" : "comment";
		return [{
			id,
			type,
			text,
			originalText: typeof item.originalText === "string" ? item.originalText : undefined,
			location: typeof item.location === "string" ? item.location : undefined,
			createdAt: typeof item.createdAt === "number" ? item.createdAt : undefined,
		}];
	});
}

function parseJsonBody(req: IncomingMessage): Promise<DecisionBody> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1_000_000) {
				req.destroy();
				reject(new Error("Request body too large."));
			}
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) as DecisionBody : {});
			} catch {
				reject(new Error("Invalid JSON body."));
			}
		});
		req.on("error", reject);
	});
}

function sendHtml(res: ServerResponse, body: string): void {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(body);
}

function sendJson(res: ServerResponse, body: unknown): void {
	res.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fenced(value: string): string {
	let fence = "```";
	while (value.includes(fence)) fence += "`";
	return `${fence}\n${value}\n${fence}`;
}

function blockquote(value: string): string {
	return value.split("\n").map((line) => `> ${line}`).join("\n");
}

function buildReviewHtml(planFilePath: string, basePath: string): string {
	const title = escapeHtml(planFilePath);
	const escapedBasePath = escapeHtml(basePath);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review plan</title>
<style>
:root { color-scheme: light dark; --bg:#0f172a; --panel:#111827; --panel2:#1f2937; --text:#e5e7eb; --muted:#94a3b8; --accent:#38bdf8; --border:#334155; --danger:#f87171; --ok:#34d399; --warn:#fbbf24; }
* { box-sizing:border-box; }
body { margin:0; height:100vh; overflow:hidden; background:var(--bg); color:var(--text); font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.app { display:grid; grid-template-columns:minmax(0,1fr) 360px; height:100vh; }
.plan-wrap { display:flex; flex-direction:column; min-width:0; }
header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); background:rgba(15,23,42,.95); }
header strong { white-space:nowrap; }
header code { color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
iframe { width:100%; flex:1; border:0; background:white; }
aside { border-left:1px solid var(--border); background:var(--panel); display:flex; flex-direction:column; min-height:0; }
.side-head { padding:14px 16px; border-bottom:1px solid var(--border); }
.side-head h1 { margin:0; font-size:18px; }
.hint { color:var(--muted); font-size:13px; margin:6px 0 0; }
.composer { padding:12px 16px; border-bottom:1px solid var(--border); background:rgba(31,41,55,.72); display:none; }
.composer.active { display:block; }
.selected { max-height:96px; overflow:auto; color:var(--muted); font-size:12px; border-left:3px solid var(--accent); padding-left:8px; margin-bottom:8px; white-space:pre-wrap; }
textarea { width:100%; min-height:92px; resize:vertical; border:1px solid var(--border); border-radius:10px; background:#020617; color:var(--text); padding:10px; font:inherit; }
.row { display:flex; gap:8px; align-items:center; margin-top:8px; }
button { border:1px solid var(--border); background:var(--panel2); color:var(--text); padding:8px 10px; border-radius:9px; cursor:pointer; font:inherit; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); color:#082f49; border-color:var(--accent); font-weight:700; }
button.ok { background:var(--ok); color:#052e16; border-color:var(--ok); font-weight:700; }
button.danger { color:var(--danger); }
button:disabled { opacity:.45; cursor:not-allowed; }
.annotations { flex:1; min-height:0; overflow:auto; padding:10px; }
.annotation { border:1px solid var(--border); background:rgba(15,23,42,.62); border-radius:12px; padding:10px; margin-bottom:10px; }
.annotation .meta { color:var(--muted); font-size:12px; display:flex; justify-content:space-between; gap:8px; }
.annotation blockquote { margin:8px 0; color:var(--muted); border-left:3px solid var(--border); padding-left:8px; white-space:pre-wrap; }
.annotation p { white-space:pre-wrap; margin:8px 0 0; }
.actions { padding:12px 16px; border-top:1px solid var(--border); background:rgba(15,23,42,.96); }
.actions .row { align-items:stretch; }
.actions button { flex:1; }
.empty { color:var(--muted); text-align:center; margin-top:28px; font-size:14px; }
@media (max-width: 900px) { .app { grid-template-columns:1fr; grid-template-rows:minmax(0,1fr) 45vh; } aside { border-left:0; border-top:1px solid var(--border); } }
</style>
</head>
<body>
<div class="app">
  <section class="plan-wrap">
    <header><strong>Plan review</strong><code>${title}</code></header>
    <iframe id="plan" sandbox="allow-same-origin" src="${escapedBasePath}/plan"></iframe>
  </section>
  <aside>
    <div class="side-head">
      <h1>Review comments</h1>
      <p class="hint">Select text inside the plan to comment, or add a global comment.</p>
      <div class="row"><button id="globalBtn">Add global comment</button><button id="clearSelectionBtn">Clear selection</button></div>
    </div>
    <div id="composer" class="composer">
      <div id="selected" class="selected"></div>
      <textarea id="comment" placeholder="Write review feedback for this selection..."></textarea>
      <div class="row"><button class="primary" id="saveComment">Save comment</button><button id="cancelComment">Cancel</button></div>
    </div>
    <div id="annotations" class="annotations"><div class="empty">No comments yet.</div></div>
    <div class="actions">
      <textarea id="note" placeholder="Optional overall note..." style="min-height:70px"></textarea>
      <div class="row"><button class="ok" id="approve">Approve and execute</button><button class="primary" id="refine">Submit feedback</button></div>
      <div class="row"><button class="danger" id="exit">Exit plan mode</button></div>
    </div>
  </aside>
</div>
<script>
const frame = document.getElementById('plan');
const composer = document.getElementById('composer');
const selected = document.getElementById('selected');
const comment = document.getElementById('comment');
const annotationsEl = document.getElementById('annotations');
const note = document.getElementById('note');
let annotations = [];
let pending = null;

function planDocument() { return frame.contentDocument || frame.contentWindow?.document; }

function setPending(next) {
  pending = next;
  if (!pending) {
    composer.classList.remove('active');
    comment.value = '';
    selected.textContent = '';
    return;
  }
  composer.classList.add('active');
  selected.textContent = pending.originalText ? pending.originalText : 'Global comment';
  comment.value = '';
  setTimeout(() => comment.focus(), 0);
}

function readSelection() {
  const win = frame.contentWindow;
  const doc = planDocument();
  const selection = win?.getSelection();
  if (!doc || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(0).cloneRange();
  return { originalText: text, range, location: findLocation(doc, range) };
}

function findLocation(doc, range) {
  const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  let location = '';
  for (const heading of headings) {
    const relation = heading.compareDocumentPosition(node);
    if (heading === node || heading.contains(node) || relation & Node.DOCUMENT_POSITION_FOLLOWING) {
      location = heading.textContent.trim();
    }
  }
  return location || doc.title || 'Plan';
}

function highlightRange(range, id) {
  const doc = planDocument();
  if (!doc) return;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue.trim()) continue;
    try { if (!range.intersectsNode(node)) continue; } catch { continue; }
    let start = node === range.startContainer ? range.startOffset : 0;
    let end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (end > start) parts.push({ node, start, end });
  }
  parts.reverse().forEach(({ node, start, end }) => {
    const markRange = doc.createRange();
    markRange.setStart(node, start);
    markRange.setEnd(node, end);
    const mark = doc.createElement('mark');
    mark.dataset.planReviewAnnotation = id;
    mark.style.background = 'rgba(251, 191, 36, .45)';
    mark.style.borderBottom = '2px solid rgb(245, 158, 11)';
    mark.style.cursor = 'pointer';
    mark.title = 'Plan review comment';
    mark.addEventListener('click', () => focusAnnotation(id));
    try { markRange.surroundContents(mark); } catch {}
  });
}

function removeHighlight(id) {
  const doc = planDocument();
  doc?.querySelectorAll('[data-plan-review-annotation="' + CSS.escape(id) + '"]').forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  });
}

function savePending() {
  if (!pending) return;
  const text = comment.value.trim();
  if (!text) return;
  const annotation = {
    id: 'ann-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    type: pending.type || 'comment',
    text,
    originalText: pending.originalText,
    location: pending.location,
    createdAt: Date.now(),
  };
  annotations.push(annotation);
  if (pending.range) highlightRange(pending.range, annotation.id);
  frame.contentWindow?.getSelection()?.removeAllRanges();
  setPending(null);
  renderAnnotations();
}

function deleteAnnotation(id) {
  annotations = annotations.filter((annotation) => annotation.id !== id);
  removeHighlight(id);
  renderAnnotations();
}

function focusAnnotation(id) {
  const card = document.querySelector('[data-annotation-card="' + CSS.escape(id) + '"]');
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card?.animate([{ outlineColor: 'rgba(56,189,248,1)' }, { outlineColor: 'rgba(56,189,248,0)' }], { duration: 900 });
}

function renderAnnotations() {
  if (annotations.length === 0) {
    annotationsEl.innerHTML = '<div class="empty">No comments yet.</div>';
    return;
  }
  annotationsEl.innerHTML = '';
  annotations.forEach((annotation, index) => {
    const card = document.createElement('div');
    card.className = 'annotation';
    card.dataset.annotationCard = annotation.id;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<span>' + (index + 1) + '. ' + escapeText(annotation.type === 'global' ? 'Global comment' : (annotation.location || 'Inline comment')) + '</span>';
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'danger';
    del.onclick = () => deleteAnnotation(annotation.id);
    meta.appendChild(del);
    card.appendChild(meta);
    if (annotation.originalText) {
      const quote = document.createElement('blockquote');
      quote.textContent = annotation.originalText;
      card.appendChild(quote);
    }
    const text = document.createElement('p');
    text.textContent = annotation.text;
    card.appendChild(text);
    annotationsEl.appendChild(card);
  });
}

function escapeText(value) {
  return value.replace(/[&<>"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
}

async function submit(action) {
  document.querySelectorAll('.actions button').forEach((button) => button.disabled = true);
  try {
    const response = await fetch('${escapedBasePath}/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, annotations, note: note.value }),
    });
    if (!response.ok) throw new Error(await response.text());
    document.body.innerHTML = '<div style="font-family:system-ui;padding:40px;color:#e5e7eb;background:#0f172a;height:100vh"><h1>Review submitted</h1><p>You can close this tab.</p></div>';
  } catch (error) {
    alert('Failed to submit review: ' + error.message);
    document.querySelectorAll('.actions button').forEach((button) => button.disabled = false);
  }
}

frame.addEventListener('load', () => {
  const doc = planDocument();
  doc?.addEventListener('mouseup', () => {
    const selection = readSelection();
    if (selection) setPending(selection);
  });
  doc?.addEventListener('keyup', () => {
    const selection = readSelection();
    if (selection) setPending(selection);
  });
});

document.getElementById('globalBtn').onclick = () => setPending({ type: 'global', location: 'Global' });
document.getElementById('clearSelectionBtn').onclick = () => { frame.contentWindow?.getSelection()?.removeAllRanges(); setPending(null); };
document.getElementById('saveComment').onclick = savePending;
document.getElementById('cancelComment').onclick = () => setPending(null);
document.getElementById('approve').onclick = () => submit('approve');
document.getElementById('refine').onclick = () => submit('refine');
document.getElementById('exit').onclick = () => submit('exit');
comment.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') savePending();
});
</script>
</body>
</html>`;
}
