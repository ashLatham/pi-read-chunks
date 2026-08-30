/**
 * read-chunks — chunked read tool for large TEXT files.
 *
 * TEXT-ONLY. Binary files (PDF, archives, executables, images already handled
 * by read, etc.) are NOT supported by this tool — pass them through to read()
 * or another specialised tool. Boundary snapping, chunking, and LLM summarisation
 * all assume UTF-8 text.
 *
 * Overrides the built-in `read` tool for text files. Files under the configured
 * size threshold are read in full. Larger files are split into overlapping chunks
 * snapped to natural boundaries (function endings for code, paragraph breaks
 * for prose), and every chunk is summarised by the active model, chaining the
 * running summary forward as chunks are consumed.
 *
 * Modes:
 *   - No query: walk every chunk, accumulate one running summary, return it.
 *   - With query: walk chunks until one contains the answer; return the answer
 *     and per-chunk summaries. Stops early when found.
 *
 * There is no relevance ranking. Every chunk receives exactly one LLM summary.
 *
 * Chunk size is bounded by the `chunkChars` config value only — there is no
 * internal character cap on what is sent to the summariser. Size the chunk to
 * the active model's context window with prompt overhead in mind.
 *
 * A tool_call listener routes the model away from the built-in read() for
 * text/unknown files and toward read-chunks with a query. Image and binary
 * files are passed through to read() unchanged.
 * Chunk labels are line ranges (start-end), with char offsets in parentheses for
 * diagnostics; this tool's `offset` and `limit` arguments remain line-based like
 * the built-in read tool.
 *
 * Config is read from <cwd>/.pi/read-chunks.json merged over hard-coded defaults.
 * Unknown or invalid config values are ignored. Missing or malformed config
 * silently uses defaults. Config is loaded for each tool invocation, so changes
 * apply without restarting the extension.
 */

import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { Text, hyperlink, getCapabilities } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------- Config ----------

/** Timestamp suffix for per-invocation debug output: YYMMDD-hhmmss. */
function debugTimestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const DEFAULT_CONFIG = {
	thresholdKB: 10,
	chunkChars: 10_000,
	chunkOverlapChars: 800,


	codeExtensions: [
		".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
		".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
		".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
		".m", ".mm", ".sh", ".bash", ".zsh", ".fish",
		".lua", ".pl", ".php", ".scala", ".clj", ".ex", ".exs", ".elm",
		".hs", ".ml", ".fs", ".dart", ".zig", ".sql", ".vim",
	],
};

type ReadSafeConfig = typeof DEFAULT_CONFIG;

