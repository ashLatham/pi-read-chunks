/**
 * read-chunks — chunked read tool for large TEXT files.
 *
 * Replaces the built-in `read` tool. Files under the configured threshold
 * are passed through to native read. Larger text files are split into
 * overlapping chunks snapped to natural boundaries and summarised by the
 * active model.
 *
 * Routing:
 *   1. Image/binary (by MIME sniffing) → delegate to native read
 *   2. Line-range suffix (:N or :START-END) or explicit offset/limit →
 *      delegate to native read (strips suffix, translates to offset/limit)
 *   3. File ≤ thresholdKB → delegate to native read
 *   4. File > thresholdKB → chunked summarisation
 *
 * Config is read from <cwd>/.pi/read-chunks.json merged over hard-coded
 * defaults. Unknown or invalid config values are ignored.
 */

import { existsSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { Text, hyperlink, getCapabilities } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";

// ---------- MIME type sniffing ----------

/**
 * Read the first 16 bytes and check for known magic-number signatures.
 * Returns the MIME type if recognised, null otherwise.
 */
function sniffMimeType(buf: Buffer): string | null {
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (buf.length >= 8 &&
		buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
		buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
		return "image/png";
	}
	// JPEG: FF D8 FF
	if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
		return "image/jpeg";
	}
	// GIF87a / GIF89a
	if (buf.length >= 6 &&
		buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
		(buf[5] === 0x61 || buf[5] === 0x39)) {
		return "image/gif";
	}
	// WebP: RIFF....WEBP (bytes 0-3: RIFF, bytes 8-11: WEBP)
	if (buf.length >= 12 &&
		buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
		buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
		return "image/webp";
	}
	// BMP: BM
	if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) {
		return "image/bmp";
	}
	// TIFF (little-endian): II*
	if (buf.length >= 4 && buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) {
		return "image/tiff";
	}
	// TIFF (big-endian): MM*
	if (buf.length >= 4 && buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A) {
		return "image/tiff";
	}
	// ICO: 00 00 01 00
	if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
		return "image/x-icon";
	}
	// SVG (XML with svg element — check for <svg within first 16 bytes)
	if (buf.length >= 16) {
		const text = buf.toString("ascii", 0, 16).toLowerCase();
		if (text.includes("<svg")) {
			return "image/svg+xml";
		}
	}
	// PDF: %PDF-
	if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2D) {
		return "application/pdf";
	}
	// ZIP-based: PK (DOCX, XLSX, PPTX, ODT, etc.)
	if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
		return "application/zip";
	}
	// MP4/MOV: ftyp box (bytes 4-7: "ftyp")
	if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
		return "video/mp4";
	}
	// FLAC: fLaC
	if (buf.length >= 4 && buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) {
		return "audio/flac";
	}
	// Ogg: OggS
	if (buf.length >= 4 && buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
		return "audio/ogg";
	}
	// WAV: RIFF....WAVE
	if (buf.length >= 12 &&
		buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
		buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) {
		return "audio/wav";
	}
	// TAR: offset 257-262 "ustar"
	if (buf.length >= 263 && buf[257] === 0x75 && buf[258] === 0x73 && buf[259] === 0x74 && buf[260] === 0x61 && buf[261] === 0x72) {
		return "application/x-tar";
	}
	// GZIP: 1F 8B
	if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
		return "application/gzip";
	}
	// BZ2: 42 5A (BZ)
	if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x5A) {
		return "application/x-bzip2";
	}
	// XZ: FD 37 7A 58 5A 00
	if (buf.length >= 6 &&
		buf[0] === 0xFD && buf[1] === 0x37 && buf[2] === 0x7A && buf[3] === 0x58 && buf[4] === 0x5A && buf[5] === 0x00) {
		return "application/x-xz";
	}
	// 7z: 37 7A BC AF 27 1C
	if (buf.length >= 6 &&
		buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF && buf[4] === 0x27 && buf[5] === 0x1C) {
		return "application/x-7z-compressed";
	}
	// EXE/DLL: MZ
	if (buf.length >= 2 && buf[0] === 0x4D && buf[1] === 0x5A) {
		return "application/x-dosexec";
	}
	// ELF: 7F E4 4C 01 (Linux i386) or 7F E4 4C 02 (Linux x86-64)
	if (buf.length >= 4 && buf[0] === 0x7F && buf[1] === 0xE4 && buf[2] === 0x4C && (buf[3] === 0x01 || buf[3] === 0x02)) {
		return "application/x-executable";
	}
	// ISO: at offset 0x8001 "CD001"
	if (buf.length >= 0x8006 &&
		buf[0x8001] === 0x43 && buf[0x8002] === 0x44 && buf[0x8003] === 0x30 && buf[0x8004] === 0x30 && buf[0x8005] === 0x31) {
		return "application/x-iso9660-image";
	}
	return null;
}

// ---------- Config ----------

