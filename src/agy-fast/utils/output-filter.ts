// Matches standard ANSI CSI / OSC escape sequences
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

// eslint-disable-next-line no-control-regex
const LINE_ERASE_CSI_RE = /\x1B\[(?:2K|0?K)/;
// eslint-disable-next-line no-control-regex
const LEADING_CLEAR_TO_EOL_RE = /^(?:\x1B\[0?K)+/;

/**
 * Clean terminal carriage-return progress overwrites and ANSI line-erase sequences
 * (`\x1b[2K`, `\x1b[K`, `\x1b[0K`) so cleared spinner frames never leak into output.
 */
export function normalizeTerminalOutput(raw: string): string {
  const rawLines = raw.replace(/\r\n/g, "\n").split("\n");
  const normalizedLines: string[] = [];

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      normalizedLines.push("");
      continue;
    }

    const hadLineErase = LINE_ERASE_CSI_RE.test(rawLine);
    let working = rawLine;
    const lastFullErase = working.lastIndexOf("\x1B[2K");
    if (lastFullErase !== -1) {
      working = working.slice(lastFullErase + 4);
    }

    if (!working.includes("\r") && !hadLineErase) {
      normalizedLines.push(stripAnsi(working));
      continue;
    }

    let currentFrame = "";
    const crFrames = working.split("\r");
    for (let idx = 0; idx < crFrames.length; idx++) {
      let seg = crFrames[idx]!;
      if (idx > 0 && LEADING_CLEAR_TO_EOL_RE.test(seg)) {
        seg = seg.replace(LEADING_CLEAR_TO_EOL_RE, "");
        currentFrame = stripAnsi(seg);
        continue;
      }
      const cleanSeg = stripAnsi(seg);
      if (cleanSeg.length > 0) {
        currentFrame = cleanSeg;
      }
    }

    if (hadLineErase && currentFrame.length === 0) {
      // Transient progress/spinner line explicitly cleared before newline/EOF
      continue;
    }
    normalizedLines.push(currentFrame);
  }

  return normalizedLines.join("\n").trimEnd();
}

/**
 * Antigravity spills call_mcp_tool responses over ~10 KB UTF-8 to disk
 * (`The output was large and was saved to: ...`), forcing an extra LLM turn
 * to read_file(output.txt). Keeping default tool responses <= 8,800 UTF-8 bytes
 * guarantees inline delivery with headroom for timestamp/JSON wrappers.
 */
export const DEFAULT_INLINE_MAX_BYTES = 8_800;

export type TruncateMode = "head" | "head-tail";

export function sliceUtf8Bytes(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const unitLen = cp > 0xffff ? 2 : 1;
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}

export function sliceUtf8BytesTail(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let startIndex = text.length;
  for (let i = text.length; i > 0; ) {
    let unitLen = 1;
    let cp: number;
    const code = text.charCodeAt(i - 1);
    if (
      i >= 2 &&
      code >= 0xdc00 &&
      code <= 0xdfff &&
      text.charCodeAt(i - 2) >= 0xd800 &&
      text.charCodeAt(i - 2) <= 0xdbff
    ) {
      unitLen = 2;
      cp = text.codePointAt(i - 2)!;
    } else {
      cp = code;
    }
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i -= unitLen;
    startIndex = i;
  }
  return text.slice(startIndex);
}

export function truncateHeadTailWithByteNotice(
  text: string,
  maxBytes: number,
): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;

  if (limit < 120) {
    return truncateWithByteNotice(text, limit);
  }

  const maxMarkerBytes = Buffer.byteLength(
    `\n... [truncated: folded ${totalBytes} middle bytes; total ${totalBytes} bytes] ...\n`,
    "utf8",
  );
  const contentBytes = limit - maxMarkerBytes;
  if (contentBytes < 40) {
    return truncateWithByteNotice(text, limit);
  }

  const headBudget = Math.max(16, Math.floor(contentBytes * 0.38));
  const tailBudget = Math.max(24, contentBytes - headBudget);

  let head = sliceUtf8Bytes(text, headBudget);
  const lastNewline = head.lastIndexOf("\n");
  if (
    lastNewline > 0 &&
    Buffer.byteLength(head.slice(0, lastNewline), "utf8") > headBudget * 0.5
  ) {
    head = head.slice(0, lastNewline);
  }

  let tail = sliceUtf8BytesTail(text, tailBudget);
  const firstNewline = tail.indexOf("\n");
  if (
    firstNewline !== -1 &&
    Buffer.byteLength(tail.slice(firstNewline + 1), "utf8") > tailBudget * 0.5
  ) {
    tail = tail.slice(firstNewline + 1);
  }

  const headBytes = Buffer.byteLength(head, "utf8");
  const tailBytes = Buffer.byteLength(tail, "utf8");
  const omittedBytes = Math.max(1, totalBytes - headBytes - tailBytes);
  const marker = `\n... [truncated: folded ${omittedBytes} middle bytes; total ${totalBytes} bytes] ...\n`;
  const result = `${head}${marker}${tail}`;
  return Buffer.byteLength(result, "utf8") <= limit
    ? result
    : truncateWithByteNotice(result, limit);
}