/** Load per-project settings. Deliberate degraded behavior: missing or malformed config preserves working defaults. */
function loadConfig(cwd: string): ReadSafeConfig {
	const cfgPath = join(cwd, ".pi", "read-chunks.json");
	if (!existsSync(cfgPath)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

// ---------- Image / binary pass-through ----------

/**
 * read-chunks is text-only. The built-in `read` tool handles images natively and
 * can also stream other binaries; this extension must not block those calls, or
 * the model loses its only way to inspect non-text files. The two lists below
 * are the pass-through set: any path whose extension matches either is left
 * alone and `read()` runs as if the extension were not installed.
 */

/** Raster + vector image formats the read tool renders natively. */
const IMAGE_EXTENSIONS = [
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
	".svg", ".tiff", ".tif", ".ico", ".heic", ".heif",
];

/** Non-text binary formats read() can deliver as bytes. Add to this list to allow. */
const BINARY_EXTENSIONS = [
	// Documents
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf",
	// Archives
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz", ".tbz2", ".txz",
	// Executables / objects
	".exe", ".dll", ".so", ".dylib", ".o", ".a", ".obj", ".lib", ".class", ".jar",
	// Media (audio/video — read will likely refuse, but no harm in passing through)
	".mp3", ".mp4", ".m4a", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".ogg", ".wav", ".flac",
	// Other binary blobs
	".bin", ".dat", ".iso", ".img", ".dmg",
];

function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.includes(extname(path).toLowerCase());
}

function isBinaryPath(path: string): boolean {
	return BINARY_EXTENSIONS.includes(extname(path).toLowerCase());
}

// ---------- Language detection ----------

function isCode(path: string, codeExtensions: string[]): boolean {
	return codeExtensions.includes(extname(path).toLowerCase());
}

// ---------- Boundary snapping ----------

interface ChunkRange {
	start: number;
	end: number;
}

/** Last natural boundary at or before `target`. Code → `}` line / blank; text → `\r?\n\r?\n` / `\r?\n`. */
function snapBackward(text: string, target: number, codeMode: boolean): number {
	if (target >= text.length) return text.length;
	if (target <= 0) return 0;

	const windowStart = Math.max(0, target - 2000);
	const slice = text.slice(windowStart, target);
	let boundary = -1;

	if (codeMode) {
		const braceRe = /^[ \t]*\}[ \t]*$/gm;
		let m: RegExpExecArray | null;
		let lastMatch: RegExpExecArray | null = null;
		while ((m = braceRe.exec(slice)) !== null) lastMatch = m;
		if (lastMatch) {
			boundary = windowStart + lastMatch.index + lastMatch[0].length;
		} else {
			const blankRe = /\r?\n[ \t]*\r?\n/g;
			let lastBlank: RegExpExecArray | null = null;
			while ((m = blankRe.exec(slice)) !== null) lastBlank = m;
			if (lastBlank) boundary = windowStart + lastBlank.index;
		}
	} else {
		const paraRe = /\r?\n[ \t]*\r?\n/g;
		let m: RegExpExecArray | null;
		let lastPara: RegExpExecArray | null = null;
		while ((m = paraRe.exec(slice)) !== null) lastPara = m;
		if (lastPara) {
			boundary = windowStart + lastPara.index;
		} else {
			const lineRe = /\r?\n/g;
			let lastLine: RegExpExecArray | null = null;
			while ((m = lineRe.exec(slice)) !== null) lastLine = m;
			if (lastLine) boundary = windowStart + lastLine.index;
		}
	}

	return boundary >= 0 ? boundary : target;
}

/** Next natural boundary at or after `target`. */
function snapForward(text: string, target: number, codeMode: boolean): number {
	if (target <= 0) return 0;
	if (target >= text.length) return text.length;

	const windowEnd = Math.min(text.length, target + 2000);
	const slice = text.slice(target, windowEnd);

	if (codeMode) {
		const declRe = /^[ \t]*(?:function |def |fn |pub fn |async fn |class |struct |interface |trait |impl |module |package |export |async function )/gm;
		const m = declRe.exec(slice);
		if (m) return target + m.index;
		const blankRe = /\r?\n[ \t]*\r?\n/g;
		const mb = blankRe.exec(slice);
		if (mb) return target + mb.index + 1;
	} else {
		const paraRe = /\r?\n[ \t]*\r?\n/g;
		const m = paraRe.exec(slice);
		if (m) return target + m.index;
		const lineRe = /\r?\n/g;
		const ml = lineRe.exec(slice);
		if (ml) return target + ml.index + 1;
	}

	return target;
}

// ---------- Chunking ----------

/**
 * Build ordered, non-empty chunks with a best-effort overlap.
 * If a natural boundary cannot provide safe forward progress, the next chunk
 * begins at the previous end rather than stalling or creating an empty range.
 */
function buildChunks(
	text: string,
	chunkSize: number,
	overlap: number,
	codeMode: boolean,
): ChunkRange[] {
	const chunks: ChunkRange[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const endTarget = Math.min(text.length, cursor + chunkSize);
		let end = snapBackward(text, endTarget, codeMode);
		if (end <= cursor) end = endTarget;
		chunks.push({ start: cursor, end });
		if (end >= text.length) break;

		const nextStart = Math.max(0, end - overlap);
		const snapped = snapForward(text, nextStart, codeMode);
		cursor = snapped <= cursor ? end : snapped;
	}

	return chunks;
}

// ---------- LLM summarisation ----------

const UNSUMMARISED = "<summarisation unavailable>";
const ANSWER_MARKER = "| ANSWER:";
const FACT_GUARD = "Do not invent facts; base everything on the chunk.";

/** Append prior-summary and chunk blocks to the prompt. Shared by query and summary modes. */
function pushChunkBlock(parts: string[], range: ChunkRange, chunkText: string, priorSummary: string, hasPriorSummary: boolean): void {
	if (hasPriorSummary) {
		parts.push("", "Prior summary (for context):", '"""', priorSummary, '"""');
	}
	// Send the whole chunk; size is governed by config.chunkChars, not capped here.
	parts.push("", `Current chunk (chars ${range.start}-${range.end}):`, '"""', chunkText, '"""', "", "Summary of current chunk:");
}

