import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "vendor",
]);

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function resolvePath(inputPath: string, baseDir?: string): string {
  const expanded = expandHome(inputPath.trim());
  const root = baseDir ? path.resolve(expandHome(baseDir)) : process.cwd();
  return path.resolve(root, expanded);
}

export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

export function isLikelyBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface TextFileContent {
  content: string;
  /** UTF-8 BOM-stripped text (same coordinate space as `content`) retaining original line endings. */
  rawContent: string;
  eol: "\r\n" | "\n";
  mixedEol: boolean;
  hasBom: boolean;
  size: number;
  mode: number;
  rawBuffer: Buffer;
}

export function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

export function detectUtf16Bom(buf: Buffer): "UTF-16 LE" | "UTF-16 BE" | null {
  if (buf.length < 2) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    // Distinguish UTF-32 LE BOM (FF FE 00 00) from UTF-16 LE (FF FE ...)
    if (buf.length >= 4 && buf[2] === 0x00 && buf[3] === 0x00) {
      return null;
    }
    return "UTF-16 LE";
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return "UTF-16 BE";
  }
  return null;
}
export async function readTextFile(
  filePath: string,
  maxBytes = 10 * 1024 * 1024,
): Promise<TextFileContent> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `File exceeds maximum size (${stat.size} bytes > ${maxBytes} bytes): ${filePath}`,
    );
  }
  const buf = await fs.readFile(filePath);
  const utf16Bom = detectUtf16Bom(buf);
  if (utf16Bom) {
    throw new Error(
      `UTF-16 encoded file is not supported (convert to UTF-8 first): ${filePath} [${utf16Bom}]`,
    );
  }
  if (isLikelyBinary(buf)) {
    throw new Error(`Binary file cannot be read as text: ${filePath}`);
  }
  const hasBom = hasUtf8Bom(buf);
  const rawContent = (hasBom ? buf.subarray(3) : buf).toString("utf8");
  let crlfCount = 0;
  let lfOnlyCount = 0;
  for (let i = 0; i < rawContent.length; i++) {
    if (rawContent[i] === "\n") {
      if (i > 0 && rawContent[i - 1] === "\r") crlfCount++;
      else lfOnlyCount++;
    }
  }
  const eol: "\r\n" | "\n" = crlfCount > lfOnlyCount ? "\r\n" : "\n";
  const mixedEol = crlfCount > 0 && lfOnlyCount > 0;
  return {
    content: rawContent,
    rawContent,
    eol,
    mixedEol,
    hasBom,
    size: stat.size,
    mode: stat.mode & 0o7777,
    rawBuffer: buf,
  };
}