export function truncateWithByteNotice(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;

  if (limit < 56) {
    if (limit <= 3) return sliceUtf8Bytes(text, limit);
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }

  const maxNoticeBytes = Buffer.byteLength(
    `\n... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8",
  );
  const cutoffBytes = Math.max(0, limit - maxNoticeBytes);
  if (cutoffBytes < 8) {
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}\n... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= limit
    ? result
    : sliceUtf8Bytes(result, limit);
}

export function sliceSafeChars(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let end = limit;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function sliceSafeCharsTail(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let start = text.length - limit;
  if (start < text.length) {
    const firstCode = text.charCodeAt(start);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      start += 1;
    }
  }
  return text.slice(start);
}

export function truncateHeadTailWithNotice(
  text: string,
  maxChars: number,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;

  if (limit < 120) {
    return truncateWithNotice(text, limit);
  }

  const maxMarkerLen =
    `\n... [truncated: folded ${text.length} middle chars; total ${text.length} chars] ...\n`
      .length;
  const contentBudget = limit - maxMarkerLen;
  if (contentBudget < 40) {
    return truncateWithNotice(text, limit);
  }

  const headBudget = Math.max(16, Math.floor(contentBudget * 0.38));
  const tailBudget = Math.max(24, contentBudget - headBudget);

  let head = sliceSafeChars(text, headBudget);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > headBudget * 0.5) {
    head = head.slice(0, lastNewline);
  }

  let tail = sliceSafeCharsTail(text, tailBudget);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline !== -1 && tail.length - (firstNewline + 1) > tailBudget * 0.5) {
    tail = tail.slice(firstNewline + 1);
  }

  const omittedChars = Math.max(1, text.length - head.length - tail.length);
  const marker = `\n... [truncated: folded ${omittedChars} middle chars; total ${text.length} chars] ...\n`;
  const result = `${head}${marker}${tail}`;
  return result.length <= limit ? result : truncateWithNotice(result, limit);
}

export function truncateWithNotice(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;

  if (limit < 48) {
    if (limit <= 3) return sliceSafeChars(text, limit);
    return `${sliceSafeChars(text, limit - 3)}...`;
  }

  const maxNoticeLen = `\n... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, limit - maxNoticeLen);
  if (cutoff < 8) {
    return `${sliceSafeChars(text, limit - 3)}...`;
  }
  let slice = sliceSafeChars(text, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const result = `${slice}\n... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= limit ? result : sliceSafeChars(result, limit);
}

/**
 * Pure water-filling budget allocator: items smaller than the current fair
 * share keep their exact size and donate 100% of their unused share to larger
 * items. Sum of returned budgets equals min(sum(sizes), totalBudget).
 */
export function computeWaterFillBudgets(
  sizes: number[],
  totalBudget: number,
): number[] {
  if (sizes.length === 0) return [];
  const budgets = new Array<number>(sizes.length).fill(0);
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) return budgets;

  let remainingBudget = Math.trunc(totalBudget);
  if (remainingBudget <= 0) return budgets;

  const order = sizes
    .map((raw, idx) => ({
      idx,
      size: Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0,
    }))
    .sort((a, b) => a.size - b.size || a.idx - b.idx);

  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);
    const item = order[i]!;
    if (item.size <= share) {
      budgets[item.idx] = item.size;
      remainingBudget -= item.size;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[order[j]!.idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }

  return budgets;
}

/**
 * Water-filling character budget allocator: short sections keep their full
 * text, and remaining budget is split evenly among longer sections so total
 * joined length stays strictly within maxChars.
 */
export function fitSectionsToBudget(
  sections: string[],
  maxChars: number,
  separator = "\n\n",
  truncateMode: TruncateMode = "head",
): string {
  if (sections.length === 0 || !Number.isFinite(maxChars) || maxChars <= 0) return "";
  const truncateChar =
    truncateMode === "head-tail" ? truncateHeadTailWithNotice : truncateWithNotice;
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;

  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateChar(joined, maxChars);
  }

  const budgets = computeWaterFillBudgets(
    sections.map((s) => s.length),
    maxChars - sepTotal,
  );

  const fitted = sections
    .map((sec, idx) => truncateChar(sec, budgets[idx] ?? 0))
    .join(separator);
  return fitted.length <= maxChars ? fitted : truncateChar(fitted, maxChars);
}

/**
 * Fits sections within both a character budget and an optional UTF-8 byte
 * budget (water-filling by UTF-8 byte size when CJK/multi-byte characters
 * push the joined string over maxBytes).
 */
export function fitSectionsToByteBudget(
  sections: string[],
  maxChars: number,
  maxBytes?: number,
  separator = "\n\n",
  truncateMode: TruncateMode = "head",
): string {
  const truncateBytes =
    truncateMode === "head-tail"
      ? truncateHeadTailWithByteNotice
      : truncateWithByteNotice;
  const charFitted = fitSectionsToBudget(sections, maxChars, separator, truncateMode);
  if (maxBytes === undefined) {
    return charFitted;
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }

  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateBytes(charFitted, maxBytes);
  }

  const byteBudgets = computeWaterFillBudgets(
    sections.map((s) => Buffer.byteLength(s, "utf8")),
    maxBytes - sepBytes,
  );

  const byteFittedSections = sections.map((sec, idx) =>
    truncateBytes(sec, byteBudgets[idx] ?? 0),
  );
  let fitted = byteFittedSections.join(separator);
  if (fitted.length > maxChars) {
    fitted = fitSectionsToBudget(
      byteFittedSections,
      maxChars,
      separator,
      truncateMode,
    );
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes
    ? fitted
    : truncateBytes(fitted, maxBytes);
}

/**
 * Benign zero-count phrases (e.g. "0 errors", "errors: 0", "0 failed",
 * "failed: 0", "0 failures", "0 warnings") stripped prior to error/danger
 * matching so passing summary counts never trigger false positives, while
 * preserving zero-indexed entity failures ("Worker 0 failed") and prefix
 * failures ("FAIL: 0/5 checks passed", "FAILED: 0 tests matched").
 */
const ZERO_INDEXED_ENTITY_RE =
  /\b(?:worker|task|step|job|shard|rank|stage|attempt|node|process|test|check|thread|agent|container|pod|case|suite|phase|index|slot|cpu|gpu|core|port|channel|client|server|host|peer)(?:\s+#?|-)\s*$/i;

const BENIGN_ZERO_COUNT_LEADING_RE =
  /\b(?:0|no)\s+(?:errors?|warnings?|fail(?:ed|ures?|ing)?)(?:\(s\))?(?=$|[\s,;.)\]|])/gi;

const BENIGN_ZERO_COUNT_TRAILING_RE =
  /\b(?:errors|error\(s\)|warnings|warning\(s\)|failures|failure\(s\)|failed|failing)\s*(?:(?::|=)\s*0(?=$|\s*(?:$|[,;)\]|]|\.(?!\d)|(?:\b(?:skipped|warnings?|errors?|failures?|total|ignored|pending)\b)))|\(\s*0\s*\))/gi;

function stripBenignZeroCounts(line: string): string {
  const afterLeading = line.replace(
    BENIGN_ZERO_COUNT_LEADING_RE,
    (match, offset: number, full: string) => {
      const prefix = full.slice(Math.max(0, offset - 24), offset);
      return ZERO_INDEXED_ENTITY_RE.test(prefix) ? match : " ";
    },
  );
  return afterLeading.replace(BENIGN_ZERO_COUNT_TRAILING_RE, " ");
}

const ERROR_LINE_PATTERN =
  /(?:\berr!|\b(?:errors?|fail(?:ed|ing|ure|ures)?|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b|caused by:|application failed to start|compilation error|<<<\s*(?:failure|error)|找不到符号|符号:|位置:)/i;

const ROOT_CAUSE_HEADER_PATTERN =
  /(?:^\s*(?:description|action):|caused by:|application failed to start|⎯\s*failed tests|compilation error)/i;

// Strict superset of ERROR_LINE_PATTERN plus warnings, crashes, and localized failure terms
const FOLD_DANGER_TOKEN_PATTERN =
  /(?:\berr!|\b(?:errors?|fail(?:ed|ing|ure|ures)?|warns?|warnings?|exceptions?|tracebacks?|panics?|fatals?|assertions?|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined|compilation error|killed|sigkill|sigsegv|sigabrt|oom|out of memory|timed out|timeout|refused|denied|permission|unhandled|mismatched|mismatch)\b|\bexit\s+(?:status|code)\s+[1-9]\d*\b|caused by:|application failed to start|<<<\s*(?:failure|error)|[✖✘✗×]\s+|找不到符号|符号:|位置:|错误|失败|异常|警告)/i;

function isErrorLine(line: string): boolean {
  return ERROR_LINE_PATTERN.test(stripBenignZeroCounts(line));
}

function hasFoldDangerToken(line: string): boolean {
  return FOLD_DANGER_TOKEN_PATTERN.test(stripBenignZeroCounts(line));
}

const JSON_INFO_LOG_PATTERNS: RegExp[] = [
  /^\s*\{"level":(?:10|20|30)\b/,
  /^\s*\{[^}]*"level"\s*:\s*"(?:trace|debug|info)"/i,
];

const ALWAYS_NOISE_LINE_PATTERNS: RegExp[] = [
  /^\[ERROR\]\s*(?:To see the full stack trace|Re-run Maven using the -X|For more information about the errors|\[Help \d+\]|->\s*\[Help \d+\])/i,
  /^\(node:\d+\)\s*ExperimentalWarning:/,
  /^\(Use `node --trace-warnings/,
];

function isFailureNoiseLine(line: string): boolean {
  if (ALWAYS_NOISE_LINE_PATTERNS.some((re) => re.test(line))) return true;
  if (JSON_INFO_LOG_PATTERNS.some((re) => re.test(line))) {
    // Never strip a structured log line if it reports an actual 5xx/error/exception
    return !/"statusCode"\s*:\s*5\d\d|\b(?:error|exception|failed|fatal)\b/i.test(
      stripBenignZeroCounts(line),
    );
  }
  return false;
}

const SUMMARY_LINE_PATTERN =
  /\b(passed|tests?|specs?|suites?|ok|warnings?|errors?|built in|compiled|done in|finished)\b/i;

const MONOREPO_PREFIX_PATTERN =
  /^(?:@[\w.-]+\/)?[\w./-]+(?::[A-Za-z][\w.-]*|\s+[A-Za-z][\w.-]*):\s+/;

const GREEN_BUILD_OR_PASS_PATTERNS: RegExp[] = [
  // Vite / Rollup / esbuild / Webpack / bundler banners & asset size lines
  /^(?:vite|rollup|esbuild|webpack|rspack|parcel|tsup|rolldown)\s+v?\d[\w.-]*\b/i,
  /^transforming(?:\.\.\.|\s*\(\d+\).*|\s+\d+\s+modules?)?$/i,
  /^(?:[✓✔]\s*)?\d+\s+modules?\s+transformed\.?$/i,
  /^(?:rendering chunks|computing (?:gzip|brotli) size|building (?:for |SSR )?production|bundling|minifying|emitting assets)(?:\.{0,3})$/i,
  /^(?:\.\.?\/)?(?:dist|build|out|\.next|\.output|public|assets|lib)\/\S+\s+\d+(?:\.\d+)?\s*(?:B|kB|KB|MB|GB|KiB|MiB|bytes)\b/i,
  /^\S+\.(?:m?js|cjs|css|html|svg|png|woff2?|json|map|wasm)\s+\d+(?:\.\d+)?\s*(?:B|kB|KB|MB|GB|KiB|MiB)(?:\s+[│|]\s*(?:gzip|brotli|map):|\s*$)/i,
  /^(?:[✓✔⚡]\s*)?built\b.*(?:\bin\s{1,4}\d+(?:\.\d+)?\s{0,4}(?:ms|s|m)\b|\(\s{0,4}\d+(?:\.\d+)?\s{0,4}(?:B|KB|kB|MB|GB|KiB|MiB)\s{0,4}\))/i,
  /^(?:[✓✔⚡]\s*)?(?:done in\s+\d+(?:\.\d+)?\s*(?:ms|s|m)\.?|build (?:succeeded|completed|finished)\b|compiled successfully\b|bundle created\b)/i,
  /^(?:asset|chunk|orphan modules|runtime modules|cacheable modules)\s+\S.*\b(?:bytes|KiB|MiB|kB|KB|MB|modules?)\b/i,
  // npm / pnpm / yarn / turbo script & workspace banners
  /^>\s+(?:@[\w.-]+\/)?[\w.-]+@[\w.+-]+(?:\s|$)/,
  /^>\s+(?:vite|tsc|esbuild|rollup|webpack|rspack|tsup|unbuild|next|nuxt|astro|svelte-kit|vitest|jest|mocha|pnpm|npm|yarn|turbo|nx|node|tsx)\b/,
  /^(?:@[\w.-]+\/)?[\w./-]+\s+[A-Za-z][\w.-]*\$\s+\S/,
  /^Scope:\s+\d+\s+of\s+\d+\s+workspace projects\b/i,
  /^Tasks:\s+\d+\s+successful\b/i,
  /^Cached:\s+\d+\s+cached\b/i,
  /^cache hit,\s+replaying logs\b/i,
  /^Time:\s+\d+(?:\.\d+)?\s*(?:ms|s|m)\b/i,
  /^(?:yarn run v\d|•\s+Packages in scope:|•\s+Running\s+\S+\s+in\s+\d+\s+packages)/i,
  // Test pass lines (Vitest / Jest / Mocha / Node / Go / Cargo / TAP)
  /^[✓✔]\s+\S/,
  /^PASS\s+\S/,
  /^(?:---\s+PASS:\s*|===\s+(?:RUN|PAUSE|CONT)\s+)\S/,
  /^ok\t\S/,
  /^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))/i,
  /^ok\s+\d+\s+-\s+\S/,
  /^test\s+\S+\s+\.\.\.\s+ok\b/,
  /^running\s+\d+\s+tests?$/i,
  /^(?:Test Files|Tests|Suites|Snapshots|Start at|Duration|test result:\s{0,4}ok\.)\s.*(?:\bpassed\b|\btotal\b|\b\d+(?:\.\d+)?(?:ms|s)\b|\bok\.)/i,
  // Rust / Go / Gradle / Maven progress (strictly scoped [INFO] whitelist)
  /^(?:Compiling|Checking|Downloading|Downloaded|Updating|Fresh|Locking|Packaging|Documenting|Finished)\s+\S/,
  /^go:\s+downloading\s+\S/,
  /^>\s+Task\s+:[\w:.-]+\s+(?:UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED)\s*$/,
  /^\[INFO\]\s*(?:---\s+\S|Building\s+\S|Compiling\s+\S|Changes detected|Nothing to compile|Copying\s+\d+|Using\s+'[^']+'\s+encoding|Downloading\b|Downloaded\b|Installing\s+\S|Packaging\s+\S|Tests run:\s*\d+,\s*Failures:\s*0,\s*Errors:\s*0\b|Results:|Running\s+\S|Reactor Summary|BUILD SUCCESS|Total time:|Finished at:|-+\s*$|$)/i,
];

