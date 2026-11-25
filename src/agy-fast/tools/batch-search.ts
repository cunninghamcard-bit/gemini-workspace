import { promises as fs } from "node:fs";
import path from "node:path";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import {
  execBinaryAsync,
  isRipgrepAvailable,
  withNonInteractiveGitEnv,
  type ExecResult,
} from "../utils/exec-utils.js";
import { rankFuzzyPaths } from "../utils/fuzzy-match.js";
import {
  DEFAULT_IGNORE_DIRS,
  globToRegExp,
  isLikelyBinary,
  resolvePath,
  toPosixPath,
  walkFiles,
} from "../utils/fs-utils.js";
import {
  computeWaterFillBudgets,
  DEFAULT_INLINE_MAX_BYTES,
  fitSectionsToByteBudget,
  sliceSafeChars,
} from "../utils/output-filter.js";

export type SearchQueryType = "text" | "regex" | "glob" | "fuzzy" | "git";

export interface SearchQuery {
  type: SearchQueryType;
  pattern: string;
  path?: string;
  glob?: string;
  fileType?: string;
  multiline?: boolean;
  outputMode?: "content" | "files_with_matches" | "count";
  sortBy?: "path" | "mtime";
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
}

export interface BatchSearchInput {
  cwd?: string;
  queries: SearchQuery[];
  maxChars?: number;
}

export interface BatchSearchRuntimeOptions {
  forceNodeFallback?: boolean;
}

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "tag",
  "remote",
]);

const FORBIDDEN_GIT_GLOBAL_FLAGS = new Set([
  "-c",
  "--config",
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--textconv",
  "--output",
  "--exec",
  "--upload-pack",
  "--git-dir",
  "--work-tree",
]);

const ALLOWED_BRANCH_BOOL_FLAGS = new Set([
  "--all",
  "--remotes",
  "--verbose",
  "--list",
  "--show-current",
  "--no-abbrev",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
  "--quiet",
]);

const ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS = new Set([
  "--abbrev",
  "--color",
  "--column",
]);

const ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS = new Set([
  "--merged",
  "--no-merged",
]);

const ALLOWED_BRANCH_COMMIT_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--points-at",
]);

const ALLOWED_BRANCH_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format",
]);

const ALLOWED_BRANCH_SHORT_CHARS = new Set(["a", "r", "v", "l", "q", "i"]);

const ALLOWED_TAG_BOOL_FLAGS = new Set([
  "--list",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
]);

const ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS = new Set([
  "--color",
  "--column",
]);

const ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS = new Set([
  "--merged",
  "--no-merged",
]);

const ALLOWED_TAG_COMMIT_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--points-at",
]);

const ALLOWED_TAG_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format",
]);

const ALLOWED_TAG_SHORT_CHARS = new Set(["l", "i"]);

