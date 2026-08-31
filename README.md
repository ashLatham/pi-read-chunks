# pi-read-chunks

A Pi Agent extension that enhances read functionality for large text files to reduce context bloat, rot and lost in the middle issues. Pi Agent's built in 'read()' tool truncates results over a certain size. 'read-chunks()' instead uses a sub-agent that splits larger files into overlapping chunks snapped to natural boundaries (function endings for code, paragraph breaks for prose), and each chunk is summarised by the active model, chaining the running summary forward as the file is consumed. Files under a configurable size threshold have contents returned verbatim. This keeps the full file content out of the main/orchestrator context.

Replaces the built-in `read()` for text files via `registerTool`. Images and other binaries are detected via MIME-type sniffing and delegated to the built-in `read`. A precise query stops the scan early at the first chunk that answers it.

## Features

**MIME-sniffing routing** — The extension replaces the built-in `read` tool via `registerTool`. On each invocation, the first 16 bytes of the file are sniffed for known magic-number signatures (PNG: `89 50 4E 47`, JPEG: `FF D8 FF`, GIF: `GIF87a/GIF89a`, WebP: `RIFF....WEBP`, BMP: `BM`, TIFF: `II*`/`MM*`, ICO: `00 00 01 00`, SVG: `<svg`, PDF: `%PDF-`, ZIP-based formats: `PK`, MP4/MOV: `ftyp`, FLAC: `fLaC`, Ogg: `OggS`, WAV: `RIFF....WAVE`, TAR: `ustar`, GZIP: `1F 8B`, BZ2: `BZ`, XZ: `FD 37 7A 58 5A 00`, 7z: `37 7A BC AF 27 1C`, EXE/DLL: `MZ`, ELF: `7F E4 4C`, ISO: `CD001`). Recognised MIME types delegate to the native `read` tool for image rendering or byte delivery. Text files and unknown extensions proceed to our own logic.

**Three read modes, one tool** — `read-chunks` selects automatically based on file type and args:
- *Full* — file is at or below `thresholdKB`. Returned verbatim. Matches built-in `read` semantics.
- *Chunked scan* — file exceeds the threshold. Split into overlapping chunks at natural boundaries, each summarised by the active LLM with the running summary carried forward. With a `query`, scan stops at the first chunk whose summary contains the answer; without a query, the full file is summarised chunk-by-chunk and the running summary is returned.
- *Line range* — `offset`/`limit` args, or the `path:N` / `path:START-END` suffix. Returns those lines verbatim and bypasses all summarisation.

**Query-driven early stop** — Pass a precise `query` and the model is instructed to begin its reply with `| ANSWER:` followed by the passage that answers it. As soon as a chunk's summary returns the marker, scanning halts and the answer is surfaced directly; the rest of the file is never loaded.

**Natural-boundary snapping** — Chunk edges snap backward to the nearest `}` line or blank line for code, paragraph break or line break for prose; forward snaps to the next top-level declaration (function/class/etc.) or paragraph. Hard fallback to the raw character target if no boundary exists within the 2000-char search window, so chunking never stalls on edge cases.

**Context-aware chunk labels** — Chunk labels are line ranges (`start-end`) with char offsets in parentheses, derived by binary-searching the file's `\n` positions. Labels match how the agent reasons (line numbers, not raw char offsets).

**Per-tool-result compression** — The raw chunked-mode payload is JSON; a `tool_result` hook rewrites it into a human-readable summary before the model sees it, so a multi-chunk scan doesn't blow the context budget. Toggle with `/read-chunks`.

**Optional per-invocation debug dump** — `/read-chunks debug` (toggles on/off) writes each invocation's LLM requests/responses and the final tool return to `/tmp/read-chunks_<YYMMDD-hhmmss>.json`. Disabled by default.

**Summary budget** — By default, summaries preserve names, places, events, dates, and key details without artificial truncation. Typical output stays under ~1.5KB for a 100KB file (~94% reduction from the original). If summaries exceed `thresholdKB`, they are sent back to the LLM for denser compression (up to 3 attempts) without losing factual content.


## Installation

Install from npm:

```bash
pi install npm:pi-read-chunks
```

Install into the current project only:

```bash
pi install npm:pi-read-chunks -l
```

Or install from GitHub:

```bash
pi install git:github.com/ashLatham/pi-read-chunks
```

Try it without permanently installing:

```bash
pi -e npm:pi-read-chunks
```

## Configuration

All config is optional. Defaults are used when the file is absent or malformed.
Copy read-chunks.example.json to:
`<cwd>/.pi/read-chunks.json`:

```json
{
  "thresholdKB": 50,
  "chunkOverlapChars": 800
}
```

| Key                 | Default | Notes                                                                                          |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `thresholdKB`       | `50`    | Files ≤ this size are returned verbatim; larger files are chunked using this same value as the target chunk size (KB). Also acts as the hard cap on total summary size — summaries exceeding this are sent back to the LLM for denser compression without losing factual content. |
| `chunkOverlapChars` | `800`   | Backward overlap between consecutive chunks, in characters.                                    |


## Usage

### Tool arguments

| Arg      | Type   | Description |
| -------- | ------ | ----------- |
| `path`   | string | Path to the file (relative or absolute). Append `:START-END` (inclusive 1-indexed line span, e.g. `file.txt:2000-2089`) or `:N` (start at line N, read to EOF) to bypass summarisation. |
| `offset` | number | Optional. 1-indexed start line. Bypasses summarisation. |
| `limit`  | number | Optional. Max lines to return. Bypasses summarisation. |
| `query`  | string | Optional. Precise search query; scan stops at the first chunk whose summary contains the answer. |

Always pass a `query` when scanning a large file — without one, the tool walks every chunk to produce a running summary.

Examples:
- `read-chunks({ path: "src/big.ts", query: "where is the retry backoff configured" })` — scans until found.
- `read-chunks({ path: "src/big.ts" })` — full file summarised chunk-by-chunk; running summary returned.
- `read-chunks({ path: "src/big.ts:2000-2089" })` — exact line range, no summarisation.
- `read-chunks({ path: "src/big.ts:300" })` — start at line 300, read to EOF.
- `read-chunks({ path: "diagram.png" })` — MIME sniffing detects the image type; delegating to the built-in `read` for native image rendering.
- `read("src/file.ts:388-437")` — line-range suffix parsed and translated to `offset`/`limit`; native `read` returns those lines verbatim (no summarisation needed).

### Slash command

`/read-chunks` — toggle summary compression of chunked-mode results (default: ON).
`/read-chunks debug` — toggle the per-invocation `/tmp/read-chunks_<timestamp>.json` dump (default: OFF).

### Notification levels

- `info` — chunk progress (`read-chunks: 1200-1450 (chunk 3/12)`), toggle state changes
- `error` — no model available for summarisation, file not found, not a regular file, read error

### What `read-chunks` does NOT do

- No relevance ranking. Every chunk receives exactly one LLM summary; chunks aren't scored or re-ordered.
- No persistence. Summaries aren't cached between invocations; each call re-summarises from scratch.
- No support for binary files. Image/binary detection via MIME sniffing — recognised types delegate to the built-in `read` for native rendering or byte delivery.

## Links

- npm: https://www.npmjs.com/package/pi-read-chunks
- GitHub: https://github.com/ashLatham/pi-read-chunks
- Pi Agent: https://github.com/earendil-works/pi

## License
MIT