// Explicit test-runner PASS verdicts whose trailing test description/path may
// legitimately mention domain words like "error", "undefined", "timeout", or "invalid"
const UNAMBIGUOUS_TEST_PASS_PATTERNS: RegExp[] = [
  /^[✓✔]\s+(?!built\b|done\b|\d+\s+modules?\s+transformed\b)\S/,
  /^---\s+PASS:\s+\S/,
  /^ok\s+\d+\s+-\s+\S/,
  /^ok\t\S/,
  /^test\s+\S+\s+\.\.\.\s+ok\s*$/,
  /^PASS\s+\S+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|vue|svelte)\b/,
];

function isUnambiguousTestPassLine(trimmed: string): boolean {
  if (!trimmed || /[✖✘✗×]/.test(trimmed)) return false;
  return UNAMBIGUOUS_TEST_PASS_PATTERNS.some((re) => re.test(trimmed));
}

const MIN_FOLD_RUN_LINES = 4;
const PROTECTED_TAIL_LINES = 15;

function isGreenBuildOrPassLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isUnambiguousTestPassLine(trimmed)) return true;

  const prefixMatch = MONOREPO_PREFIX_PATTERN.exec(trimmed);
  const inner = prefixMatch ? trimmed.slice(prefixMatch[0].length).trim() : "";
  if (inner && isUnambiguousTestPassLine(inner)) return true;

  if (hasFoldDangerToken(trimmed)) return false;

  if (GREEN_BUILD_OR_PASS_PATTERNS.some((re) => re.test(trimmed))) {
    return true;
  }

  if (prefixMatch) {
    if (!inner) return false;
    if (inner === "Done") return true;
    return GREEN_BUILD_OR_PASS_PATTERNS.some((re) => re.test(inner));
  }

  return false;
}