/**
 * Build the prompt for one summarisation call.
 * Two modes share most of their structure: query mode adds an ANSWER-marker
 * instruction and includes the query; summary mode omits both.
 */
function buildSummarisePrompt(
	chunkText: string,
	priorSummary: string,
	query: string | undefined,
	range: ChunkRange,
): string {
	const parts: string[] = [];
	const hasPriorSummary = priorSummary.trim().length > 0;

	if (query) {
		parts.push(
			`You are scanning a large file one chunk at a time, looking for information relevant to this query: "${query}".`,
			"Read the NEXT chunk and produce a NEW summary of THIS CHUNK.",
			hasPriorSummary
				? "Include any relevant context from the prior summary below, but the summary should be focused on the new chunk. Do NOT repeat or echo the prior summary. Write a fresh summary of the CURRENT chunk."
				: `Write a fresh summary of the CURRENT chunk. Be concise and factual. ${FACT_GUARD}`,
			'If this chunk contains information that FULLY answers the query, begin your reply with exactly "| ANSWER:" ' +
				'followed by the precise answer passage, then a newline, then "---", then your NEW summary of this chunk.',
			"Otherwise reply with ONLY your NEW summary of this chunk (no marker, no separator).",

			"CRITICAL: Only emit the \"| ANSWER:\" marker if the chunk alone provides the COMPLETE answer to the query.",
			"If the query requires information from multiple parts of the file (e.g., a synopsis, comparison, timeline),",
			"do NOT mark individual chunks as answers. Continue reading until either the complete answer is found",
			"or the file has been fully read.",
			FACT_GUARD,
		);
		parts.push("", `Query: "${query}`);
	} else {
		parts.push("You are reading a large file one chunk at a time.");
		if (hasPriorSummary) {
			parts.push(
				"The following is a running summary of the parts already seen. It is for CONTEXT ONLY.",
				"Read the NEXT chunk and produce a NEW summary of THIS CHUNK. Include any relevant context from the prior summary, but the summary should be focused on the new chunk.",
				"Do NOT repeat or echo the prior summary. Write a fresh summary of the CURRENT chunk.",
			);
		} else {
			parts.push(`Read the NEXT chunk and produce a NEW summary of THIS CHUNK. Be concise and factual. ${FACT_GUARD}`);
		}
	}

	pushChunkBlock(parts, range, chunkText, priorSummary, hasPriorSummary);
	return parts.join("\n");
}

/**
 * Summarise one chunk against the running summary.
 *
 * Size contract: `chunkText` is sent verbatim, bounded only by config.chunkChars.
 * Returns null when the model can't be reached/authed (caller keeps prior summary).
 *
 * `priorSummary` accumulates across calls in the caller; in query mode the reply
 * is parsed by `parseAnswerResponse` for the ANSWER marker and separator.
 */
async function summariseChunk(
	chunkText: string,
	priorSummary: string,
	query: string | undefined,
	range: ChunkRange,
	filePath: string,
	modelRegistry: any,
	model: any,  // Model<any> — passed directly to modelRegistry.complete
	debugPath: string | null,
	debugEnabled: boolean,
): Promise<string | null> {
	if (!model) return null;
	try {
		if (!modelRegistry.hasConfiguredAuth(model)) return null;
	} catch {
		return null;
	}

	// File content and query are untrusted prompt text. Delimiters improve structure
	// but do not neutralize instructions embedded in their contents.
	const prompt = buildSummarisePrompt(chunkText, priorSummary, query, range);

	const requestPayload = {
		model: model.id,
		messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
	};

	if (debugEnabled) {
		appendFileSync(debugPath, JSON.stringify({ phase: "llm_request", chunk: `${range.start}-${range.end}`, payload: requestPayload }, null, 2) + "\n");
	}

	let response;
	try {
		response = await modelRegistry.complete(
			model,
			requestPayload,
		);
	} catch {
		return null;
	}

	if (debugEnabled) {
		appendFileSync(debugPath, JSON.stringify({ phase: "llm_response", chunk: `${range.start}-${range.end}`, response: response }, null, 2) + "\n");
	}

	const contentBlocks = response?.content || [];
	const textBlocks = contentBlocks.filter((c: any) => c.type === "text");
	if (textBlocks.length === 0) return null;
	const summary = textBlocks.map((c: any) => c.text).join(" ").trim();
	return summary || null;
}