/** Timestamp suffix for per-invocation debug output: YYMMDD-hhmmss. */
function debugTimestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const DEFAULT_CONFIG = {
	thresholdKB: 50,
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

// ---------- Language detection ----------

function isCode(path: string, codeExtensions: string[]): boolean {
	return codeExtensions.includes(extname(path).toLowerCase());
}

// ---------- Boundary snapping ----------

interface ChunkRange {
	start: number;
	end: number;
}

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

function buildChunks(
	text: string,
	chunkKB: number,
	overlap: number,
	codeMode: boolean,
): ChunkRange[] {
	const chunkChars = chunkKB * 1024;
	const chunks: ChunkRange[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const endTarget = Math.min(text.length, cursor + chunkChars);
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

function pushChunkBlock(parts: string[], range: ChunkRange, chunkText: string, priorSummary: string, hasPriorSummary: boolean): void {
	if (hasPriorSummary) {
		parts.push("", "Prior summary (for context):", '"""', priorSummary, '"""');
	}
	parts.push("", `Current chunk (chars ${range.start}-${range.end}):`, '"""', chunkText, '"""', "", "Summary of current chunk:");
}

function buildSummarisePrompt(
	chunkText: string,
	priorSummary: string,
	query: string | undefined,
	range: ChunkRange,
): string {
	const parts: string[] = [];
	const hasPriorSummary = priorSummary.trim().length > 0;
	const detailHint = "Preserve important information in the summary:\n - For Code: variables/functions, modules/packages, function calls, design patterns\n - For Prose: key factual information as bullet points";

	if (query) {
		parts.push(
			`You are scanning a large file one chunk at a time, looking for information relevant to this query: "${query}".`,
			"Read the NEXT chunk and produce a NEW summary of THIS CHUNK.",
			hasPriorSummary
				? `${detailHint}\nInclude any relevant context from the prior summary below, but the summary should be focused on the new chunk. Do NOT repeat or echo the prior summary. Write a fresh summary of the CURRENT chunk. ${FACT_GUARD}`
				: `${detailHint}\nWrite a fresh summary of the CURRENT chunk. ${FACT_GUARD}`,
			'If this chunk contains information that FULLY answers the query, begin your reply with exactly "| ANSWER:" ' +
				'followed by the precise answer passage, then a newline, then "---", then your NEW summary of this chunk.',
			"Otherwise reply with ONLY your NEW summary of this chunk (no marker, no separator).",
			"CRITICAL: Only emit the \"| ANSWER:\" marker if the chunk alone provides the COMPLETE answer to the query.",
			"If the query requires information from multiple parts of the file (e.g., a synopsis, comparison, timeline),",
			"do NOT mark individual chunks as answers. Continue reading until either the complete answer is found",
			"or the file has been fully read.",
		);
		parts.push("", `Query: "${query}`);
	} else {
		parts.push("You are reading a large file one chunk at a time.");
		if (hasPriorSummary) {
			parts.push(
				"The following is a running summary of the parts already seen. It is for CONTEXT ONLY.",
				`${detailHint}\nInclude any relevant context from the prior summary, but the summary should be focused on the new chunk. Do NOT repeat or echo the prior summary. Write a fresh summary of the CURRENT chunk. ${FACT_GUARD}`,
			);
		} else {
			parts.push(`${detailHint}\nRead the NEXT chunk and produce a NEW summary of THIS CHUNK. ${FACT_GUARD}`);
		}
	}

	pushChunkBlock(parts, range, chunkText, priorSummary, hasPriorSummary);
	return parts.join("\n");
}

async function summariseChunk(
	chunkText: string,
	priorSummary: string,
	query: string | undefined,
	range: ChunkRange,
	filePath: string,
	modelRegistry: any,
	model: any,
	debugPath: string | null,
	debugEnabled: boolean,
): Promise<string | null> {
	if (!model) return null;
	try {
		if (!modelRegistry.hasConfiguredAuth(model)) return null;
	} catch {
		return null;
	}

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
		response = await modelRegistry.complete(model, requestPayload);
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

// ---------- Line-range suffix parsing ----------

/**
 * Parse :N or :START-END suffix from path. Returns { newPath, offset, limit }
 * or null if no suffix found.
 */
function parseLineRangeSuffix(path: string): { newPath: string; offset: number; limit?: number } | null {
	const m = path.match(/^(.+):(\d+)(?:-(\d+))?$/);
	if (!m) return null;
	const newPath = m[1];
	const startLine = Number(m[2]);
	const endLine = m[3] !== undefined ? Number(m[3]) : undefined;
	return {
		newPath,
		offset: startLine,
		limit: endLine !== undefined ? Math.max(1, endLine - startLine + 1) : undefined,
	};
}

// ---------- Call-header formatting ----------

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function renderToolPath(rawPath: string | null, theme: any, cwd: string): string {
	if (rawPath === null) return theme.fg("error", "[invalid arg]");
	const value = rawPath || "";
	if (!value) return theme.fg("toolOutput", "...");
	const styled = theme.fg("accent", shortenPath(value));
	if (!getCapabilities().hyperlinks) return styled;
	return hyperlink(styled, pathToFileURL(resolve(cwd, value)).href);
}

function formatReadChunksCall(args: any, theme: any, cwd: string): string {
	const rawPath = typeof args?.path === "string" ? args.path : "";

	let pathPart = rawPath;
	let rangeSuffix = "";
	const m = rawPath.match(/^(.*?):(\d+)(?:-(\d+))?$/);
	if (m && m.index !== undefined) {
		rangeSuffix = `:${m[2]}${m[3] !== undefined ? `-${m[3]}` : ""}`;
		pathPart = m[1];
	} else {
		const off = typeof args?.offset === "number" ? args.offset : undefined;
		const lim = typeof args?.limit === "number" ? args.limit : undefined;
		if (off !== undefined) {
			rangeSuffix = lim !== undefined ? `:${off}-${off + lim - 1}` : `:${off}`;
		}
	}

	const pathDisplay = renderToolPath(pathPart || null, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${theme.fg("warning", rangeSuffix)}`;

	if (typeof args?.query === "string" && args.query.trim()) {
		text += theme.fg("muted", ` [query: ${args.query.trim()}]`);
	}
	return text;
}

// ---------- Summary builder ----------

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
		lines.push("", `Answer: ${parsed.answer}`);
	}

	const CAP = 25;
	for (let i = 0; i < chunks.length && i < CAP; i++) {
		const s = chunks[i].summary ?? "";
		lines.push(`${chunks[i].chunk}: ${s}`);
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

// ---------- Main tool ----------

const ReadParams = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute). Optional `:START-END` (inclusive 1-indexed line span) or `:N` (start at line N, read to EOF) suffix selects a line range and bypasses summarisation." }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	query: Type.Optional(Type.String({ description: "Optional search query. When provided, scan stops at the first chunk that answers it." })),
});

export default function (pi: ExtensionAPI) {
	let summaryCompressionEnabled = true;
	let debugReturnEnabled = false;

	// One native read instance for delegating images/binaries
	const nativeRead = createReadTool(process.cwd());

	pi.registerCommand("read-chunks", {
		description: "Toggle summary compression (default: on). 'debug' to toggle per-invocation /tmp/read-chunks_<YYMMDD-hhmmss>.json (default: off).",
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
		name: "read",
		label: "read (chunked)",
		description:
			"TEXT-ONLY. Use instead of the built-in read() for text files.",
		parameters: ReadParams,

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			let { path: rawPath, offset, limit } = params;

			// Step 1: Parse line-range suffix (:N or :START-END)
			const suffixResult = parseLineRangeSuffix(rawPath);
			if (suffixResult) {
				rawPath = suffixResult.newPath;
				offset = suffixResult.offset;
				limit = suffixResult.limit;
			}

			const absolutePath = resolve(ctx.cwd, rawPath);
			const config = loadConfig(ctx.cwd);

			// Per-invocation timestamp for debug output
			const debugReturnPath = debugReturnEnabled ? `/tmp/read-chunks_${debugTimestamp()}.json` : null;

			// Stat the file
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

			// Step 2: Sniff MIME type — image/binary → delegate to native read
			let mime: string | null = null;
			try {
				const buf = readFileSync(absolutePath, { encoding: "binary", flag: "r" });
				// Convert binary buffer to Buffer for sniffing
				const bufAsBuffer = Buffer.from(buf, "binary");
				mime = sniffMimeType(bufAsBuffer);
			} catch {
				// Can't read — fall through to text handling
			}

			if (mime) {
				// Delegate to native read for images/binaries
				const cleanParams = { ...params, path: rawPath };
				return nativeRead.execute(_toolCallId, cleanParams, _signal, onUpdate, ctx);
			}

			// Step 3: Read content
			let content: string;
			try {
				content = readFileSync(absolutePath, "utf-8");
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error reading "${rawPath}": ${e.message}` }],
					details: { error: true },
				};
			}

			// Step 4: Has explicit range (offset/limit or suffix) → return verbatim
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

			// Step 5: Small file → full read
			const sizeKB = stat.size / 1024;
			const codeMode = isCode(rawPath, config.codeExtensions);

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

			// Step 6: Large file → chunked summarisation
			const chunks = buildChunks(content, config.thresholdKB, config.chunkOverlapChars, codeMode);
			const totalKB = Math.round((stat.size / 1024) * 10) / 10;

			// Map char offsets → 1-indexed line numbers
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
				const e = range.end >= content.length ? lineStarts.length : lineOfChar(range.end - 1);
				return `${s}-${e}`;
			};

			const query = typeof params.query === "string" && params.query.trim().length > 0
				? params.query.trim()
				: undefined;

			// Find a model
			let activeModel = ctx.model;
			if (!activeModel) {
				try {
					const available = await ctx.modelRegistry.getAvailable();
					if (available.length > 0) activeModel = available[0];
				} catch {}
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

		renderCall(args, theme, context) {
			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(formatReadChunksCall(args, theme, context.cwd));
			return text;
		},
	});

	// Compress chunked-mode results so raw JSON does not bloat model context.
	pi.on("tool_result", async (event, _ctx) => {
		if (!summaryCompressionEnabled) return;
		if (event.toolName !== "read") return;
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