function formatLastCollapsedPreview(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 120) return trimmed;
  return `${sliceSafeChars(trimmed, 117)}...`;
}

/**
 * Proactively collapses contiguous runs (>= 4 non-empty matching lines) of known
 * green build/pass progress lines outside the protected final 15 lines, only when
 * the summary placeholder is strictly shorter than the original run.
 */
function foldGreenBuildPhaseLines(lines: string[]): {
  lines: string[];
  collapsedLines: number;
} {
  const foldableEnd = Math.max(0, lines.length - PROTECTED_TAIL_LINES);
  if (foldableEnd < MIN_FOLD_RUN_LINES) {
    return { lines, collapsedLines: 0 };
  }

  const out: string[] = [];
  let collapsedLines = 0;
  let i = 0;

  while (i < foldableEnd) {
    if (!isGreenBuildOrPassLine(lines[i]!)) {
      out.push(lines[i]!);
      i++;
      continue;
    }

    const start = i;
    let lastGreen = i;
    let greenCount = 1;
    i++;

    while (i < foldableEnd) {
      const cur = lines[i]!;
      if (isGreenBuildOrPassLine(cur)) {
        lastGreen = i;
        greenCount++;
        i++;
      } else if (cur.trim() === "") {
        i++;
      } else {
        break;
      }
    }

    if (greenCount >= MIN_FOLD_RUN_LINES) {
      const runLen = lastGreen - start + 1;
      const placeholder = `... (collapsed ${runLen} build/pass lines; last: ${formatLastCollapsedPreview(lines[lastGreen]!)})`;
      let originalRunChars = runLen - 1; // '\n' separators
      for (let j = start; j <= lastGreen; j++) {
        originalRunChars += lines[j]!.length;
      }
      if (placeholder.length < originalRunChars) {
        out.push(placeholder);
        collapsedLines += runLen;
      } else {
        for (let j = start; j <= lastGreen; j++) {
          out.push(lines[j]!);
        }
      }
      i = lastGreen + 1;
    } else {
      for (let j = start; j <= lastGreen; j++) {
        out.push(lines[j]!);
      }
      i = lastGreen + 1;
    }
  }

  for (let j = foldableEnd; j < lines.length; j++) {
    out.push(lines[j]!);
  }

  return { lines: out, collapsedLines };
}