/** Parse the query-mode contract out of an LLM reply. */
function parseAnswerResponse(text: string): { answer?: string; summary: string } {
	const idx = text.indexOf(ANSWER_MARKER);
	if (idx < 0) return { summary: text.trim() };
	const after = text.slice(idx + ANSWER_MARKER.length);
	const sep = after.indexOf("\n---\n");
	let answer: string;
	let rest: string;
	if (sep >= 0) {
		answer = after.slice(0, sep).trim();
		rest = after.slice(sep + "\n---\n".length).trim();
	} else {
		answer = after.trim();
		rest = "";
	}
	return { answer, summary: rest };
}

// ---------- Main tool ----------

const ReadParams = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute). Optional `:START-END` (inclusive 1-indexed line span) or `:N` (start at line N, read to EOF) suffix selects a line range and bypasses summarisation." }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	query: Type.Optional(Type.String({ description: "Optional search query. When provided, scan stops at the first chunk that answers it." })),
});

export default function (pi: ExtensionAPI) {
	// Session-only flags — defaults ON / OFF respectively. /read-chunks [debug]
	let summaryCompressionEnabled = true;
	let debugReturnEnabled = false;

	 pi.registerCommand("read-chunks", {
		description: "Toggle summary (default: on) when file size > configKB. 'debug' to toggle per-invocation /tmp/read-chunks_<YYMMDD-hhmmss>.json (default: off).",
		handler: async (args, ctx) => {
			const tokens = (args ?? "").trim().toLowerCase().split(/\s+/);
			const wantDebug = tokens.includes("debug");
			if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "")) {
				summaryCompressionEnabled = !summaryCompressionEnabled;
				if (ctx.hasUI) {
					ctx.ui.notify(`read-chunks summary compression: ${summaryCompressionEnabled ? "ON" : "OFF"}`, "info");
				}
				return;
			}
			if (wantDebug) {
				debugReturnEnabled = !debugReturnEnabled;
				if (ctx.hasUI) {
					ctx.ui.notify(`read-chunks debug: ${debugReturnEnabled ? "ON" : "OFF"}`, "info");
				}
			}
		},
	});

	pi.registerTool({
		name: "read-chunks",
		label: "read-chunks (chunked scan)",
		description:
			"TEXT-ONLY. Use instead of the built-in read() for text files.",
		parameters: ReadParams,

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			let { path: rawPath, offset, limit } = params;

			// Accept the `file.txt:X-Y` line-range shorthand (inclusive 1-indexed
			// line span) and `file.txt:N` (start at line N, read to EOF) alongside
			// explicit offset/limit. Strip the suffix and convert it to
			// offset/start-line + limit/count.
			if (typeof rawPath === "string") {
				const m = rawPath.match(/:(\d+)(?:-(\d+))?$/);
				if (m && !offset && !limit) {
					const startLine = Number(m[1]);
					const endLine = m[2] !== undefined ? Number(m[2]) : undefined;
					rawPath = rawPath.slice(0, m.index);
					offset = startLine;
					if (endLine !== undefined) {
						limit = Math.max(1, endLine - startLine + 1);
					}
				}
			}
			const absolutePath = resolve(ctx.cwd, rawPath);
			const config = loadConfig(ctx.cwd);

			// Per-invocation timestamp so each run appends to its own file.
			const debugReturnPath = debugReturnEnabled ? `/tmp/read-chunks_${debugTimestamp()}.json` : null;

			let stat;
			try {
				stat = statSync(absolutePath);
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: cannot stat "${rawPath}": ${e.message}` }],
					details: { error: true },
				};
			}

			if (!stat.isFile()) {
				return {
					content: [{ type: "text", text: `Error: "${rawPath}" is not a regular file` }],
					details: { error: true },
				};
			}

			let content: string;
			try {
				content = readFileSync(absolutePath, "utf-8");
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error reading "${rawPath}": ${e.message}` }],
					details: { error: true },
				};
			}

			// Explicit offset/limit request → return those lines verbatim.
			// Bypasses threshold/chunk/query logic; matches built-in read semantics.
			if (offset !== undefined || limit !== undefined) {
				const lines = content.split("\n");
				const startLine = Math.max(0, (offset ?? 1) - 1);
				const endLine = limit ? Math.min(startLine + limit, lines.length) : lines.length;
				const sliced = lines.slice(startLine, endLine).join("\n");
				return {
					content: [{ type: "text", text: sliced }],
					details: {
						mode: "range",
						path: absolutePath,
						lines: `${startLine + 1}-${endLine}`,
						chars: sliced.length,
					},
				};
			}

			const sizeKB = stat.size / 1024;
			const codeMode = isCode(rawPath, config.codeExtensions);

			// Small file → full read
			if (sizeKB <= config.thresholdKB) {
				return {
					content: [{ type: "text", text: content }],
					details: {
						mode: "full",
						path: absolutePath,
						kbTotal: Math.round(sizeKB * 10) / 10,
						chars: content.length,
					},
				};
			}

			// Large file → chunked summarisation
			const chunks = buildChunks(content, config.chunkChars, config.chunkOverlapChars, codeMode);
			const totalKB = Math.round((stat.size / 1024) * 10) / 10;

			// Map char offsets → 1-indexed line numbers so chunk labels match how the
			// agent reasons (built-in read uses line#, not char#). Precomputed once,
			// binary-searched per chunk (O(n log n)).
			const lineStarts = [0];
			for (let i = 0; i < content.length; i++) {
				if (content[i] === "\n") lineStarts.push(i + 1);
			}
			const lineOfChar = (pos: number): number => {
				let lo = 0, hi = lineStarts.length - 1, ans = -1;
				while (lo <= hi) {
					const mid = (lo + hi) >> 1;
					if (lineStarts[mid] <= pos) { ans = mid; lo = mid + 1; }
					else hi = mid - 1;
				}
				return ans + 1;
			};
			const lineSpan = (range: ChunkRange): string => {
				const s = lineOfChar(range.start);
				// End is an exclusive offset: last included char is range.end - 1.
				const e = range.end >= content.length ? lineStarts.length : lineOfChar(range.end - 1);
				return `${s}-${e}`;
			};

			const query = typeof params.query === "string" && params.query.trim().length > 0
				? params.query.trim()
				: undefined;

			// Find a model: try ctx.model first (set during conversation), then fall back to any available model.
			let activeModel = ctx.model;
			if (!activeModel) {
				try {
					const available = await ctx.modelRegistry.getAvailable();
					if (available.length > 0) activeModel = available[0];
				} catch {
					// no model available
				}
			}
			if (!activeModel) {
				return {
					content: [{ type: "text", text: `Error: no model available for summarisation` }],
					details: { error: true },
				};
			}

			let runningSummary = "";
			const perChunk: Array<{ chunk: string; summary: string }> = [];
			let stopReason = "completed" as const;
			let answer: string | undefined = undefined;

			for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
				const range = chunks[chunkIdx];
				const text = content.slice(range.start, range.end);
				const label = `${lineSpan(range)} (chars ${range.start}-${range.end})`;

				ctx.ui.notify(`read-chunks: ${label} (chunk ${chunkIdx + 1}/${chunks.length})`, "info");

				const noteRaw = await summariseChunk(
					text, runningSummary, query, range, rawPath,
					ctx.modelRegistry, activeModel,
					debugReturnPath, debugReturnEnabled,
				);

				if (noteRaw) runningSummary = noteRaw;
				let displayNote = noteRaw ?? UNSUMMARISED;

				// In query mode, extract answer and use parsed summary for display.
				if (query && noteRaw) {
					const parsed = parseAnswerResponse(noteRaw);
					if (parsed.answer !== undefined) {
						answer = parsed.answer;
						runningSummary = parsed.summary;
						displayNote = parsed.summary;
						stopReason = "answer_found";
					}
					runningSummary = parsed.summary;
					displayNote = parsed.summary;
				}

				perChunk.push({ chunk: label, summary: displayNote });

				if (stopReason === "answer_found") break;
			}

			const toolReturn = {
				mode: query ? "query" : "summary",
				file: absolutePath,
				kb_total: totalKB,
				chunks_scanned: chunks.length,
				chunks_read: perChunk.length,
				stop_reason: stopReason,
				query: query ?? null,
				answer: query ? (answer ?? null) : null,
				summary: !query ? runningSummary : null,
				chunks: perChunk,
			};

			// Write final tool return to debug file
			if (debugReturnEnabled) {
				try {
					appendFileSync(debugReturnPath, JSON.stringify({ phase: "tool_return", result: toolReturn }, null, 2) + "\n");
				} catch {}
			}

			return {
				content: [{ type: "text", text: `[read-chunks:chunked]\n${JSON.stringify(toolReturn, null, 2)}` }],
				details: {
					mode: "chunked",
					path: absolutePath,
					kbTotal: totalKB,
					chunksScanned: chunks.length,
				},
			};
		},

		// Mirror the built-in read() call header so the UI shows
		// `read-chunks <path>:<line-start-line-end>` (+ optional `[query: ...]`)
		// instead of just the bare tool name. Built-in tools render their header via
		// a custom renderCall; custom tools fall back to the plain tool-name fallback,
		// so we supply one here.
		renderCall(args, theme, context) {
			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(formatReadChunksCall(args, theme, context.cwd));
			return text;
		},

		// Full-file results keep built-in read presentation behavior. Chunked results
		// are emitted as JSON because the model needs structured diagnostic metadata.
	});

	// Calls to the built-in read() are routed as follows:
	//   - Image files (png/jpg/gif/...) → pass through; read() returns image content.
	//   - Other binary files (pdf/zip/docx/...) → pass through; read() delivers bytes.
	//   - Targeted line-range reads (offset and/or limit set) → pass through;
	//     native read() serves them. These are scoped, summarisation-free.
	//   - Line-range suffixes (:N or :START-END) on `path` → strip suffix,
	//     translate to native read()'s offset/limit by mutating event.input,
	//     and let native read() execute. Native read() does not understand the
	//     suffix form, so the rewrite is required.
	//   - Text files (and unknown extensions) without a range → block, route
	//     model to read-chunks.
	// The returned reason is surfaced to the model for its continuation; omitting
	// terminate keeps the turn alive so the model reroutes to read-chunks.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "read") return;
		const input = event.input as { path?: unknown; offset?: number; limit?: number } | undefined;
		const path = typeof input?.path === "string" ? input.path : "";
		if (path && (isImagePath(path) || isBinaryPath(path))) return;

		// Targeted line-range read: native read() handles it cheaply and the model
		// already uses this form (offset/limit) because the read tool's schema
		// documents it. Bypass the block — these are scoped, summarisation-free
		// reads, exactly the kind we want read() to serve directly.
		const hasExplicitRange = typeof input?.offset === "number" || typeof input?.limit === "number";
		if (hasExplicitRange) return;

		// Numeric line-range suffix (:N or :START-END): strip it from `path` and
		// translate to native read()'s offset/limit, mutating event.input in place.
		// Per the extension API contract, in-place mutation patches the args that
		// the tool will execute with — no re-validation occurs after.
		//
		// Requires at least one char before the `:digits` (`.+`, not `.*?`) so
		// that bare `:50` is rejected (a path cannot be `:50`) and so the engine
		// picks the *last* colon-separator when the path itself contains colons
		// (e.g. Windows `C:\Users\x\file.txt:10` or any URL-like prefix).
		const m = path.match(/^(.+):(\d+)(?:-(\d+))?$/);
		if (m) {
			const newPath = m[1];
			const startLine = Number(m[2]);
			const endLine = m[3] !== undefined ? Number(m[3]) : undefined;
			input!.path = newPath;
			input!.offset = startLine;
			if (endLine !== undefined) {
				input!.limit = Math.max(1, endLine - startLine + 1);
			} else {
				delete input!.limit;
			}
			return;
		}

		return {
			block: true,
			reason: "For text files: use read-chunks(path/file) or  read-chunks(path/file, query) with a concise query describing what you are looking for or read-chunks(path/file):linestart-lineend for a bounded file read.",
		};
	});

	// Compress chunked-mode results so raw JSON does not bloat model context.
	// This hook changes model-visible content after execution; it does not replace
	// the original tool execution result. Skipped when /read-chunks toggles it off.
	pi.on("tool_result", async (event, _ctx) => {
		if (!summaryCompressionEnabled) return;
		if (event.toolName !== "read-chunks") return;
		if (event.isError) return;
		const details = event.details as { mode?: string } | undefined;
		if (details?.mode !== "chunked") return;

		const block = event.content[0];
		if (block?.type !== "text") return;
		const raw = block.text;
		if (!raw.startsWith("[read-chunks:chunked]")) return;

		let parsed: any;
		try {
			parsed = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
		} catch {
			return;
		}

		return {
			content: [{ type: "text", text: buildSummary(parsed) }],
			details: event.details,
		};
	});
}