const ALLOWED_REMOTE_SUBCOMMANDS = new Set(["show", "get-url"]);

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) {
    throw new Error("Unterminated quote in git query");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function validateReadonlyGitArgs(pattern: string): string[] {
  const rawTokens = tokenizeArgs(pattern.trim());
  const tokens = rawTokens[0] === "git" ? rawTokens.slice(1) : rawTokens;
  if (tokens.length === 0) {
    throw new Error("Empty git query. Example: 'status --short' or 'log -n 5 --oneline'");
  }

  const subcmd = tokens[0]!;
  if (subcmd.startsWith("-")) {
    throw new Error(
      `Git query must start with a read-only subcommand (got '${subcmd}')`,
    );
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcmd)) {
    throw new Error(
      `Git subcommand '${subcmd}' is not allowed in batch_search (read-only only: ${[...READONLY_GIT_SUBCOMMANDS].join(", ")})`,
    );
  }

  const rest = tokens.slice(1);
  for (const arg of rest) {
    if (arg === "&&" || arg === "||" || arg === ";" || arg === "|") {
      throw new Error(
        `Shell operator '${arg}' is not supported in git queries; split chained commands into separate batch_search queries`,
      );
    }
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (
      FORBIDDEN_GIT_GLOBAL_FLAGS.has(flagName) ||
      arg.startsWith("--output=") ||
      flagName === "--ext" ||
      flagName.startsWith("--ext-") ||
      flagName.startsWith("--textc") ||
      (arg.startsWith("-c") && arg.length > 2)
    ) {
      throw new Error(`Flag '${arg}' is not allowed in read-only git query`);
    }
  }

  if (subcmd === "status") {
    for (const arg of rest) {
      if (arg === "--") break;
      if (arg.startsWith("--")) {
        const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
        if (flagName.startsWith("--v")) {
          throw new Error(
            `Flag '${arg}' is not allowed in read-only git status query (verbose status executes diff textconv; use 'diff' instead)`,
          );
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          // -u[<mode>] and -M[<n>] consume the remainder of the token as their value
          if (ch === "u" || ch === "M") break;
          if (ch === "v") {
            throw new Error(
              `Flag '${arg}' is not allowed in read-only git status query (verbose status executes diff textconv; use 'diff' instead)`,
            );
          }
        }
      }
    }
  } else if (subcmd === "branch") {
    let hasListFlag = false;
    let expectValue = false;
    let expectNonFlagCommit = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (expectNonFlagCommit) {
        expectNonFlagCommit = false;
        if (arg.startsWith("-")) {
          throw new Error(
            `Expected commit ref after commit filter flag (got '${arg}')`,
          );
        }
        continue;
      }
      if (arg === "--") {
        if (!hasListFlag) {
          throw new Error(
            "Positional branch arguments are only allowed with --list in read-only mode",
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (
            !ALLOWED_BRANCH_VALUE_FLAGS.has(flagName) &&
            !ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS.has(flagName) &&
            !ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName)
          ) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
        } else if (ALLOWED_BRANCH_COMMIT_VALUE_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          hasListFlag = true;
        } else if (ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          hasListFlag = true;
        } else if (ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)) {
          expectValue = true;
        } else if (
          !ALLOWED_BRANCH_BOOL_FLAGS.has(flagName) &&
          !ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS.has(flagName)
        ) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
        }
        if (
          flagName === "--list" ||
          ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName) ||
          ALLOWED_BRANCH_COMMIT_VALUE_FLAGS.has(flagName)
        ) {
          hasListFlag = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_BRANCH_SHORT_CHARS.has(ch)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
          if (ch === "l") hasListFlag = true;
        }
      } else if (!hasListFlag) {
        throw new Error(
          `Positional branch argument '${arg}' is only allowed with --list in read-only mode`,
        );
      }
    }
  } else if (subcmd === "tag") {
    let allowsPositionals = false;
    let expectValue = false;
    let expectNonFlagCommit = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (expectNonFlagCommit) {
        expectNonFlagCommit = false;
        if (arg.startsWith("-")) {
          throw new Error(
            `Expected commit ref after commit filter flag (got '${arg}')`,
          );
        }
        continue;
      }
      if (arg === "--") {
        if (!allowsPositionals) {
          throw new Error(
            "Positional tag arguments are only allowed with --list in read-only mode",
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (
            !ALLOWED_TAG_VALUE_FLAGS.has(flagName) &&
            !ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS.has(flagName) &&
            !ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName)
          ) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
          }
        } else if (ALLOWED_TAG_COMMIT_VALUE_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          allowsPositionals = true;
        } else if (ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          allowsPositionals = true;
        } else if (ALLOWED_TAG_VALUE_FLAGS.has(flagName)) {
          expectValue = true;
        } else if (
          !ALLOWED_TAG_BOOL_FLAGS.has(flagName) &&
          !ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS.has(flagName)
        ) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
        }
        if (
          flagName === "--list" ||
          ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName) ||
          ALLOWED_TAG_COMMIT_VALUE_FLAGS.has(flagName)
        ) {
          allowsPositionals = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        if (/^-n\d*$/.test(arg)) {
          allowsPositionals = true;
        } else {
          for (const ch of arg.slice(1)) {
            if (!ALLOWED_TAG_SHORT_CHARS.has(ch)) {
              throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
            }
            if (ch === "l") allowsPositionals = true;
          }
        }
      } else if (!allowsPositionals) {
        throw new Error(
          `Positional tag argument '${arg}' is only allowed with --list in read-only mode`,
        );
      }
    }
  } else if (subcmd === "remote") {
    let remoteSubcmd: string | null = null;
    for (const arg of rest) {
      if (!remoteSubcmd) {
        if (arg === "-v" || arg === "--verbose") continue;
        if (arg.startsWith("-")) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git remote query`);
        }
        if (!ALLOWED_REMOTE_SUBCOMMANDS.has(arg)) {
          throw new Error(`Mutating git remote subcommand '${arg}' is not allowed`);
        }
        remoteSubcmd = arg;
      } else if (arg.startsWith("-")) {
        const okFlag =
          (remoteSubcmd === "show" && arg === "-n") ||
          (remoteSubcmd === "get-url" && (arg === "--push" || arg === "--all"));
        if (!okFlag) {
          throw new Error(
            `Flag '${arg}' is not allowed for read-only git remote ${remoteSubcmd}`,
          );
        }
      } else if (
        arg.includes("://") ||
        arg.includes(":") ||
        arg.includes("/") ||
        arg.includes("\\")
      ) {
        throw new Error(
          `Remote target '${arg}' must be a configured remote name, not a URL or path`,
        );
      }
    }
  }

  return ["--no-pager", subcmd, ...rest];
}

const FILE_TYPE_GLOBS: Record<string, string[]> = {
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  typescript: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  javascript: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  py: ["*.py", "*.pyi"],
  python: ["*.py", "*.pyi"],
  go: ["*.go"],
  gd: ["*.gd"],
  gdscript: ["*.gd"],
  rust: ["*.rs"],
  rs: ["*.rs"],
  java: ["*.java"],
  kt: ["*.kt", "*.kts"],
  kotlin: ["*.kt", "*.kts"],
  c: ["*.c", "*.h"],
  cpp: ["*.cc", "*.cpp", "*.cxx", "*.hpp", "*.hh", "*.hxx", "*.h"],
  cs: ["*.cs"],
  csharp: ["*.cs"],
  swift: ["*.swift"],
  rb: ["*.rb"],
  ruby: ["*.rb"],
  php: ["*.php"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  html: ["*.html", "*.htm"],
  vue: ["*.vue"],
  svelte: ["*.svelte"],
  md: ["*.md", "*.mdx", "*.markdown"],
  markdown: ["*.md", "*.mdx", "*.markdown"],
  json: ["*.json", "*.jsonc"],
  yaml: ["*.yml", "*.yaml"],
  yml: ["*.yml", "*.yaml"],
  toml: ["*.toml"],
  xml: ["*.xml"],
  sql: ["*.sql"],
  sh: ["*.sh", "*.bash", "*.zsh"],
  shell: ["*.sh", "*.bash", "*.zsh"],
};

function resolveFileTypeGlobs(fileType?: string): string[] | null {
  if (fileType === undefined) return null;
  if (typeof fileType !== "string") throw new Error("fileType must be a string");
  const key = fileType.trim().toLowerCase().replace(/^\./, "");
  if (!key) return null;
  const mapped = FILE_TYPE_GLOBS[key];
  if (Object.hasOwn(FILE_TYPE_GLOBS, key)) return mapped!;
  if (/^[a-z0-9]+$/i.test(key)) return [`*.${key}`];
  throw new Error(`Unsupported fileType '${fileType}'`);
}

function fileTypeMatcher(fileType?: string): (file: string) => boolean {
  const matchers = (resolveFileTypeGlobs(fileType) ?? []).map(globToRegExp);
  return (file) => matchers.length === 0 || matchers.some((matcher) => matcher.test(path.basename(file)));
}

interface SearchLine {
  lineNumber: number;
  text: string;
  isMatch: boolean;
  matchStart?: number;
  matchEnd?: number;
}

interface MatchedLineInfo {
  lineIndex: number;
  matchStart?: number;
  matchEnd?: number;
}

interface FileMatches {
  file: string;
  lines: SearchLine[];
  count?: number;
}

async function runTextOrRegexWithRg(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
): Promise<{ files: FileMatches[]; totalMatches: number; truncated: boolean }> {
  const maxResults = clampInt(query.maxResults, 1, 200, 40);
  const contextLines = clampInt(query.contextLines, 0, 5, 0);
  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const typeGlobs = resolveFileTypeGlobs(query.fileType);
  const matchesType = fileTypeMatcher(query.fileType);
  const fileStat = await fs.stat(searchRoot);
  const isFileTarget = fileStat.isFile();
  if (isFileTarget) {
    if (typeGlobs && !matchesType(searchRoot)) {
      return { files: [], totalMatches: 0, truncated: false };
    }
    if (fileStat.size > 2 * 1024 * 1024) {
      return { files: [], totalMatches: 0, truncated: false };
    }
    if (query.glob) {
      const negated = query.glob.startsWith("!");
      const rawGlob = negated ? query.glob.slice(1) : query.glob;
      const globRe = globToRegExp(rawGlob);
      const relPosix = relativeFile(baseCwd, searchRoot);
      const matched = globRe.test(relPosix) || globRe.test(path.basename(searchRoot));
      if (negated ? matched : !matched) {
        return { files: [], totalMatches: 0, truncated: false };
      }
    }
    const fh = await fs.open(searchRoot, "r");
    try {
      const head = Buffer.alloc(Math.min(fileStat.size, 8192));
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      if (isLikelyBinary(head.subarray(0, bytesRead))) {
        return { files: [], totalMatches: 0, truncated: false };
      }
    } finally {
      await fh.close();
    }
  }
  const perFileCap = isFileTarget ? maxResults : Math.min(maxResults, 50);

  const args = ["--no-config", "--no-messages", "--max-filesize", "2M", "--crlf"];
  if (query.multiline) args.push("--multiline", "--multiline-dotall");
  if (typeGlobs) {
    for (const glob of typeGlobs) args.push("--type-add", `agyfilter:${glob}`);
    args.push("--type", "agyfilter");
  }

  if (query.type === "text") {
    args.push("--fixed-strings");
  }
  if (query.caseSensitive === false) {
    args.push("--ignore-case");
  }
  if (query.glob) {
    args.push(`--glob=${query.glob}`);
  }
  // Always skip heavy vendor/build noise directories unless explicitly targeted
  // by searchRoot (including paths outside baseCwd) or a positive query.glob.
  // Emit default exclusions AFTER user query.glob so positive globs like `*.mjs`
  // cannot override them under ripgrep's last-match-wins precedence.
  const relNative = path.relative(baseCwd, searchRoot);
  const relRoot = toPosixPath(relNative);
  const isInsideBaseCwd =
    relRoot === "" || (relRoot !== ".." && !relRoot.startsWith("../") && !path.isAbsolute(relRoot));
  // Pass a cwd-relative search target when inside baseCwd so ripgrep matches
  // anchored globs (e.g. `dist/*.mjs`, `{dist,src}/*.mjs`, `!src/**`) even
  // when baseCwd traverses a symlink (e.g. macOS `/var` -> `/private/var`).
  const rgSearchTarget = isInsideBaseCwd
    ? !relNative
      ? "."
      : relNative === "-"
        ? `.${path.sep}-`
        : relNative
    : searchRoot;
  const rootSegments = isInsideBaseCwd
    ? (relRoot ? relRoot.split("/") : [])
    : toPosixPath(searchRoot).split("/").filter(Boolean);
  const positiveGlob =
    query.glob && !query.glob.startsWith("!") ? query.glob : null;
  for (const dir of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    ".venv",
    ".next",
  ]) {
    if (
      !rootSegments.includes(dir) &&
      !(positiveGlob && globTargetsDir(positiveGlob, dir))
    ) {
      args.push(`--glob=!**/${dir}/**`);
    }
  }

  const runRg = async (
    runArgs: string[],
    opts?: { allowPartialError?: boolean },
  ): Promise<ExecResult> => {
    const res = await execBinaryAsync("rg", runArgs, {
      cwd: baseCwd,
      timeoutMs: 15_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (res.error) {
      throw new Error(`rg spawn error: ${res.error}`);
    }
    // rg exit code 0 = matches found, 1 = no matches, 2 = error (e.g. bad regex or ENOENT).
    // In Pass 2 over explicit files from Pass 1, the regex is already validated; exit code 2
    // with empty stderr (--no-messages) means a listed file vanished mid-search while stdout
    // still carries valid JSON matches for the remaining files.
    if (res.exitCode === 2 && !(opts?.allowPartialError && !res.stderr.trim())) {
      throw new Error(res.stderr.trim() || `rg failed for pattern: ${query.pattern}`);
    }
    return res;
  };
  const cutShort = (res: ExecResult): boolean =>
    res.truncated || res.timedOut || res.exitCode === null;

  if (summary) {
    const res = await runRg([
      ...args,
      ...(query.outputMode === "count"
        ? [query.multiline ? "--count-matches" : "--count", "--with-filename", "--null"]
        : ["--files-with-matches", "--null"]),
      "--",
      query.pattern,
      rgSearchTarget,
    ]);
    const files: FileMatches[] = [];
    const out = res.stdout;
    let pos = 0;
    while (pos < out.length) {
      const nul = out.indexOf("\0", pos);
      if (nul === -1) break;
      const rawFile = out.slice(pos, nul);
      let count = 0;
      if (query.outputMode === "count") {
        const nl = out.indexOf("\n", nul + 1);
        if (nl === -1) break;
        const rawCount = out.slice(nul + 1, nl).trim();
        count = Number(rawCount);
        pos = nl + 1;
      } else {
        pos = nul + 1;
      }
      if (!rawFile || !matchesType(rawFile)) continue;
      files.push({ file: relativeFile(baseCwd, rawFile), lines: [], count: Number.isFinite(count) ? count : 0 });
    }
    files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return {
      files: files.slice(0, maxResults),
      totalMatches: 0,
      truncated: files.length > maxResults || cutShort(res),
    };
  }

  // Request perFileCap + 1 so hitting the per-file cap still shows as `truncated`.
  const maxCountArgs = query.multiline ? [] : ["--max-count", String(perFileCap + 1)];
  let chosen: Array<{ rawFile: string; relFile: string; count: number }>;
  let truncated = false;

  if (isFileTarget) {
    // Single-file searches have no multi-file thread ordering nondeterminism;
    // skip the counting pass to avoid spawning rg twice.
    chosen = [
      {
        rawFile: searchRoot,
        relFile: relativeFile(baseCwd, searchRoot),
        count: Number.POSITIVE_INFINITY,
      },
    ];
  } else {
    // rg reports files in thread order, so the kept files are chosen from per-file
    // counts in path order, and only those files are searched for lines.
    const counts = await runRg([
      ...args,
      ...maxCountArgs,
      "--count",
      "--with-filename",
      "--null",
      "--",
      query.pattern,
      rgSearchTarget,
    ]);
    const counted: Array<{ rawFile: string; relFile: string; count: number }> = [];
    // The text after the last newline is empty or a record cut by the output budget.
    for (const record of counts.stdout.split("\n").slice(0, -1)) {
      const sep = record.lastIndexOf("\0");
      const count = Number(record.slice(sep + 1));
      if (sep <= 0 || !Number.isInteger(count) || count <= 0) continue;
      const rawFile = record.slice(0, sep);
      if (!matchesType(rawFile)) continue;
      counted.push({ rawFile, relFile: relativeFile(baseCwd, rawFile), count });
    }
    counted.sort((a, b) => (a.relFile < b.relFile ? -1 : a.relFile > b.relFile ? 1 : 0));

    // A multiline count is a lower bound on the matched lines, so the chosen files
    // still cover maxResults.
    chosen = [];
    let coveredMatches = 0;
    for (const item of counted) {
      if (coveredMatches >= maxResults) break;
      chosen.push(item);
      coveredMatches += query.multiline ? item.count : Math.min(item.count, perFileCap);
    }
    truncated = cutShort(counts) || chosen.length < counted.length;
    if (chosen.length === 0) {
      return { files: [], totalMatches: 0, truncated };
    }
  }

  // Pass compact relative paths (when inside baseCwd) and chunk arguments so
  // large maxResults batches stay well below Windows' 32 KB CreateProcess limit.
  const toRgArgPath = (rawFile: string): string => {
    const rel = path.relative(baseCwd, path.resolve(baseCwd, rawFile));
    const chosenPath =
      rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
        ? rel
        : rawFile;
    // Never pass bare "-" as a path argument (rg interprets "-" as stdin)
    return chosenPath === "-" ? `.${path.sep}-` : chosenPath;
  };
  const rgChunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentChunkChars = 0;
  const maxArgChars = 20_000;
  for (const item of chosen) {
    const argPath = toRgArgPath(item.rawFile);
    const est = argPath.length + 3;
    if (currentChunk.length > 0 && currentChunkChars + est > maxArgChars) {
      rgChunks.push(currentChunk);
      currentChunk = [];
      currentChunkChars = 0;
    }
    currentChunk.push(argPath);
    currentChunkChars += est;
  }
  if (currentChunk.length > 0) rgChunks.push(currentChunk);

  const byFile = new Map<string, Map<number, SearchLine>>();
  for (const chunk of rgChunks) {
    const res = await runRg(
      [
        ...args,
        ...maxCountArgs,
        "--json",
        ...(contextLines > 0 ? ["-C", String(contextLines)] : []),
        "--",
        query.pattern,
        ...chunk,
      ],
      { allowPartialError: !isFileTarget },
    );
    if (cutShort(res)) truncated = true;

    for (const rawLine of res.stdout.split("\n")) {
      if (!rawLine.trim()) continue;
      let ev: {
        type?: string;
        data?: {
          path?: { text?: string; bytes?: string };
          line_number?: number;
          lines?: { text?: string; bytes?: string };
          submatches?: Array<{ start?: number; end?: number }>;
        };
      };
      try {
        ev = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (ev.type !== "match" && ev.type !== "context") continue;
      const rawFile =
        ev.data?.path?.text ??
        (ev.data?.path?.bytes ? Buffer.from(ev.data.path.bytes, "base64").toString("utf8") : undefined);
      const lineNumber = ev.data?.line_number;
      const rawBuf = ev.data?.lines?.bytes ? Buffer.from(ev.data.lines.bytes, "base64") : null;
      const rawText = ev.data?.lines?.text ?? (rawBuf ? rawBuf.toString("utf8") : "");
      if (!rawFile || typeof lineNumber !== "number") continue;

      const relFile = relativeFile(baseCwd, rawFile);
      let lineMap = byFile.get(relFile);
      if (!lineMap) {
        lineMap = new Map<number, SearchLine>();
        byFile.set(relFile, lineMap);
      }
      const isMatch = ev.type === "match";
      const submatchRanges: Array<{ start: number; end: number }> = [];
      if (isMatch && Array.isArray(ev.data?.submatches) && ev.data.submatches.length > 0) {
        let utf8Buf = rawBuf;
        const isAsciiOnly = !utf8Buf && Buffer.byteLength(rawText, "utf8") === rawText.length;
        const byteToChar = (byteOffset: number): number => {
          if (byteOffset <= 0) return 0;
          if (isAsciiOnly) return Math.min(byteOffset, rawText.length);
          if (!utf8Buf) utf8Buf = Buffer.from(rawText, "utf8");
          const clamped = Math.min(byteOffset, utf8Buf.length);
          return utf8Buf.subarray(0, clamped).toString("utf8").length;
        };
        for (const sm of ev.data.submatches) {
          if (typeof sm?.start !== "number") continue;
          const start = byteToChar(sm.start);
          const end = typeof sm.end === "number" ? Math.max(start, byteToChar(sm.end)) : start;
          submatchRanges.push({ start, end });
        }
      }

      const lineText = rawText.replace(/\r?\n$/, "");
      // A multiline match event spans several lines; each one counts as a match.
      const segments = isMatch && query.multiline ? lineText.split(/\r?\n/) : [lineText];
      let segStart = 0;
      for (const [offset, text] of segments.entries()) {
        const segEnd = segStart + text.length;
        const line = lineNumber + offset;
        if (!lineMap.get(line)?.isMatch) {
          let matchStart: number | undefined;
          let matchEnd: number | undefined;
          if (isMatch && submatchRanges.length > 0) {
            const hit = submatchRanges.find((r) =>
              r.start === r.end
                ? r.start >= segStart && r.start <= segEnd
                : r.start <= segEnd && r.end > segStart,
            );
            if (hit) {
              matchStart = Math.max(0, Math.min(hit.start - segStart, text.length));
              matchEnd = Math.max(matchStart, Math.min(hit.end - segStart, text.length));
            }
          }
          lineMap.set(line, {
            lineNumber: line,
            text,
            isMatch,
            ...(matchStart !== undefined ? { matchStart, matchEnd } : {}),
          });
        }
        segStart = segEnd;
        if (rawText[segStart] === "\r" && rawText[segStart + 1] === "\n") {
          segStart += 2;
        } else if (rawText[segStart] === "\n") {
          segStart += 1;
        }
      }
    }
  }

  // Keep matches in path and line order up to maxResults. Without multiline, a
  // file keeps at most its counted matches: rg searches an explicitly named
  // binary file past the NUL byte at which the counting pass stopped.
  const files: FileMatches[] = [];
  let totalMatches = 0;
  for (const { relFile, count } of chosen) {
    if (totalMatches >= maxResults) {
      truncated = true;
      break;
    }
    const fileCap = query.multiline ? maxResults : Math.min(count, perFileCap);
    const budget = Math.min(fileCap, maxResults - totalMatches);
    const sorted = [...(byFile.get(relFile)?.values() ?? [])].sort(
      (a, b) => a.lineNumber - b.lineNumber,
    );
    const lines: SearchLine[] = [];
    let kept = 0;
    let lastKeptMatchLine = -1;
    for (const line of sorted) {
      if (line.isMatch) {
        if (kept === budget) {
          truncated = true;
          if (
            lastKeptMatchLine !== -1 &&
            line.lineNumber <= lastKeptMatchLine + contextLines
          ) {
            lines.push({ lineNumber: line.lineNumber, text: line.text, isMatch: false });
          }
          continue;
        }
        kept += 1;
        lastKeptMatchLine = line.lineNumber;
        lines.push(line);
      } else if (kept < budget || line.lineNumber <= lastKeptMatchLine + contextLines) {
        // Before the budget is spent, a context line belongs to a kept match;
        // afterwards only the after-context of the last kept match remains.
        lines.push(line);
      }
    }
    if (kept === 0) continue;
    files.push({ file: relFile, lines });
    totalMatches += kept;
  }

  return { files, totalMatches, truncated };
}

function* multilineMatches(content: string, regex: RegExp): Generator<RegExpMatchArray> {
  let previousEnd = -1;
  for (const match of content.matchAll(regex)) {
    const start = match.index!;
    if (start === content.length && (content.length === 0 || content.endsWith("\n"))) break;
    if (match[0] === "") {
      // Match rg's CRLF boundaries and omit empty matches adjacent to the prior match.
      if (start === previousEnd || (content[start - 1] === "\r" && content[start] === "\n")) continue;
    }
    previousEnd = start + match[0].length;
    yield match;
  }
}

function multilineMatchLines(
  content: string,
  regex: RegExp,
  limit: number,
): MatchedLineInfo[] {
  const results: MatchedLineInfo[] = [];
  let line = 0;
  let lineStart = 0;
  let nextBreak = content.indexOf("\n");

  // Matches arrive in offset order. Track line boundaries as the matches advance.
  for (const match of multilineMatches(content, regex)) {
    const start = match.index!;
    const rawEnd = start + match[0].length;
    const end = start + Math.max(0, match[0].length - 1);
    while (nextBreak !== -1 && nextBreak < start) {
      line++;
      lineStart = nextBreak + 1;
      nextBreak = content.indexOf("\n", lineStart);
    }
    while (true) {
      if (results.at(-1)?.lineIndex !== line) {
        const rawLineEnd = nextBreak === -1 ? content.length : nextBreak;
        const lineEnd =
          rawLineEnd > lineStart && content[rawLineEnd - 1] === "\r"
            ? rawLineEnd - 1
            : rawLineEnd;
        const lineLen = lineEnd - lineStart;
        const matchStart = Math.max(0, Math.min(start - lineStart, lineLen));
        const matchEnd = Math.max(matchStart, Math.min(rawEnd - lineStart, lineLen));
        results.push({ lineIndex: line, matchStart, matchEnd });
      }
      if (results.length >= limit) return results;
      if (nextBreak === -1 || nextBreak >= end) break;
      line++;
      lineStart = nextBreak + 1;
      nextBreak = content.indexOf("\n", lineStart);
    }
  }
  return results;
}

async function runTextOrRegexWithNode(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
): Promise<{ files: FileMatches[]; totalMatches: number; truncated: boolean }> {
  const maxResults = clampInt(query.maxResults, 1, 200, 40);
  const contextLines = clampInt(query.contextLines, 0, 5, 0);
  const flags = (query.caseSensitive === false ? "i" : "") + (query.multiline ? "gmsu" : "");

  let regex: RegExp;
  if (query.type === "regex") {
    try {
      regex = new RegExp(query.pattern, flags);
    } catch (err) {
      // Retry without strict Unicode 'u' mode so ripgrep-valid identity escapes
      // (e.g. `\:` or `\#`) remain compatible in multiline Node fallback.
      if (flags.includes("u")) {
        try {
          regex = new RegExp(query.pattern, flags.replace("u", ""));
        } catch {
          throw new Error(
            `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        throw new Error(
          `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, flags);
  }

  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const matchesType = fileTypeMatcher(query.fileType);
  let discoveryTruncated = false;
  const globNegated = Boolean(query.glob && query.glob.startsWith("!"));
  const rawGlob = query.glob ? (globNegated ? query.glob.slice(1) : query.glob) : null;
  const globRegex = rawGlob ? globToRegExp(rawGlob) : null;
  const globMatchesFile = (relPosix: string): boolean => {
    if (!matchesType(relPosix)) return false;
    if (!globRegex) return true;
    let matched = globRegex.test(relPosix);
    // Also match basename when pattern has no slash (like '*.ts' or '!*.ts')
    if (!matched && !rawGlob!.includes("/")) {
      const base = relPosix.split("/").pop() ?? relPosix;
      matched = globRegex.test(base);
    }
    return globNegated ? !matched : matched;
  };

  const stat = await fs.stat(searchRoot);
  const perFileCap = stat.isFile() ? maxResults : Math.min(maxResults, 50);
  let targetFiles: Array<{ abs: string; rel: string }>;
  if (stat.isFile()) {
    const relPosix =
      toPosixPath(path.relative(baseCwd, searchRoot)) || path.basename(searchRoot);
    targetFiles = globMatchesFile(relPosix)
      ? [{ abs: searchRoot, rel: relativeFile(baseCwd, searchRoot) }]
      : [];
  } else {
    const includeHidden = Boolean(
      rawGlob && !globNegated && patternTargetsHidden(rawGlob),
    );
    let ignoreDirs: Set<string> | undefined;
    if (rawGlob && !globNegated) {
      const targeted = [...DEFAULT_IGNORE_DIRS].filter((dir) =>
        globTargetsDir(rawGlob, dir),
      );
      if (targeted.length > 0) {
        ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
        for (const dir of targeted) ignoreDirs.delete(dir);
      }
    }
    const walked = await walkFiles(searchRoot, {
      maxFiles: 8000,
      includeHidden,
      ignoreDirs,
      fileFilter: globMatchesFile,
    });
    discoveryTruncated = walked.truncated;
    // Precompute relative paths once in O(N) instead of O(N log N) inside sort.
    const rootRel = toPosixPath(path.relative(baseCwd, searchRoot));
    const useFastPrefix = Boolean(
      rootRel === "" || (!rootRel.startsWith("..") && !path.isAbsolute(rootRel)),
    );
    targetFiles = walked.files.map((rel) => {
      const abs = path.join(searchRoot, rel);
      const displayRel = useFastPrefix
        ? rootRel
          ? `${rootRel}/${rel}`
          : rel
        : relativeFile(baseCwd, abs);
      return { abs, rel: displayRel };
    });
    targetFiles.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  // Fast whole-buffer / whole-file prechecks skip UTF-8 decoding and line splitting
  // on non-matching files while staying 100% faithful to line-by-line matching.
  const canBufPrecheck =
    query.type === "text" &&
    query.caseSensitive !== false &&
    !query.multiline &&
    query.pattern.length > 0 &&
    !query.pattern.includes("\uFFFD");
  const patternBuf = canBufPrecheck ? Buffer.from(query.pattern, "utf8") : null;
  const canTextCaseInsensitivePrecheck =
    query.type === "text" &&
    query.caseSensitive === false &&
    !query.multiline &&
    query.pattern.length > 0;
  let wholeFileRegex: RegExp | null = null;
  const regexHasDollar = query.type === "regex" && query.pattern.includes("$");
  // Whole-file /m precheck can false-negative on lookarounds matching whitespace/newlines
  // across line boundaries (e.g. `foo(?!\s)` or `(?<!\s)foo`) or inline modifiers disabling
  // multiline mode (e.g. `(?-m:^foo)`), so skip precheck for them.
  const regexUnsafeForWholeFile =
    query.type === "regex" && /\(\?<?[=!]|\(\?[a-z]*-[a-z]*m/.test(query.pattern);
  if (query.type === "regex" && !query.multiline && !regexUnsafeForWholeFile) {
    try {
      wholeFileRegex = new RegExp(
        regex.source,
        `${query.caseSensitive === false ? "i" : ""}m`,
      );
    } catch {
      wholeFileRegex = null;
    }
  }

  const files: FileMatches[] = [];
  let totalMatches = 0;
  let truncated = false;

  const buildFileMatches = (
    relFile: string,
    allLines: string[],
    keptMatches: MatchedLineInfo[],
  ): FileMatches => {
    const lineMap = new Map<number, SearchLine>();
    for (const match of keptMatches) {
      const mIdx = match.lineIndex;
      const from = Math.max(0, mIdx - contextLines);
      const to = Math.min(allLines.length - 1, mIdx + contextLines);
      for (let j = from; j <= to; j++) {
        const ln = j + 1;
        const prev = lineMap.get(ln);
        if (j === mIdx) {
          if (!prev?.isMatch) {
            lineMap.set(ln, {
              lineNumber: ln,
              text: allLines[j]!,
              isMatch: true,
              ...(match.matchStart !== undefined
                ? { matchStart: match.matchStart, matchEnd: match.matchEnd }
                : {}),
            });
          }
        } else if (!prev) {
          lineMap.set(ln, {
            lineNumber: ln,
            text: allLines[j]!,
            isMatch: false,
          });
        }
      }
    }
    return {
      file: relFile,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber),
    };
  };

  const batchSize = 16;
  let anyFileTruncated = false;
  for (let i = 0; i < targetFiles.length && !truncated; i += batchSize) {
    const batch = targetFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async ({ abs: absFile, rel: relFile }): Promise<{ relFile: string; lines: string[]; matchedLines: MatchedLineInfo[]; count: number; fileTruncated: boolean } | null> => {
        try {
          const st = await fs.stat(absFile);
          if (st.size > 2 * 1024 * 1024) return null;
          const buf = await fs.readFile(absFile);
          if (isLikelyBinary(buf)) return null;
          if (patternBuf && buf.indexOf(patternBuf) === -1) return null;

          const content = buf.toString("utf8");
          if (canTextCaseInsensitivePrecheck && !regex.test(content)) return null;
          if (wholeFileRegex && (!regexHasDollar || buf.indexOf(0x0d) === -1)) {
            if (!wholeFileRegex.test(content)) return null;
          }

          let lines: string[] = [];
          let matchedLines: MatchedLineInfo[] = [];
          let count = 0;
          let fileTruncated = false;
          if (query.multiline && summary) {
            for (const _match of multilineMatches(content, regex)) {
              count++;
              if (query.outputMode === "files_with_matches") break;
            }
          } else if (query.multiline) {
            matchedLines = multilineMatchLines(content, regex, maxResults + 1);
            count = matchedLines.length;
            if (count > 0) {
              lines = content.split(/\r?\n/);
              if (lines.length > 0 && lines.at(-1) === "") lines.pop();
            }
          } else {
            lines = content.split(/\r?\n/);
            if (lines.length > 0 && lines.at(-1) === "") lines.pop();
            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx]!;
              const hit = summary ? (regex.test(line) ? { index: 0, length: 0 } : null) : (() => {
                const m = regex.exec(line);
                return m ? { index: m.index, length: m[0].length } : null;
              })();
              if (hit) {
                if (!summary && matchedLines.length >= perFileCap) {
                  fileTruncated = true;
                  break;
                }
                matchedLines.push({
                  lineIndex: idx,
                  matchStart: hit.index,
                  matchEnd: hit.index + hit.length,
                });
                if (query.outputMode === "files_with_matches") break;
              }
            }
            count = matchedLines.length;
          }
          if (!count) return null;
          return {
            relFile,
            lines: summary ? [] : lines,
            matchedLines,
            count,
            fileTruncated,
          };
        } catch {
          return null;
        }
      }),
    );

    for (const item of results) {
      if (!item) continue;
      if (summary) {
        if (files.length === maxResults) {
          truncated = true;
          break;
        }
        files.push({ file: item.relFile, lines: [], count: item.count });
        continue;
      }
      if (item.fileTruncated) {
        anyFileTruncated = true;
      }
      if (totalMatches + item.matchedLines.length > maxResults) {
        const remaining = maxResults - totalMatches;
        if (remaining > 0) {
          const kept = item.matchedLines.slice(0, remaining);
          files.push(buildFileMatches(item.relFile, item.lines, kept));
          totalMatches += kept.length;
        }
        truncated = true;
        break;
      }
      files.push(buildFileMatches(item.relFile, item.lines, item.matchedLines));
      totalMatches += item.matchedLines.length;
    }
  }

  return {
    files,
    totalMatches,
    truncated: truncated || anyFileTruncated || discoveryTruncated,
  };
}

interface GlobFallbackPlan {
  match: (relPosix: string, base: string) => boolean;
  matchedNote: string;
  emptyMessage: string;
}

function buildGlobFallbackPlan(pattern: string): GlobFallbackPlan | null {
  // Case 1: Regex alternation (`a|b|c`) accidentally passed to a glob query
  if (!pattern.includes("{") && pattern.includes("|")) {
    const terms = pattern
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
    if (terms.length >= 2) {
      const termMatchers = terms.map((term) => {
        const hasGlobMeta = /[*?[\]{}]/.test(term);
        if (hasGlobMeta) {
          try {
            const re = globToRegExp(term);
            const matchBase = !term.includes("/");
            return (relPosix: string, base: string) =>
              re.test(relPosix) || (matchBase && re.test(base));
          } catch {
            // Fall through to case-insensitive substring matching
          }
        }
        const needle = term.toLowerCase();
        return (relPosix: string) => relPosix.toLowerCase().includes(needle);
      });
      const allBare = terms.every((t) => !/[*?[\]{}/]/.test(t));
      const label = allBare ? `**/*{${terms.join(",")}}*` : `{${terms.join(",")}}`;
      return {
        match: (relPosix, base) => termMatchers.some((fn) => fn(relPosix, base)),
        matchedNote: `[note: exact glob matched 0 files; auto-expanded regex '|' to "${label}" (glob uses * and {a,b}, not |)]`,
        emptyMessage: "(no files matched; hint: glob uses * and {a,b}, not regex |)",
      };
    }
  }

  // Case 2: Bare keyword without glob wildcards, slashes, or extension dot (e.g. "proxy")
  if (/^[A-Za-z0-9_-]+$/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return {
      match: (relPosix) => relPosix.toLowerCase().includes(needle),
      matchedNote: `[note: exact glob "${pattern}" matched 0 files; showing case-insensitive path matches for "*${pattern}*"]`,
      emptyMessage: "(no files matched)",
    };
  }

  return null;
}

async function formatGlobWalkResult(
  walked: { files: string[]; truncated: boolean },
  searchRoot: string,
  baseCwd: string,
  maxResults: number,
  sortBy: SearchQuery["sortBy"],
  notePrefix?: string,
): Promise<string> {
  const relPrefix = toPosixPath(path.relative(baseCwd, searchRoot));
  const sortedFiles = [...walked.files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sortBy === "mtime") {
    const mtimes = new Map<string, number>();
    for (let i = 0; i < sortedFiles.length; i += 32) {
      await Promise.all(sortedFiles.slice(i, i + 32).map(async (file) => {
        const stat = await fs.lstat(path.join(searchRoot, file)).catch(() => undefined);
        mtimes.set(file, stat?.mtimeMs ?? -Infinity);
      }));
    }
    sortedFiles.sort((a, b) => mtimes.get(b)! - mtimes.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  }
  const items = sortedFiles.slice(0, maxResults).map((f) => {
    if (!relPrefix || relPrefix === ".") return f;
    return `${relPrefix}/${f}`;
  });
  const truncated = walked.truncated || sortedFiles.length > maxResults;
  const header = notePrefix ? `${notePrefix}\n` : "";

  if (!truncated) {
    return `${header}${items.join("\n")}`;
  }

  // Summarize omitted matches by top-level directory so callers can scope follow-ups
  const omitted = sortedFiles.slice(maxResults);
  const dirCounts = new Map<string, number>();
  for (const f of omitted) {
    const slash = f.indexOf("/");
    const bucket = slash === -1 ? "(root)" : `${f.slice(0, slash)}/`;
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1);
  }
  const topDirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 6)
    .map(([dir, cnt]) => `${dir} (${cnt})`);
  const totalLabel = walked.truncated
    ? `${walked.files.length}+`
    : String(walked.files.length);
  const dirSummary =
    topDirs.length > 0 ? `; omitted dirs: ${topDirs.join(", ")}` : "";
  const suffix = `\n... [truncated at ${maxResults} of ${totalLabel} files${dirSummary}]`;
  return `${header}${items.join("\n")}${suffix}`;
}

async function runGlobQuery(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
  isFileTarget: boolean,
): Promise<string> {
  const maxResults = clampInt(query.maxResults, 1, 300, 80);
  const pattern = query.pattern.trim() || "**/*";
  const matcher = globToRegExp(pattern);
  const matchBasename = !pattern.includes("/");
  const includeHidden = patternTargetsHidden(pattern);

  if (isFileTarget) {
    const rel = toPosixPath(path.relative(baseCwd, searchRoot)) || path.basename(searchRoot);
    const base = path.basename(searchRoot);
    const matched = matcher.test(rel) || (matchBasename && matcher.test(base));
    if (matched) return rel;
    const fallback = buildGlobFallbackPlan(pattern);
    if (fallback) {
      return fallback.match(rel, base)
        ? `${fallback.matchedNote}\n${rel}`
        : fallback.emptyMessage;
    }
    return "(no files matched)";
  }

  const scanLimit = Math.max(maxResults + 1, 2000);
  const walked = await walkFiles(searchRoot, {
    maxFiles: scanLimit,
    includeHidden,
    fileFilter: (relPosix) => {
      if (matcher.test(relPosix)) return true;
      if (matchBasename) {
        const base = relPosix.split("/").pop() ?? relPosix;
        return matcher.test(base);
      }
      return false;
    },
  });

  if (walked.files.length > 0) {
    return formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, query.sortBy);
  }

  const fallback = buildGlobFallbackPlan(pattern);
  if (fallback) {
    const fallbackWalked = await walkFiles(searchRoot, {
      maxFiles: scanLimit,
      includeHidden,
      fileFilter: (relPosix) => {
        const base = relPosix.split("/").pop() ?? relPosix;
        return fallback.match(relPosix, base);
      },
    });
    if (fallbackWalked.files.length > 0) {
      return formatGlobWalkResult(
        fallbackWalked,
        searchRoot,
        baseCwd,
        maxResults,
        query.sortBy,
        fallback.matchedNote,
      );
    }
    return fallback.emptyMessage;
  }

  return "(no files matched)";
}

function relativeFile(baseCwd: string, file: string): string {
  return toPosixPath(path.relative(baseCwd, path.resolve(baseCwd, file))) || path.basename(file);
}

async function runFuzzyQuery(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
  isFileTarget: boolean,
): Promise<string> {
  const pattern = query.pattern.trim();
  if (!pattern) throw new Error("Fuzzy pattern must not be blank");
  const matchesType = fileTypeMatcher(query.fileType);
  const maxResults = clampInt(query.maxResults, 1, 200, 30);
  const walked = isFileTarget
    ? { files: [searchRoot], truncated: false }
    : await walkFiles(searchRoot, { maxFiles: 8000, fileFilter: matchesType });
  const candidates = walked.files
    .filter(matchesType)
    .map((file) => relativeFile(baseCwd, path.resolve(searchRoot, file)));
  const { matches, totalMatched } = rankFuzzyPaths(pattern, candidates, maxResults);
  const body = matches.map((match) => match.path).join("\n") || "(no files matched)";
  const footer = walked.truncated || totalMatched > maxResults
    ? `\n... [truncated; showing ${matches.length} files]`
    : "";
  return body + footer;
}

const SHORTLOG_VALUE_FLAGS = new Set([
  "--group",
  "--format",
  "--since",
  "--after",
  "--until",
  "--before",
  "--author",
  "--committer",
  "--grep",
  "--max-count",
  "--skip",
]);

const SHORTLOG_REV_SELECTOR_FLAGS = new Set([
  "--all",
  "--branches",
  "--tags",
  "--remotes",
  "--glob",
  "--stdin",
]);

function hardenGitExecArgs(validatedArgs: string[]): string[] {
  // validatedArgs is ["--no-pager", subcmd, ...rest]
  const subcmd = validatedArgs[1];
  const rest = validatedArgs.slice(2);
  let subArgs = rest;

  if (subcmd === "diff" || subcmd === "log" || subcmd === "show") {
    subArgs = ["--no-ext-diff", "--no-textconv", ...rest];
  } else if (subcmd === "blame") {
    subArgs = ["--no-textconv", ...rest];
  } else if (subcmd === "remote") {
    const remoteSubIdx = rest.findIndex((a) => !a.startsWith("-"));
    if (remoteSubIdx !== -1 && rest[remoteSubIdx] === "show" && !rest.includes("-n")) {
      subArgs = [...rest.slice(0, remoteSubIdx + 1), "-n", ...rest.slice(remoteSubIdx + 1)];
    }
  } else if (subcmd === "shortlog") {
    // With stdin ignored (/dev/null), `git shortlog` without a revision reads empty stdin
    // unless HEAD (or an explicit rev/selector) is provided.
    let hasRev = false;
    let expectVal = false;
    let dashDashIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (expectVal) {
        expectVal = false;
        continue;
      }
      if (a === "--") {
        dashDashIdx = i;
        break;
      }
      if (a.startsWith("-")) {
        const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
        if (SHORTLOG_REV_SELECTOR_FLAGS.has(flagName)) {
          hasRev = true;
        } else if (!a.includes("=") && SHORTLOG_VALUE_FLAGS.has(flagName)) {
          expectVal = true;
        }
        continue;
      }
      hasRev = true;
    }
    if (!hasRev) {
      subArgs =
        dashDashIdx === -1
          ? [...rest, "HEAD"]
          : [...rest.slice(0, dashDashIdx), "HEAD", ...rest.slice(dashDashIdx)];
    }
    subArgs = ["--no-ext-diff", "--no-textconv", ...subArgs];
  }

  return [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.external=",
    "-c",
    "gpg.program=false",
    "-c",
    "gpg.openpgp.program=false",
    "-c",
    "gpg.ssh.program=false",
    "-c",
    "gpg.x509.program=false",
    "--no-pager",
    ...(subcmd ? [subcmd, ...subArgs] : subArgs),
  ];
}

async function runGitQuery(query: SearchQuery, searchRoot: string): Promise<string> {
  const gitArgs = validateReadonlyGitArgs(query.pattern);
  const execArgs = hardenGitExecArgs(gitArgs);
  const res = await execBinaryAsync("git", execArgs, {
    cwd: searchRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 512 * 1024,
    env: withNonInteractiveGitEnv(),
  });

  if (res.error) {
    throw new Error(`git execution error: ${res.error}`);
  }
  if (res.timedOut) {
    throw new Error("git query timed out");
  }
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout).trim();
    throw new Error(msg || `git exited with code ${res.exitCode}`);
  }

  const out = res.stdout.trimEnd();
  return out || "(empty output)";
}

const MAX_SEARCH_LINE_CHARS = 240;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function formatLineSnippet(line: SearchLine, maxChars = MAX_SEARCH_LINE_CHARS): string {
  const text = line.text;
  if (text.length <= maxChars) return text;
  if (!line.isMatch || line.matchStart === undefined) {
    return `${sliceSafeChars(text, maxChars)}...`;
  }

  const len = text.length;
  const mStart = clampInt(line.matchStart, 0, len);
  const mEnd =
    line.matchEnd !== undefined ? clampInt(line.matchEnd, mStart, len) : mStart;

  // Keep existing prefix truncation whenever the matched span fits inside [0, maxChars]
  const prefix = sliceSafeChars(text, maxChars);
  if (mStart < prefix.length && mEnd <= prefix.length) {
    return `${prefix}...`;
  }

  // Center a ~maxChars window around [mStart, mEnd] while keeping the match start visible
  const matchLen = mEnd - mStart;
  const lead =
    matchLen >= maxChars
      ? Math.min(Math.floor(maxChars * 0.1), mStart)
      : Math.min(
          Math.min(80, Math.floor(maxChars * 0.35)),
          Math.floor((maxChars - matchLen) / 2),
        );

  let winStart = Math.max(0, mStart - lead);
  let winEnd = Math.min(len, winStart + maxChars);
  if (winEnd === len) {
    winStart = Math.max(0, winEnd - maxChars);
  }

  // Keep both boundaries UTF-16 surrogate-pair safe
  if (winStart > 0 && winStart < len && isLowSurrogate(text.charCodeAt(winStart))) {
    if (winStart === mStart && isHighSurrogate(text.charCodeAt(winStart - 1))) {
      winStart -= 1;
    } else {
      winStart += 1;
    }
  }
  if (winEnd < len && winEnd > winStart && isHighSurrogate(text.charCodeAt(winEnd - 1))) {
    winEnd -= 1;
  }
  if (winEnd < winStart) winEnd = winStart;

  const leadEllipsis = winStart > 0 ? "..." : "";
  const trailEllipsis = winEnd < len ? "..." : "";
  return `${leadEllipsis}${text.slice(winStart, winEnd)}${trailEllipsis}`;
}

function formatFileMatches(
  files: FileMatches[],
  totalMatches: number,
  truncated: boolean,
): string {
  if (files.length === 0) {
    return "(no matches)";
  }
  const blocks: string[] = [];
  for (const fm of files) {
    const lines = fm.lines.map((l) => {
      const sep = l.isMatch ? ":" : "-";
      return `  ${l.lineNumber}${sep} ${formatLineSnippet(l)}`;
    });
    blocks.push(`${fm.file}\n${lines.join("\n")}`);
  }
  const footer = truncated ? `\n... [truncated at ${totalMatches} matches]` : "";
  return `${blocks.join("\n")}${footer}`;
}

interface TextCost {
  chars: number;
  bytes: number;
}

function measureCost(text: string): TextCost {
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}

interface BudgetedLineEntry {
  lineNumber: number;
  isMatch: boolean;
  formatted: string;
  cost: TextCost;
}

interface BudgetedFileState {
  file: string;
  headerCost: TextCost;
  matchEntries: BudgetedLineEntry[];
  contextEntries: BudgetedLineEntry[];
  firstMatchLine: SearchLine;
  shownMatches: number;
  selectedContexts: BudgetedLineEntry[];
  selectedLineNums: Set<number>;
}

function fileOmissionMarker(omitted: number): string {
  if (omitted <= 0) return "";
  return `\n  ... (+${omitted} more ${omitted === 1 ? "match" : "matches"})`;
}

function buildTruncatedNotice(
  shownMatches: number,
  totalMatches: number,
  shownFiles: number,
  totalFiles: number,
  maxResultsTruncated: boolean,
  omittedContextOnly: boolean,
): string {
  const totalLabel = maxResultsTruncated ? `${totalMatches}+` : `${totalMatches}`;
  const filesLabel =
    shownFiles < totalFiles
      ? `across ${shownFiles} of ${totalFiles} files`
      : totalFiles === 1
        ? "in 1 file"
        : `across ${totalFiles} files`;
  if (omittedContextOnly) {
    return `\n... [truncated: showed all ${shownMatches} ${shownMatches === 1 ? "match" : "matches"} ${filesLabel}; omitted context lines${maxResultsTruncated ? `; capped at ${totalMatches} matches` : ""}]`;
  }
  return `\n... [truncated: showed ${shownMatches} of ${totalLabel} matches ${filesLabel}]`;
}

function fitShrunkMatchLine(
  line: SearchLine,
  maxChars: number,
  maxBytes: number,
): string | null {
  const prefix = `  ${line.lineNumber}: `;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const availChars = maxChars - prefix.length;
  const availBytes = maxBytes - prefixBytes;
  if (availChars < 24 || availBytes < 24) return null;

  let winBudget = Math.min(
    MAX_SEARCH_LINE_CHARS,
    Math.max(16, Math.min(availChars, availBytes) - 6),
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    const snippet = formatLineSnippet(line, winBudget);
    const full = `${prefix}${snippet}`;
    const fullBytes = Buffer.byteLength(full, "utf8");
    if (full.length <= maxChars && fullBytes <= maxBytes) {
      return full;
    }
    const ratio = Math.min(
      availChars / Math.max(1, snippet.length),
      availBytes / Math.max(1, fullBytes - prefixBytes),
    );
    const nextWin = Math.floor(Math.min(winBudget, snippet.length) * ratio) - 4;
    if (nextWin < 16 || nextWin >= winBudget) break;
    winBudget = nextWin;
  }
  return null;
}

function formatBudgetedContentSection(params: {
  header: string;
  files: FileMatches[];
  totalMatches: number;
  maxResultsTruncated: boolean;
  contextLines: number;
  charBudget: number;
  byteBudget: number;
}): string | null {
  const {
    header,
    files,
    totalMatches,
    maxResultsTruncated,
    contextLines,
    charBudget,
    byteBudget,
  } = params;

  const headerCost = measureCost(header);
  if (charBudget <= headerCost.chars + 40 || byteBudget <= headerCost.bytes + 40) {
    return null;
  }

  const states: BudgetedFileState[] = [];
  let totalContextCount = 0;
  for (const fm of files) {
    const matchEntries: BudgetedLineEntry[] = [];
    const contextEntries: BudgetedLineEntry[] = [];
    let firstMatchLine: SearchLine | undefined;
    for (const l of fm.lines) {
      const sep = l.isMatch ? ":" : "-";
      const formatted = `  ${l.lineNumber}${sep} ${formatLineSnippet(l)}`;
      const entry: BudgetedLineEntry = {
        lineNumber: l.lineNumber,
        isMatch: l.isMatch,
        formatted,
        cost: {
          chars: 1 + formatted.length,
          bytes: 1 + Buffer.byteLength(formatted, "utf8"),
        },
      };
      if (l.isMatch) {
        if (!firstMatchLine) firstMatchLine = l;
        matchEntries.push(entry);
      } else {
        contextEntries.push(entry);
        totalContextCount += 1;
      }
    }
    if (matchEntries.length === 0 || !firstMatchLine) continue;
    states.push({
      file: fm.file,
      headerCost: {
        chars: 1 + fm.file.length,
        bytes: 1 + Buffer.byteLength(fm.file, "utf8"),
      },
      matchEntries,
      contextEntries,
      firstMatchLine,
      shownMatches: 0,
      selectedContexts: [],
      selectedLineNums: new Set<number>(),
    });
  }

  if (states.length === 0) return null;

  const totalFiles = states.length;
  const effectiveTotalMatches = states.reduce((acc, s) => acc + s.matchEntries.length, 0);
  const actualTotalMatches = Math.max(totalMatches, effectiveTotalMatches);

  let usedChars = headerCost.chars;
  let usedBytes = headerCost.bytes;
  let shownMatches = 0;
  let shownContexts = 0;
  let shownFiles = 0;

  // Phase 1: File coverage first — ensure as many matched files as fit get header + first real match line
  let allFilesFirstChars = headerCost.chars;
  let allFilesFirstBytes = headerCost.bytes;
  for (const st of states) {
    const first = st.matchEntries[0]!;
    const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
    allFilesFirstChars += st.headerCost.chars + first.cost.chars + markerCost.chars;
    allFilesFirstBytes += st.headerCost.bytes + first.cost.bytes + markerCost.bytes;
  }
  const allShownInitialNotice = measureCost(
    buildTruncatedNotice(
      totalFiles,
      actualTotalMatches,
      totalFiles,
      totalFiles,
      maxResultsTruncated,
      totalFiles === actualTotalMatches,
    ),
  );

  if (
    allFilesFirstChars + allShownInitialNotice.chars <= charBudget &&
    allFilesFirstBytes + allShownInitialNotice.bytes <= byteBudget
  ) {
    for (const st of states) {
      const first = st.matchEntries[0]!;
      const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
      st.shownMatches = 1;
      st.selectedLineNums.add(first.lineNumber);
      usedChars += st.headerCost.chars + first.cost.chars + markerCost.chars;
      usedBytes += st.headerCost.bytes + first.cost.bytes + markerCost.bytes;
      shownMatches += 1;
      shownFiles += 1;
    }
  } else {
    const worstTruncNotice = measureCost(
      buildTruncatedNotice(
        actualTotalMatches,
        actualTotalMatches,
        totalFiles,
        totalFiles,
        maxResultsTruncated,
        false,
      ),
    );
    const minOmittedNotice =
      totalFiles > 1
        ? measureCost(
            `\n... [+${totalFiles} more files; use outputMode: "files_with_matches"]`,
          )
        : { chars: 0, bytes: 0 };
    const bodyChars = Math.max(0, charBudget - headerCost.chars - worstTruncNotice.chars);
    const bodyBytes = Math.max(0, byteBudget - headerCost.bytes - worstTruncNotice.bytes);
    const targetOmittedChars =
      totalFiles > 1
        ? Math.max(minOmittedNotice.chars, Math.min(220, Math.floor(bodyChars * 0.25)))
        : 0;
    const targetOmittedBytes =
      totalFiles > 1
        ? Math.max(minOmittedNotice.bytes, Math.min(220, Math.floor(bodyBytes * 0.25)))
        : 0;

    const tryAddFirstMatch = (
      st: BudgetedFileState,
      reserveChars: number,
      reserveBytes: number,
    ): boolean => {
      const first = st.matchEntries[0]!;
      const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
      const addChars = st.headerCost.chars + first.cost.chars + markerCost.chars;
      const addBytes = st.headerCost.bytes + first.cost.bytes + markerCost.bytes;
      if (
        usedChars + addChars + worstTruncNotice.chars + reserveChars <= charBudget &&
        usedBytes + addBytes + worstTruncNotice.bytes + reserveBytes <= byteBudget
      ) {
        st.shownMatches = 1;
        st.selectedLineNums.add(first.lineNumber);
        usedChars += addChars;
        usedBytes += addBytes;
        shownMatches += 1;
        shownFiles += 1;
        return true;
      }
      return false;
    };

    for (const st of states) {
      if (tryAddFirstMatch(st, targetOmittedChars, targetOmittedBytes)) {
        continue;
      }
      if (shownFiles === 0) {
        if (tryAddFirstMatch(st, minOmittedNotice.chars, minOmittedNotice.bytes)) {
          break;
        }
        const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
        const availLineChars =
          charBudget -
          usedChars -
          st.headerCost.chars -
          markerCost.chars -
          worstTruncNotice.chars -
          minOmittedNotice.chars -
          1;
        const availLineBytes =
          byteBudget -
          usedBytes -
          st.headerCost.bytes -
          markerCost.bytes -
          worstTruncNotice.bytes -
          minOmittedNotice.bytes -
          1;
        const shrunk = fitShrunkMatchLine(st.firstMatchLine, availLineChars, availLineBytes);
        if (shrunk) {
          const shrunkCost: TextCost = {
            chars: 1 + shrunk.length,
            bytes: 1 + Buffer.byteLength(shrunk, "utf8"),
          };
          st.matchEntries[0] = {
            ...st.matchEntries[0]!,
            formatted: shrunk,
            cost: shrunkCost,
          };
          st.shownMatches = 1;
          st.selectedLineNums.add(st.matchEntries[0]!.lineNumber);
          usedChars += st.headerCost.chars + shrunkCost.chars + markerCost.chars;
          usedBytes += st.headerCost.bytes + shrunkCost.bytes + markerCost.bytes;
          shownMatches += 1;
          shownFiles += 1;
        }
      }
      break;
    }

    if (shownFiles === 0) {
      return null;
    }
  }

  // Phase 2: Fair expansion when all matched files are covered (additional match lines first, then adjacent context)
  if (shownFiles === totalFiles) {
    const matchExhausted = new Array<boolean>(totalFiles).fill(false);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let f = 0; f < totalFiles; f++) {
        if (matchExhausted[f]) continue;
        const st = states[f]!;
        if (st.shownMatches >= st.matchEntries.length) {
          matchExhausted[f] = true;
          continue;
        }
        const entry = st.matchEntries[st.shownMatches]!;
        const prevMarkerCost = measureCost(
          fileOmissionMarker(st.matchEntries.length - st.shownMatches),
        );
        const nextMarkerCost = measureCost(
          fileOmissionMarker(st.matchEntries.length - (st.shownMatches + 1)),
        );
        const deltaChars = entry.cost.chars + nextMarkerCost.chars - prevMarkerCost.chars;
        const deltaBytes = entry.cost.bytes + nextMarkerCost.bytes - prevMarkerCost.bytes;
        const nextShownMatches = shownMatches + 1;
        const nextNoticeCost = measureCost(
          buildTruncatedNotice(
            nextShownMatches,
            actualTotalMatches,
            shownFiles,
            totalFiles,
            maxResultsTruncated,
            nextShownMatches === actualTotalMatches,
          ),
        );
        if (
          usedChars + deltaChars + nextNoticeCost.chars <= charBudget &&
          usedBytes + deltaBytes + nextNoticeCost.bytes <= byteBudget
        ) {
          st.shownMatches += 1;
          st.selectedLineNums.add(entry.lineNumber);
          usedChars += deltaChars;
          usedBytes += deltaBytes;
          shownMatches = nextShownMatches;
          progressed = true;
        } else {
          matchExhausted[f] = true;
        }
      }
    }

    if (contextLines > 0 && totalContextCount > 0) {
      const eligibleByFile: BudgetedLineEntry[][] = states.map((st) => {
        if (st.contextEntries.length === 0) return [];
        const renderedMatches = st.matchEntries.slice(0, st.shownMatches).map((m) => m.lineNumber);
        const unrenderedSet = new Set(
          st.matchEntries.slice(st.shownMatches).map((m) => m.lineNumber),
        );
        const eligible: Array<{ entry: BudgetedLineEntry; dist: number }> = [];
        for (const ctx of st.contextEntries) {
          let bestDist = Number.POSITIVE_INFINITY;
          for (const mLn of renderedMatches) {
            const dist = Math.abs(ctx.lineNumber - mLn);
            if (dist > contextLines || dist >= bestDist) continue;
            const lo = Math.min(ctx.lineNumber, mLn);
            const hi = Math.max(ctx.lineNumber, mLn);
            let blocked = false;
            for (let ln = lo + 1; ln < hi; ln++) {
              if (unrenderedSet.has(ln)) {
                blocked = true;
                break;
              }
            }
            if (!blocked) {
              bestDist = dist;
            }
          }
          if (bestDist <= contextLines) {
            eligible.push({ entry: ctx, dist: bestDist });
          }
        }
        eligible.sort((a, b) => a.dist - b.dist || a.entry.lineNumber - b.entry.lineNumber);
        return eligible.map((e) => e.entry);
      });

      const noticeCost = measureCost(
        buildTruncatedNotice(
          shownMatches,
          actualTotalMatches,
          shownFiles,
          totalFiles,
          maxResultsTruncated,
          shownMatches === actualTotalMatches,
        ),
      );
      const pickedCtxIdx = states.map(() => new Set<number>());
      let ctxProgressed = true;
      while (ctxProgressed) {
        ctxProgressed = false;
        for (let f = 0; f < totalFiles; f++) {
          const candidates = eligibleByFile[f]!;
          if (candidates.length === 0) continue;
          const st = states[f]!;
          const picked = pickedCtxIdx[f]!;
          for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
            if (picked.has(cIdx)) continue;
            const ctx = candidates[cIdx]!;
            if (
              !st.selectedLineNums.has(ctx.lineNumber - 1) &&
              !st.selectedLineNums.has(ctx.lineNumber + 1)
            ) {
              continue;
            }
            if (
              usedChars + ctx.cost.chars + noticeCost.chars <= charBudget &&
              usedBytes + ctx.cost.bytes + noticeCost.bytes <= byteBudget
            ) {
              picked.add(cIdx);
              st.selectedContexts.push(ctx);
              st.selectedLineNums.add(ctx.lineNumber);
              usedChars += ctx.cost.chars;
              usedBytes += ctx.cost.bytes;
              shownContexts += 1;
              ctxProgressed = true;
              break;
            }
          }
        }
      }
    }
  }

  // Phase 3: Render chosen lines, per-file omission markers, remaining-files summary, and truncated notice
  const parts: string[] = [header];
  for (let f = 0; f < shownFiles; f++) {
    const st = states[f]!;
    parts.push(`\n${st.file}`);
    const chosenLines = [
      ...st.matchEntries.slice(0, st.shownMatches),
      ...st.selectedContexts,
    ].sort((a, b) => a.lineNumber - b.lineNumber);
    for (const line of chosenLines) {
      parts.push(`\n${line.formatted}`);
    }
    const omittedInFile = st.matchEntries.length - st.shownMatches;
    if (omittedInFile > 0) {
      parts.push(fileOmissionMarker(omittedInFile));
    }
  }

  const omittedContextOnly =
    shownFiles === totalFiles &&
    shownMatches === actualTotalMatches &&
    shownContexts < totalContextCount;
  const truncLine =
    shownFiles < totalFiles ||
    shownMatches < actualTotalMatches ||
    shownContexts < totalContextCount
      ? buildTruncatedNotice(
          shownMatches,
          actualTotalMatches,
          shownFiles,
          totalFiles,
          maxResultsTruncated,
          omittedContextOnly,
        )
      : maxResultsTruncated
        ? `\n... [truncated at ${totalMatches} matches]`
        : "";

  let omittedFilesLine = "";
  if (shownFiles < totalFiles) {
    const bodySoFar = parts.join("");
    const truncCost = measureCost(truncLine);
    const remChars = charBudget - bodySoFar.length - truncCost.chars;
    const remBytes = byteBudget - Buffer.byteLength(bodySoFar, "utf8") - truncCost.bytes;
    const unshown = states.slice(shownFiles);

    const allItems = unshown.map((st) => `${st.file} (${st.matchEntries.length})`);
    const allLine = `\n... [more files: ${allItems.join(", ")}]`;
    if (
      allLine.length <= remChars &&
      Buffer.byteLength(allLine, "utf8") <= remBytes
    ) {
      omittedFilesLine = allLine;
    } else {
      const named: string[] = [];
      let bestLine = "";
      for (let i = 0; i < unshown.length; i++) {
        const item = allItems[i]!;
        const leftAfter = unshown.length - (i + 1);
        const list = named.length === 0 ? item : `${named.join(", ")}, ${item}`;
        const suffix =
          leftAfter > 0
            ? `, +${leftAfter} more ${leftAfter === 1 ? "file" : "files"}; use outputMode: "files_with_matches"]`
            : "]";
        const candidate = `\n... [more files: ${list}${suffix}`;
        if (
          candidate.length <= remChars &&
          Buffer.byteLength(candidate, "utf8") <= remBytes
        ) {
          named.push(item);
          bestLine = candidate;
        } else {
          break;
        }
      }
      if (bestLine) {
        omittedFilesLine = bestLine;
      } else {
        const fallback = `\n... [+${unshown.length} more ${unshown.length === 1 ? "file" : "files"}; use outputMode: "files_with_matches"]`;
        const shortFallback = `\n... [+${unshown.length} more ${unshown.length === 1 ? "file" : "files"}]`;
        if (
          fallback.length <= remChars &&
          Buffer.byteLength(fallback, "utf8") <= remBytes
        ) {
          omittedFilesLine = fallback;
        } else if (
          shortFallback.length <= remChars &&
          Buffer.byteLength(shortFallback, "utf8") <= remBytes
        ) {
          omittedFilesLine = shortFallback;
        }
      }
    }
  }

  const result = `${parts.join("")}${omittedFilesLine}${truncLine}`;
  if (result.length <= charBudget && Buffer.byteLength(result, "utf8") <= byteBudget) {
    return result;
  }
  return null;
}

interface ExecutedQuerySection {
  text: string;
  header: string;
  contentResult?: {
    files: FileMatches[];
    totalMatches: number;
    truncated: boolean;
    contextLines: number;
  };
}

async function executeSingleQuery(
  query: SearchQuery,
  index: number,
  baseCwd: string,
  useRg: boolean,
): Promise<ExecutedQuerySection> {
  const header = `## Query ${index + 1} [${query.type}] ${query.pattern}${query.path ? ` (in ${query.path})` : ""}`;
  try {
    if (!query.pattern || typeof query.pattern !== "string") {
      throw new Error("Query 'pattern' must be a non-empty string");
    }
    if (query.multiline !== undefined && typeof query.multiline !== "boolean") {
      throw new Error("multiline must be a boolean");
    }
    if (query.outputMode !== undefined && !["content", "files_with_matches", "count"].includes(query.outputMode)) {
      throw new Error("Invalid outputMode");
    }
    if (query.sortBy !== undefined && !["path", "mtime"].includes(query.sortBy)) {
      throw new Error("Invalid sortBy");
    }
    const searchRoot = query.path ? resolvePath(query.path, baseCwd) : baseCwd;
    let targetStat;
    try {
      targetStat = await fs.stat(searchRoot);
    } catch {
      throw new Error(`Path does not exist: ${query.path || baseCwd}`);
    }

    if (query.type === "git") {
      const gitCwd = targetStat.isFile() ? path.dirname(searchRoot) : searchRoot;
      const out = await runGitQuery(query, gitCwd);
      return { header, text: `${header}\n${out}` };
    }

    if (query.type === "glob") {
      const out = await runGlobQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return { header, text: `${header}\n${out}` };
    }

    if (query.type === "fuzzy") {
      const out = await runFuzzyQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return { header, text: `${header}\n${out}` };
    }

    if (query.type === "text" || query.type === "regex") {
      let res;
      if (useRg) {
        try {
          res = await runTextOrRegexWithRg(query, searchRoot, baseCwd);
        } catch (err) {
          // Only fallback on spawn error; surface regex errors directly
          if (err instanceof Error && err.message.startsWith("rg spawn error:")) {
            res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
          } else {
            throw err;
          }
        }
      } else {
        res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
      }
      if (query.outputMode === "count" || query.outputMode === "files_with_matches") {
        const body = res.files.map(({ file, count }) => query.outputMode === "count"
          ? `${file}: ${count} ${query.multiline ? "matches" : "matching lines"}`
          : file).join("\n") || "(no matches)";
        const footer = res.truncated ? `\n... [truncated; showing ${res.files.length} files]` : "";
        return { header, text: `${header}\n${body}${footer}` };
      }
      const text = `${header}\n${formatFileMatches(res.files, res.totalMatches, res.truncated)}`;
      return {
        header,
        text,
        contentResult:
          res.files.length > 0
            ? {
                files: res.files,
                totalMatches: res.totalMatches,
                truncated: res.truncated,
                contextLines: clampInt(query.contextLines, 0, 5, 0),
              }
            : undefined,
      };
    }

    throw new Error(`Unsupported query type: ${String(query.type)}`);
  } catch (err) {
    return { header, text: `${header}\nERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runBatchSearch(
  input: BatchSearchInput,
  options: BatchSearchRuntimeOptions = {},
): Promise<{ text: string; isError: boolean }> {
  const parsedQueries = parseMaybeJsonArray(input?.queries);
  if (!parsedQueries.ok) {
    if (
      parsedQueries.kind === "corrupted_literal" ||
      (parsedQueries.kind === "wrong_type" &&
        (typeof input?.queries === "boolean" || input?.queries === null))
    ) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "batch_search",
          items: [
            {
              label: "queries",
              value:
                parsedQueries.kind === "corrupted_literal" ? parsedQueries.value : input.queries,
              expected: "an array of query objects",
            },
          ],
          fallbackAdvice:
            "split into smaller queries or use a single compound read-only run_command.",
        }),
        isError: true,
      };
    }
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true,
    };
  }
  const rawQueries = parsedQueries.value;
  if (rawQueries.length === 0) {
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true,
    };
  }
  if (rawQueries.length > 20) {
    return {
      text: "Error: 'queries' supports at most 20 queries per call.",
      isError: true,
    };
  }

  const corruptedQueries: CorruptedItem[] = [];
  for (let i = 0; i < rawQueries.length; i++) {
    if (!isPlainObject(rawQueries[i])) {
      corruptedQueries.push({
        label: `queries[${i}]`,
        value: rawQueries[i],
        expected: "a query object ({ type, pattern, ... })",
      });
    }
  }
  if (corruptedQueries.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "batch_search",
        items: corruptedQueries,
        fallbackAdvice:
          "split into smaller queries or use a single compound read-only run_command.",
      }),
      isError: true,
    };
  }
  const queries = rawQueries as unknown as SearchQuery[];

  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }

  const maxChars = clampInt(input.maxChars, 500, DEFAULT_INLINE_MAX_BYTES, 8_500);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const needsTextSearch = queries.some(
    (q) => q.type === "text" || q.type === "regex",
  );
  const useRg =
    needsTextSearch && !options.forceNodeFallback && (await isRipgrepAvailable());

  const executed = await Promise.all(
    queries.map((q, idx) => executeSingleQuery(q, idx, baseCwd, useRg)),
  );

  const separator = "\n\n";
  const rawSections = executed.map((e) => e.text);
  const joined = rawSections.join(separator);
  const sepChars = separator.length * Math.max(0, rawSections.length - 1);
  const sepBytes = Buffer.byteLength(separator, "utf8") * Math.max(0, rawSections.length - 1);

  const overChars = joined.length > maxChars;
  const overBytes = Buffer.byteLength(joined, "utf8") > maxBytes;

  let finalSections = rawSections;
  if (overChars || overBytes) {
    const rawCharLens = rawSections.map((s) => s.length);
    const rawByteLens = rawSections.map((s) => Buffer.byteLength(s, "utf8"));
    const byteBudgets = overBytes
      ? computeWaterFillBudgets(rawByteLens, Math.max(0, maxBytes - sepBytes))
      : rawByteLens.map(() => maxBytes);
    const charBudgets = overChars
      ? computeWaterFillBudgets(rawCharLens, Math.max(0, maxChars - sepChars))
      : computeWaterFillBudgets(
          rawCharLens.map((len, idx) =>
            rawByteLens[idx]! > byteBudgets[idx]! ? maxChars : len,
          ),
          Math.max(0, maxChars - sepChars),
        );

    finalSections = executed.map((ex, idx) => {
      const charBudget = charBudgets[idx] ?? 0;
      const byteBudget = byteBudgets[idx] ?? 0;
      if (
        !ex.contentResult ||
        (rawCharLens[idx]! <= charBudget && rawByteLens[idx]! <= byteBudget)
      ) {
        return ex.text;
      }
      const budgeted = formatBudgetedContentSection({
        header: ex.header,
        files: ex.contentResult.files,
        totalMatches: ex.contentResult.totalMatches,
        maxResultsTruncated: ex.contentResult.truncated,
        contextLines: ex.contentResult.contextLines,
        charBudget,
        byteBudget,
      });
      return budgeted ?? ex.text;
    });
  }

  // Allocate budget fairly across queries via water-filling within maxChars & inline UTF-8 byte ceiling
  return {
    text: fitSectionsToByteBudget(finalSections, maxChars, maxBytes, separator),
    isError: false,
  };
}

function patternTargetsHidden(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return /(?:^|[/,{])\.[^./]/.test(normalized);
}

function globTargetsDir(glob: string, dir: string): boolean {
  const normalized = glob
    .replace(/\\/g, "/")
    .replace(/(^|[,{])(?:\.\/)+/g, "$1");
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[/,{])${escaped}(?:$|[/},])`).test(normalized);
}

function clampInt(val: unknown, min: number, max: number, fallback = min): number {
  const num =
    typeof val === "number"
      ? val
      : typeof val === "string" && val.trim() !== ""
        ? Number(val)
        : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}