function formatOmittedLinesMarker(omitted: number, markTruncated: boolean): string {
  return markTruncated
    ? `... [truncated: ${omitted} lines omitted] ...`
    : `... (${omitted} lines omitted) ...`;
}

function renderSelectedIndices(
  lines: string[],
  indices: number[],
  leadingOmission: boolean,
  markTruncated = false,
): string {
  if (indices.length === 0) return "";
  const out: string[] = [];
  if (leadingOmission && indices[0]! > 0) {
    out.push(formatOmittedLinesMarker(indices[0]!, markTruncated));
  }
  let prev = -1;
  for (const idx of indices) {
    if (prev !== -1 && idx > prev + 1) {
      out.push(formatOmittedLinesMarker(idx - prev - 1, markTruncated));
    }
    out.push(lines[idx]!);
    prev = idx;
  }
  return out.join("\n");
}

function packTailIndices(
  lines: string[],
  candidates: number[],
  budget: number,
  leadingOmission: boolean,
  markTruncated = false,
): { indices: number[]; text: string } {
  if (candidates.length === 0 || budget <= 0) {
    return { indices: [], text: "" };
  }

  const chosenRev: number[] = [];
  let usedChars = 0;

  for (let k = candidates.length - 1; k >= 0; k--) {
    const idx = candidates[k]!;
    const lineLen = lines[idx]!.length;
    let add = lineLen;
    if (chosenRev.length > 0) {
      const nextIdx = chosenRev[chosenRev.length - 1]!;
      if (nextIdx > idx + 1) {
        const gapMarkerLen = formatOmittedLinesMarker(
          nextIdx - idx - 1,
          markTruncated,
        ).length;
        add = lineLen + 1 + gapMarkerLen + 1;
      } else {
        add = lineLen + 1;
      }
    }
    const headerLen =
      leadingOmission && idx > 0
        ? formatOmittedLinesMarker(idx, markTruncated).length + 1
        : 0;

    if (usedChars + add + headerLen <= budget) {
      chosenRev.push(idx);
      usedChars += add;
    } else {
      break;
    }
  }

  const indices = chosenRev.reverse();
  return {
    indices,
    text: renderSelectedIndices(lines, indices, leadingOmission, markTruncated),
  };
}