// ---------- Call-header formatting ----------

/** Shorten a path by replacing the home dir prefix with ~ (matches pi's built-in read header). */
function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Render a path accent-colored and hyperlinked when the terminal supports it. Mirrors pi's renderToolPath(). */
function renderToolPath(rawPath: string | null, theme: any, cwd: string): string {
	if (rawPath === null) return theme.fg("error", "[invalid arg]");
	const value = rawPath || "";
	if (!value) return theme.fg("toolOutput", "...");
	const styled = theme.fg("accent", shortenPath(value));
	if (!getCapabilities().hyperlinks) return styled;
	return hyperlink(styled, pathToFileURL(resolve(cwd, value)).href);
}

/**
 * Build the read-chunks call header: `read-chunks <path>:<range>` plus an optional
 * `[query: ...]` suffix. Derives the line-range from the same `:N` / `:START-END`
 * shorthand execute() parses, so the header matches what was actually requested.
 */
function formatReadChunksCall(args: any, theme: any, cwd: string): string {
	const rawPath = typeof args?.path === "string" ? args.path : "";

	let pathPart = rawPath;
	let rangeSuffix = "";
	const m = rawPath.match(/^(.*?):(\d+)(?:-(\d+))?$/);
	if (m && m.index !== undefined) {
		rangeSuffix = `:${m[2]}${m[3] !== undefined ? `-${m[3]}` : ""}`;
		pathPart = m[1];
	} else {
		// No `:suffix` on path: derive the same `:START[-END]` form from explicit
		// offset/limit args so the header reflects what was actually requested.
		// Matches execute()'s semantics: offset alone = start at line N, read to EOF.
		const off = typeof args?.offset === "number" ? args.offset : undefined;
		const lim = typeof args?.limit === "number" ? args.limit : undefined;
		if (off !== undefined) {
			rangeSuffix = lim !== undefined ? `:${off}-${off + lim - 1}` : `:${off}`;
		}
	}

	const pathDisplay = renderToolPath(pathPart || null, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("read-chunks"))} ${pathDisplay}${theme.fg("warning", rangeSuffix)}`;

	if (typeof args?.query === "string" && args.query.trim()) {
		text += theme.fg("muted", ` [query: ${args.query.trim()}]`);
	}
	return text;
}

// ---------- Summary builder ----------

/** Compact the raw chunked payload for in-context consumption. */
function buildSummary(parsed: any): string {
	const lines: string[] = [];
	const kbTotal = parsed.kb_total ?? 0;
	const scanned = parsed.chunks_scanned ?? 0;
	const readCount = parsed.chunks_read ?? 0;
	const mode = parsed.mode;
	const stopReason = parsed.stop_reason ?? "completed";
	const chunks = parsed.chunks ?? [];

	lines.push(`[read-chunks] File ~${kbTotal}KB, ${scanned} chunks, ${readCount} summarised (${stopReason}).`);

	if (mode === "query" && parsed.answer) {
		const ans = String(parsed.answer).length > 300
			? String(parsed.answer).slice(0, 297) + "..."
			: String(parsed.answer);
		lines.push("", `Answer: ${ans}`);
	}

	const CAP = 25;
	for (let i = 0; i < chunks.length && i < CAP; i++) {
		const s = chunks[i].summary ?? "";
		const trimmed = s.length > 120 ? s.slice(0, 117) + "..." : s;
		lines.push(`${chunks[i].chunk}: ${trimmed}`);
	}
	if (chunks.length > CAP) {
		lines.push(`  ...and ${chunks.length - CAP} more chunk summaries.`);
	}

	lines.push(
		"",
		"Chunk labels are line ranges (start-end), with char offsets in parentheses. To inspect the original file, use read() with line-based offset/limit, or grep/find it.",
	);

	return lines.join("\n");
}