/**
 * Convert a glob pattern (supporting **, *, ?, {a,b}, [abc]) to a RegExp
 * matching POSIX-normalized relative paths.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\*{3,}/g, "**")
    .replace(/(?:\*\*\/)+/g, "**/");
  const re = `^${compileGlobBody(normalized)}$`;
  try {
    return new RegExp(re);
  } catch (err) {
    throw new Error(
      `Invalid glob pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function compileGlobBody(normalized: string): string {
  let re = "";
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const close = findClosingBracket(normalized, i);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        let inner = normalized.slice(i + 1, close);
        const negated = inner.startsWith("!") || inner.startsWith("^");
        if (negated) inner = inner.slice(1);
        inner = inner.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
        re += negated ? `(?!/)[${"^"}${inner}]` : `[${inner}]`;
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = findMatchingBrace(normalized, i);
      if (close === -1) {
        re += "\\{";
        i += 1;
      } else {
        const parts = splitBraceAlternatives(normalized.slice(i + 1, close));
        const sub = parts
          .map((part) => compileGlobBody(part.replace(/\*{3,}/g, "**").replace(/(?:\*\*\/)+/g, "**/")))
          .join("|");
        re += `(?:${sub})`;
        i = close + 1;
      }
    } else if (".+^$()|\\".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }

  return re;
}

function findClosingBracket(str: string, openIdx: number): number {
  let i = openIdx + 1;
  if (i < str.length && (str[i] === "!" || str[i] === "^")) i++;
  if (i < str.length && str[i] === "]") i++; // leading `]` is a literal member of the class
  for (; i < str.length; i++) {
    if (str[i] === "]") return i;
  }
  return -1;
}

function findMatchingBrace(str: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "[") {
      const close = findClosingBracket(str, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "[") {
      const close = findClosingBracket(inner, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

export interface WalkOptions {
  maxFiles?: number;
  maxDepth?: number;
  includeHidden?: boolean;
  ignoreDirs?: Set<string>;
  fileFilter?: (relPosixPath: string) => boolean;
}

export interface WalkResult {
  files: string[];
  truncated: boolean;
}

export async function walkFiles(
  rootDir: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const maxFiles = Math.max(0, Math.trunc(options.maxFiles ?? 5000));
  const maxDepth = options.maxDepth ?? 32;
  const includeHidden = options.includeHidden ?? false;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const fileFilter = options.fileFilter;

  const files: string[] = [];
  let truncated = false;

  // Global concurrency semaphore caps simultaneous fs.readdir calls across all
  // recursion depths to prevent EMFILE FD exhaustion on nested workspaces.
  const MAX_CONCURRENT_READDIRS = 16;
  let activeReaddirs = 0;
  const waitQueue: Array<() => void> = [];
  const drainWaiters = (): void => {
    while (waitQueue.length > 0) {
      waitQueue.shift()!();
    }
  };
  const markTruncated = (): void => {
    if (truncated) return;
    truncated = true;
    drainWaiters();
  };
  const readDirBounded = async (dir: string) => {
    if (truncated) return null;
    while (activeReaddirs >= MAX_CONCURRENT_READDIRS) {
      await new Promise<void>((resolve) => waitQueue.push(resolve));
      if (truncated) return null;
    }
    if (truncated) return null;
    activeReaddirs++;
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } finally {
      activeReaddirs--;
      if (truncated) {
        drainWaiters();
      } else {
        const next = waitQueue.shift();
        if (next) next();
      }
    }
  };

  interface DirScanResult {
    localFiles: string[];
    subdirs: Array<{ abs: string; rel: string }>;
  }

  const scanDir = async (dir: string, relDir: string): Promise<DirScanResult> => {
    if (truncated) return { localFiles: [], subdirs: [] };
    let entries;
    try {
      entries = await readDirBounded(dir);
    } catch {
      return { localFiles: [], subdirs: [] };
    }
    if (!entries || truncated) return { localFiles: [], subdirs: [] };
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const localFiles: string[] = [];
    const subdirs: Array<{ abs: string; rel: string }> = [];
    for (const entry of entries) {
      const name = entry.name;
      if (!includeHidden && name.startsWith(".")) {
        if (!(entry.isDirectory() && name === ".agents")) {
          continue;
        }
      }
      const relPosix = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        subdirs.push({ abs: path.join(dir, name), rel: relPosix });
      } else if (entry.isFile()) {
        if (fileFilter && !fileFilter(relPosix)) continue;
        localFiles.push(relPosix);
      }
    }
    return { localFiles, subdirs };
  };

  // Prefetch sibling directories concurrently in bounded batches while emitting
  // matched files in deterministic lexicographical DFS order and only marking
  // `truncated` when a (maxFiles + 1)-th matching file is actually encountered.
  async function visit(
    dir: string,
    relDir: string,
    depth: number,
    prefetched?: Promise<DirScanResult>,
  ): Promise<void> {
    if (truncated || depth > maxDepth) return;
    const { localFiles, subdirs } = await (prefetched ?? scanDir(dir, relDir));

    for (const relPosix of localFiles) {
      if (files.length >= maxFiles) {
        markTruncated();
        return;
      }
      files.push(relPosix);
    }

    if (depth >= maxDepth || subdirs.length === 0) return;

    const batchSize = 8;
    for (let i = 0; i < subdirs.length && !truncated; i += batchSize) {
      const slice = subdirs.slice(i, i + batchSize);
      const prefetches = slice.map((sub) => scanDir(sub.abs, sub.rel));
      try {
        for (let j = 0; j < slice.length && !truncated; j++) {
          await visit(slice[j]!.abs, slice[j]!.rel, depth + 1, prefetches[j]);
        }
      } finally {
        // Ensure no sibling prefetches remain in flight after early truncation
        // (avoids dangling directory handles / EBUSY on Windows temp cleanup).
        if (truncated) {
          await Promise.allSettled(prefetches);
        }
      }
    }
  }

  await visit(rootDir, "", 0);
  return { files, truncated };
}