function compactSingleOversizedErrorLine(
  line: string,
  lineIdx: number,
  limit: number,
): string {
  const rawPrefix =
    lineIdx > 0 ? `${formatOmittedLinesMarker(lineIdx, true)}\n` : "";
  const prefix = limit - rawPrefix.length >= 40 ? rawPrefix : "";
  const avail = limit - prefix.length;
  if (line.length <= avail) {
    return `${prefix}${line}`;
  }
  const maxFoldedMarker = ` ... [truncated: folded ${line.length} chars] ... `;
  if (avail >= maxFoldedMarker.length + 24) {
    const contentAvail = avail - maxFoldedMarker.length;
    const headChars = Math.max(8, Math.floor(contentAvail * 0.28));
    const tailChars = Math.max(16, contentAvail - headChars);
    const head = sliceSafeChars(line, headChars);
    const tail = sliceSafeCharsTail(line, tailChars);
    const omitted = Math.max(1, line.length - head.length - tail.length);
    const marker = ` ... [truncated: folded ${omitted} chars] ... `;
    return `${prefix}${head}${marker}${tail}`;
  }
  const joiner = " ... ";
  if (avail <= joiner.length + 2) {
    return `${prefix}${sliceSafeCharsTail(line, avail)}`;
  }
  const contentAvail = avail - joiner.length;
  const headChars = Math.max(1, Math.floor(contentAvail * 0.28));
  const tailChars = Math.max(1, contentAvail - headChars);
  return `${prefix}${sliceSafeChars(line, headChars)}${joiner}${sliceSafeCharsTail(line, tailChars)}`;
}

