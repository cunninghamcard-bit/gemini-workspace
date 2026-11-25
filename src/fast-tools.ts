import path from "node:path";
import type { BridgeToolCallResult } from "./agy-bridge.js";
import { runApplyEdits, type ApplyEditsInput } from "./agy-fast/tools/apply-edits.js";
import { runBatchSearch, type BatchSearchInput } from "./agy-fast/tools/batch-search.js";
import {
  runQuickOutline,
  runReadSlices,
  type QuickOutlineInput,
  type ReadSlicesInput,
} from "./agy-fast/tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./agy-fast/tools/run-checks.js";
import { MCP_CALL_BUDGET_SEC } from "./agy-fast/utils/exec-utils.js";
import { cleanGeminiToolSchema } from "./schema-clean.js";

interface FastToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type FastResult = { text: string; isError?: boolean };

const CWD = { type: "string", description: "Absolute workspace directory (or ~/...)." };

const DEFINITIONS: FastToolDefinition[] = [
  {
    name: "batch_search",
    description:
      "Parallel search in one call: literal text, regex, fuzzy paths, glob (*/{a,b}, no |), read-only git. path rel/abs file/dir; glob filters text/regex; fileType lang/ext (text/regex/fuzzy). multiline spans lines (dot too); count/file=lines or multiline occurrences. Defaults: outputMode=content, caseSensitive=true, contextLines=0, maxResults=40, maxChars=8500 (8800B UTF-8 max); glob sortBy=path (mtime newest).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        queries: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["text", "regex", "glob", "fuzzy", "git"] },
              pattern: { type: "string" },
              path: { type: "string" },
              glob: { type: "string" },
              multiline: { type: "boolean" },
              outputMode: { type: "string", enum: ["content", "files_with_matches", "count"] },
              fileType: { type: "string" },
              sortBy: { type: "string", enum: ["path", "mtime"] },
              caseSensitive: { type: "boolean" },
              contextLines: { type: "integer", minimum: 0, maximum: 5 },
              maxResults: { type: "integer", minimum: 1, maximum: 200 },
            },
            required: ["type", "pattern"],
          },
        },
        maxChars: { type: "integer", minimum: 500, maximum: 8800 },
      },
      required: ["cwd", "queries"],
    },
  },
  {
    name: "apply_edits",
    description: `Atomic multi-file edits. Exact target in 1-based window (all if replaceAll). Nonempty hunks XOR full-file create. overwrite allows replacing via create. bestEffort writes valid files atomically per file, gives closest lines, skips verify on failure. dryRun=true validates only. verify runs a shell command in cwd after writes (max ${MCP_CALL_BUDGET_SEC}s). 8800 UTF-8 bytes output.`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              hunks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    target: { type: "string" },
                    replacement: { type: "string" },
                    startLine: { type: "integer", minimum: 1 },
                    endLine: { type: "integer", minimum: 1 },
                    replaceAll: { type: "boolean" },
                  },
                  required: ["target", "replacement"],
                },
              },
              create: { type: "string" },
              overwrite: { type: "boolean" },
            },
            required: ["path"],
          },
        },
        dryRun: { type: "boolean" },
        bestEffort: { type: "boolean" },
        verify: { type: "string" },
        verifyTimeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
        maxVerifyChars: { type: "integer", minimum: 300, maximum: 7500 },
      },
      required: ["cwd", "edits"],
    },
  },
  {
    name: "read_slices",
    description:
      "Batch symbol outlines (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; max 40 files) plus small <=120-line slices. For >150 known lines, prefer parallel read_file(StartLine, EndLine). slices: 1-based inclusive [start,end]; lineRanges: 'path:start-end,s2-e2'. maxChars default 8500; 8800 UTF-8 bytes total.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        outlines: { type: "array", maxItems: 40, items: { type: "string" } },
        slices: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              ranges: {
                type: "array",
                minItems: 1,
                items: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 1 } },
              },
            },
            required: ["path", "ranges"],
          },
        },
        lineRanges: { type: "array", maxItems: 30, items: { type: "string" } },
        maxChars: { type: "integer", minimum: 1000, maximum: 8800 },
      },
      required: ["cwd"],
    },
  },
  {
    name: "quick_outline",
    description:
      "Symbol/section line-range outlines for large files (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; max 40) before ranged read_file(StartLine, EndLine). maxChars default 8500; 8800 UTF-8 bytes total.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        paths: { type: "array", minItems: 1, maxItems: 40, items: { type: "string" } },
        maxChars: { type: "integer", minimum: 1000, maximum: 8800 },
      },
      required: ["cwd", "paths"],
    },
  },
  {
    name: "run_checks",
    description: `Run >=2 independent non-interactive shell commands concurrently (typecheck, lint, tests). outputMode 'compact' (default) hides passing logs, keeps failures; 'full' keeps passing stdout. concurrency default 4. Shared ${MCP_CALL_BUDGET_SEC}s budget per call; commands that cannot start in time are marked not run, so use run_command for longer jobs. command.cwd overrides cwd; name is a label. maxChars default 8000; 8800 UTF-8 bytes total.`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        commands: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              command: { type: "string" },
              cwd: { type: "string" },
              timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
            },
            required: ["command"],
          },
        },
        concurrency: { type: "integer", minimum: 1, maximum: 8 },
        timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
        outputMode: { type: "string", enum: ["compact", "full"] },
        maxChars: { type: "integer", minimum: 500, maximum: 8800 },
      },
      required: ["cwd", "commands"],
    },
  },
];

const RUNNERS: Record<string, (args: Record<string, unknown>) => Promise<FastResult>> = {
  batch_search: (args) => runBatchSearch(args as unknown as BatchSearchInput),
  apply_edits: (args) => runApplyEdits(args as unknown as ApplyEditsInput),
  read_slices: (args) => runReadSlices(args as unknown as ReadSlicesInput),
  quick_outline: (args) => runQuickOutline(args as unknown as QuickOutlineInput),
  run_checks: (args) => runChecks(args as unknown as RunChecksInput),
};

export function fastToolDefinitions(): FastToolDefinition[] {
  return DEFINITIONS.map((d) => ({ ...d, inputSchema: cleanGeminiToolSchema(d.inputSchema) }));
}

export function isFastTool(name: string): boolean {
  return Object.hasOwn(RUNNERS, name);
}

export async function callFastTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
): Promise<BridgeToolCallResult> {
  const args = rawArgs ?? {};
  const run = RUNNERS[name];
  if (!run) return errorResult(`Unknown tool: ${name}`);

  const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  if (!cwd || !(path.isAbsolute(cwd) || cwd === "~" || cwd.startsWith("~/"))) {
    return errorResult(`Error: 'cwd' must be an absolute workspace path (received ${JSON.stringify(args.cwd ?? null)}).`);
  }

  const res = await run({ ...args, cwd });
  return res.isError
    ? { content: [{ type: "text", text: res.text }], isError: true }
    : { content: [{ type: "text", text: res.text }] };
}

function errorResult(text: string): BridgeToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}