function compactLongFailureLines(lines: string[], maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";

  const fullText = lines.join("\n");
  if (fullText.length <= limit) return fullText;

  // Tiny budget fallback: preserve the end of the failure output (surrogate-safe)
  if (limit < 80) {
    if (limit <= 3) return sliceSafeCharsTail(fullText, limit);
    return `...${sliceSafeCharsTail(fullText, limit - 3)}`;
  }

  // Locate first root-cause / real error line and build error+tail candidate set
  let firstErrorLineIdx = -1;
  const keepIndices = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const monoMatch = MONOREPO_PREFIX_PATTERN.exec(trimmed);
    const monoInner = monoMatch ? trimmed.slice(monoMatch[0].length).trim() : "";
    if (
      isUnambiguousTestPassLine(trimmed) ||
      (monoInner.length > 0 && isUnambiguousTestPassLine(monoInner))
    ) {
      continue;
    }
    if (ROOT_CAUSE_HEADER_PATTERN.test(line)) {
      if (firstErrorLineIdx === -1) firstErrorLineIdx = i;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 8);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    } else if (isErrorLine(line)) {
      if (firstErrorLineIdx === -1) firstErrorLineIdx = i;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }

  // Always include the final 15 lines for summary/stack tail
  const tailStart = Math.max(0, lines.length - PROTECTED_TAIL_LINES);
  for (let i = tailStart; i < lines.length; i++) {
    keepIndices.add(i);
  }

  // No real error markers found: fill backward from the very end across all lines
  if (firstErrorLineIdx === -1) {
    const allIndices = Array.from({ length: lines.length }, (_, idx) => idx);
    const tailPacked = packTailIndices(lines, allIndices, limit, true, true);
    if (tailPacked.text) return tailPacked.text;
    return compactSingleOversizedErrorLine(
      lines[lines.length - 1]!,
      lines.length - 1,
      limit,
    );
  }

  const candidateIndices = [...keepIndices].sort((a, b) => a - b);
  const fullCandidatesText = renderSelectedIndices(
    lines,
    candidateIndices,
    true,
    true,
  );
  if (fullCandidatesText.length <= limit) {
    return fullCandidatesText;
  }

  // Check if tail-priority packing alone already preserves the first real error
  const tailOnly = packTailIndices(lines, candidateIndices, limit, true, true);
  if (tailOnly.indices.length > 0 && tailOnly.indices[0]! <= firstErrorLineIdx) {
    return tailOnly.text;
  }

  // Single-line / last-line oversized error: allocate full limit across ~28% head + ~72% tail
  if (firstErrorLineIdx === candidateIndices[candidateIndices.length - 1]!) {
    return compactSingleOversizedErrorLine(
      lines[firstErrorLineIdx]!,
      firstErrorLineIdx,
      limit,
    );
  }

  // Early error exists distinct from the tail:
  // Allocate ~28% to the first root-cause/error cluster and ~72% (+ unused head) to tail.
  const maxSepLen = `\n${formatOmittedLinesMarker(lines.length, true)}\n`.length;
  const usableForSplit = Math.max(0, limit - maxSepLen);
  const headBudget = Math.floor(usableForSplit * 0.28);

  const firstPosInCandidates = candidateIndices.indexOf(firstErrorLineIdx);
  const headIndices: number[] = [];

  if (headBudget >= 24 && firstPosInCandidates !== -1) {
    const prevIdx = firstErrorLineIdx - 1;
    const leadIfPrev =
      prevIdx > 0 ? formatOmittedLinesMarker(prevIdx, true).length + 1 : 0;
    const prevLine = prevIdx >= 0 ? lines[prevIdx]! : "";
    const firstLine = lines[firstErrorLineIdx]!;
    if (
      prevIdx >= 0 &&
      prevLine.length <= Math.floor(headBudget * 0.35) &&
      leadIfPrev + prevLine.length + 1 + firstLine.length <= headBudget
    ) {
      headIndices.push(prevIdx);
    }

    for (let pos = firstPosInCandidates; pos < candidateIndices.length; pos++) {
      const idx = candidateIndices[pos]!;
      if (headIndices.length > 0 && idx > headIndices[headIndices.length - 1]! + 1) {
        break;
      }
      const trial = [...headIndices, idx];
      const rendered = renderSelectedIndices(lines, trial, true, true);
      if (rendered.length <= headBudget) {
        headIndices.push(idx);
      } else {
        break;
      }
    }
  }

  // When the very first error line alone exceeds headBudget, pack trailing candidates
  // first and donate all unused budget back to head+tail splitting of that oversized line.
  if (headIndices.length === 0) {
    const remainingCandidates = candidateIndices.filter((idx) => idx > firstErrorLineIdx);
    const minHeadReserve = Math.max(40, headBudget);
    const maxTailBudget = Math.max(0, limit - minHeadReserve - maxSepLen);
    const tailPacked = packTailIndices(
      lines,
      remainingCandidates,
      maxTailBudget,
      false,
      true,
    );
    if (tailPacked.indices.length > 0) {
      const omitted = tailPacked.indices[0]! - firstErrorLineIdx - 1;
      const sep =
        omitted > 0
          ? `\n${formatOmittedLinesMarker(omitted, true)}\n`
          : "\n";
      const availForFirst = limit - tailPacked.text.length - sep.length;
      if (availForFirst >= 24) {
        const firstRendered = compactSingleOversizedErrorLine(
          lines[firstErrorLineIdx]!,
          firstErrorLineIdx,
          availForFirst,
        );
        const combinedResult = `${firstRendered}${sep}${tailPacked.text}`;
        return combinedResult.length <= limit
          ? combinedResult
          : sliceSafeChars(combinedResult, limit);
      }
    }
    // Both firstErrorLineIdx and trailing candidate line(s) are oversized (> maxChars):
    // preserve ~28% head of first error + marker + ~72% tail of last candidate line.
    if (remainingCandidates.length > 0) {
      const lastIdx = remainingCandidates[remainingCandidates.length - 1]!;
      const omitted = lastIdx - firstErrorLineIdx - 1;
      const sep =
        omitted > 0
          ? `\n${formatOmittedLinesMarker(omitted, true)}\n`
          : "\n... [truncated: folded middle] ...\n";
      const avail = limit - sep.length;
      if (avail >= 24) {
        const headShare = Math.max(10, Math.floor(avail * 0.28));
        const tailShare = Math.max(14, avail - headShare);
        const headPart = `${sliceSafeChars(lines[firstErrorLineIdx]!, Math.max(1, headShare - 3))}...`;
        const tailPart = `...${sliceSafeCharsTail(lines[lastIdx]!, Math.max(1, tailShare - 3))}`;
        const combinedResult = `${headPart}${sep}${tailPart}`;
        return combinedResult.length <= limit
          ? combinedResult
          : sliceSafeChars(combinedResult, limit);
      }
    }
    if (tailOnly.text) return tailOnly.text;
    return compactSingleOversizedErrorLine(
      lines[firstErrorLineIdx]!,
      firstErrorLineIdx,
      limit,
    );
  }

  const headText = renderSelectedIndices(lines, headIndices, true, true);
  const headLastIdx = headIndices[headIndices.length - 1]!;
  const remainingCandidates = candidateIndices.filter((idx) => idx > headLastIdx);
  const tailBudget = Math.max(0, limit - headText.length - maxSepLen);
  const tailPacked = packTailIndices(
    lines,
    remainingCandidates,
    tailBudget,
    false,
    true,
  );

  if (tailPacked.indices.length > 0) {
    const omitted = tailPacked.indices[0]! - headLastIdx - 1;
    const sep =
      omitted > 0
        ? `\n${formatOmittedLinesMarker(omitted, true)}\n`
        : "\n";
    const combinedResult = `${headText}${sep}${tailPacked.text}`;
    return combinedResult.length <= limit
      ? combinedResult
      : sliceSafeChars(combinedResult, limit);
  }

  if (remainingCandidates.length > 0 && tailBudget > 6) {
    const lastIdx = remainingCandidates[remainingCandidates.length - 1]!;
    const omitted = lastIdx - headLastIdx - 1;
    const sep =
      omitted > 0
        ? `\n${formatOmittedLinesMarker(omitted, true)}\n`
        : "\n";
    const availTail = limit - headText.length - sep.length;
    if (availTail > 3) {
      const tailSlice = `...${sliceSafeCharsTail(lines[lastIdx]!, availTail - 3)}`;
      const combinedResult = `${headText}${sep}${tailSlice}`;
      return combinedResult.length <= limit
        ? combinedResult
        : sliceSafeChars(combinedResult, limit);
    }
  }

  return headText.length <= limit ? headText : sliceSafeChars(headText, limit);
}

function describeFatalExitCode(exitCode: number | null): string | null {
  switch (exitCode) {
    case 137:
      return "exit 137 / SIGKILL - possible OOM";
    case 139:
      return "exit 139 / SIGSEGV - segmentation fault";
    case 134:
      return "exit 134 / SIGABRT - process aborted";
    case 0xc0000005:
    case -1073741819:
      return "exit 0xC0000005 / STATUS_ACCESS_VIOLATION";
    case 0xc00000fd:
    case -1073741571:
      return "exit 0xC00000FD / STATUS_STACK_OVERFLOW";
    case 0xc0000409:
    case -1073740791:
      return "exit 0xC0000409 / STATUS_STACK_BUFFER_OVERRUN";
    default:
      return null;
  }
}

export function formatExitFailureLabel(
  exitCode: number | null,
  signal?: NodeJS.Signals | null,
): string {
  if (signal) {
    switch (signal) {
      case "SIGKILL":
        return "SIGKILL - possible OOM";
      case "SIGSEGV":
        return "SIGSEGV - segmentation fault";
      case "SIGABRT":
        return "SIGABRT - process aborted";
      case "SIGTERM":
        return "SIGTERM";
      default:
        return String(signal);
    }
  }
  const fatalExit = describeFatalExitCode(exitCode);
  if (fatalExit) return fatalExit;
  return `exit ${exitCode ?? "err"}`;
}

export interface FormatCompactCommandOutputParams {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
  maxChars: number;
}

export interface CompactCommandOutputMeta {
  text: string;
  collapsedLines: number;
  truncated: boolean;
  rawLines: number;
  rawChars: number;
}

export interface PreparedCompactCommandOutput {
  kind: "error" | "timeout" | "pass-empty" | "pass-summary" | "fail-empty" | "fail-lines";
  bodyText: string;
  foldedLines?: string[];
  collapsedLines: number;
  rawLines: number;
  rawChars: number;
}

export function prepareCompactCommandOutput(
  params: Omit<FormatCompactCommandOutputParams, "maxChars">,
): PreparedCompactCommandOutput {
  const out = normalizeTerminalOutput(params.stdout);
  const err = normalizeTerminalOutput(params.stderr);
  const combined = [out, err].filter(Boolean).join("\n");
  const rawChars = combined.length;
  const rawLines = combined ? combined.split("\n").length : 0;

  if (params.error) {
    return {
      kind: "error",
      bodyText: `spawn error: ${params.error}`,
      collapsedLines: 0,
      rawLines,
      rawChars,
    };
  }

  if (params.timedOut) {
    const tail = getTailLines(combined, 20);
    return {
      kind: "timeout",
      bodyText: tail ? `TIMED OUT\n${tail}` : "TIMED OUT (no output)",
      collapsedLines: 0,
      rawLines,
      rawChars,
    };
  }

  if (params.exitCode === 0) {
    if (!combined) {
      return {
        kind: "pass-empty",
        bodyText: "OK",
        collapsedLines: 0,
        rawLines: 0,
        rawChars: 0,
      };
    }
    const lines = combined
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const summaryLines = lines.filter((l) => SUMMARY_LINE_PATTERN.test(l));
    const picked =
      summaryLines.length > 0
        ? summaryLines.slice(-2)
        : lines.length <= 2
          ? lines
          : [lines[lines.length - 1]!];
    return {
      kind: "pass-summary",
      bodyText: picked.join(" | "),
      collapsedLines: 0,
      rawLines,
      rawChars,
    };
  }

  if (!combined) {
    const fatalExitLabel = params.signal ? null : describeFatalExitCode(params.exitCode);
    const bodyText = params.signal
      ? `Terminated by ${formatExitFailureLabel(params.exitCode, params.signal)}`
      : fatalExitLabel
        ? `Terminated (${fatalExitLabel})`
        : `Exited with code ${params.exitCode ?? "unknown"}`;
    return {
      kind: "fail-empty",
      bodyText,
      collapsedLines: 0,
      rawLines: 0,
      rawChars: 0,
    };
  }

  const splitLines = combined.split("\n");
  const filteredLines = splitLines.filter((line) => !isFailureNoiseLine(line));
  const cleanedLines = filteredLines.length > 0 ? filteredLines : splitLines;

  const { lines: foldedLines, collapsedLines } = foldGreenBuildPhaseLines(cleanedLines);
  return {
    kind: "fail-lines",
    bodyText: foldedLines.join("\n"),
    foldedLines,
    collapsedLines,
    rawLines,
    rawChars,
  };
}

export function renderPreparedCompactCommandOutput(
  prepared: PreparedCompactCommandOutput,
  maxChars: number,
): CompactCommandOutputMeta {
  if (prepared.kind === "error" || prepared.kind === "fail-empty") {
    const text = truncateWithNotice(prepared.bodyText, maxChars);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== prepared.bodyText,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars,
    };
  }

  if (prepared.kind === "timeout") {
    const text = truncateHeadTailWithNotice(prepared.bodyText, maxChars);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== prepared.bodyText || prepared.rawLines > 20,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars,
    };
  }

  if (prepared.kind === "pass-empty") {
    const text = truncateWithNotice(prepared.bodyText, maxChars);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== prepared.bodyText,
      rawLines: 0,
      rawChars: 0,
    };
  }

  if (prepared.kind === "pass-summary") {
    const cap = Math.min(maxChars, 320);
    const text = truncateWithNotice(prepared.bodyText, cap);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== prepared.bodyText,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars,
    };
  }

  if (prepared.bodyText.length <= maxChars) {
    return {
      text: prepared.bodyText,
      collapsedLines: prepared.collapsedLines,
      truncated: false,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars,
    };
  }

  const text = compactLongFailureLines(prepared.foldedLines ?? [], maxChars);
  return {
    text,
    collapsedLines: prepared.collapsedLines,
    truncated: true,
    rawLines: prepared.rawLines,
    rawChars: prepared.rawChars,
  };
}

export function formatCompactCommandOutputWithMeta(
  params: FormatCompactCommandOutputParams,
): CompactCommandOutputMeta {
  return renderPreparedCompactCommandOutput(
    prepareCompactCommandOutput(params),
    params.maxChars,
  );
}

export function formatCompactCommandOutput(
  params: FormatCompactCommandOutputParams,
): string {
  return formatCompactCommandOutputWithMeta(params).text;
}

function getTailLines(text: string, count: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
}
