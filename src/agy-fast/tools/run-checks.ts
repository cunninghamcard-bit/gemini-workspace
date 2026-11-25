import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import { MCP_CALL_BUDGET_SEC, runShellCommandAsync, type ExecResult } from "../utils/exec-utils.js";
import { resolvePath } from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  computeWaterFillBudgets,
  fitSectionsToByteBudget,
  formatCompactCommandOutput,
  formatExitFailureLabel,
  normalizeTerminalOutput,
  prepareCompactCommandOutput,
  renderPreparedCompactCommandOutput,
  sliceSafeChars,
  sliceUtf8Bytes,
  truncateHeadTailWithByteNotice,
  truncateHeadTailWithNotice,
  truncateWithByteNotice,
  truncateWithNotice,
  type PreparedCompactCommandOutput,
} from "../utils/output-filter.js";

export interface CheckCommandSpec {
  name?: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface RunChecksInput {
  cwd?: string;
  commands: Array<string | CheckCommandSpec>;
  concurrency?: number;
  timeoutSec?: number;
  outputMode?: "compact" | "full";
  maxChars?: number;
}

interface NormalizedCommand {
  index: number;
  name: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}

interface CheckRunOutcome {
  spec: NormalizedCommand;
  /** null when the call budget ran out before the command could start. */
  result: ExecResult | null;
  passed: boolean;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function runChecks(
  input: RunChecksInput,
  budgetMs = MCP_CALL_BUDGET_SEC * 1000,
): Promise<{ text: string; isError: boolean }> {
  const parsedCommands = parseMaybeJsonArray(input?.commands);
  if (!parsedCommands.ok) {
    if (
      parsedCommands.kind === "corrupted_literal" ||
      (parsedCommands.kind === "wrong_type" &&
        (typeof input?.commands === "boolean" || input?.commands === null))
    ) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "run_checks",
          items: [
            {
              label: "commands",
              value:
                parsedCommands.kind === "corrupted_literal" ? parsedCommands.value : input.commands,
              expected: "an array of command specs",
            },
          ],
          fallbackAdvice: "immediately fall back to a single compound run_command call.",
        }),
        isError: true,
      };
    }
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true,
    };
  }
  const rawCommands = parsedCommands.value;
  if (rawCommands.length === 0) {
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true,
    };
  }
  if (rawCommands.length > 12) {
    return {
      text: "Error: 'commands' supports at most 12 commands per call.",
      isError: true,
    };
  }

  const corruptedCommands: CorruptedItem[] = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    if (typeof raw !== "string" && !isPlainObject(raw)) {
      corruptedCommands.push({
        label: `commands[${i}]`,
        value: raw,
        expected: "a command string or object ({ name?, command, cwd?, timeoutSec? })",
      });
    }
  }
  if (corruptedCommands.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "run_checks",
        items: corruptedCommands,
        fallbackAdvice: "immediately fall back to a single compound run_command call.",
      }),
      isError: true,
    };
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }

  const concurrency = clampInt(input.concurrency, 1, 8, 4);
  const defaultTimeoutSec = clampInt(input.timeoutSec, 1, MCP_CALL_BUDGET_SEC, 60);
  const outputMode = input.outputMode === "full" ? "full" : "compact";
  const maxChars = clampInt(input.maxChars, 500, DEFAULT_INLINE_MAX_BYTES, 8_000);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;

  const normalized: NormalizedCommand[] = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    const spec: CheckCommandSpec =
      typeof raw === "string" ? { command: raw } : (raw as unknown as CheckCommandSpec);
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      return {
        text: `Error: commands[${i}] must contain a non-empty 'command' string.`,
        isError: true,
      };
    }
    if (spec.cwd !== undefined && spec.cwd !== null && typeof spec.cwd !== "string") {
      return {
        text: `Error: commands[${i}].cwd must be a string path.`,
        isError: true,
      };
    }
    const trimmedSpecCwd = spec.cwd?.trim() || "";
    const cmdCwd = trimmedSpecCwd ? resolvePath(trimmedSpecCwd, baseCwd) : baseCwd;
    if (trimmedSpecCwd) {
      try {
        const st = await fs.stat(cmdCwd);
        if (!st.isDirectory()) {
          return {
            text: `Error: commands[${i}].cwd is not a directory: ${cmdCwd}`,
            isError: true,
          };
        }
      } catch {
        return {
          text: `Error: commands[${i}].cwd does not exist: ${cmdCwd}`,
          isError: true,
        };
      }
    }
    const cmdTimeoutSec = clampInt(
      spec.timeoutSec,
      1,
      MCP_CALL_BUDGET_SEC,
      defaultTimeoutSec,
    );
    normalized.push({
      index: i,
      name: spec.name?.trim() || `check-${i + 1}`,
      command: spec.command.trim(),
      cwd: cmdCwd,
      timeoutMs: cmdTimeoutSec * 1000,
    });
  }

  const safeBudgetMs =
    Number.isFinite(budgetMs) && budgetMs > 0
      ? Math.max(100, Math.trunc(budgetMs))
      : MCP_CALL_BUDGET_SEC * 1000;
  const wallStart = performance.now();
  const deadline = wallStart + safeBudgetMs;
  const outcomes = await mapWithConcurrency<NormalizedCommand, CheckRunOutcome>(
    normalized,
    concurrency,
    async (spec) => {
      const remainingMs = deadline - performance.now();
      // exec-utils clamps timeouts to >=100ms plus kill grace; avoid starting doomed commands
      if (remainingMs < 100) return { spec, result: null, passed: false };
      const result = await runShellCommandAsync(spec.command, {
        cwd: spec.cwd,
        timeoutMs: Math.min(spec.timeoutMs, remainingMs),
      });
      const passed = !result.error && !result.timedOut && result.exitCode === 0;
      return { spec, result, passed };
    },
  );
  const wallMs = Math.round(performance.now() - wallStart);

  const passedCount = outcomes.filter((o) => o.passed).length;
  const notRunCount = outcomes.filter((o) => !o.result).length;
  const failedCount = outcomes.length - passedCount - notRunCount;

  const counts = [`${passedCount}/${outcomes.length} passed`];
  if (failedCount > 0) counts.push(`${failedCount} failed`);
  if (notRunCount > 0) {
    counts.push(
      `${notRunCount} not run (call time budget of ${Math.round(safeBudgetMs / 1000)}s used up; run them in another call)`,
    );
  }
  const summaryHeader = `Checks: ${counts.join(", ")} (wall: ${wallMs}ms)`;

  const separator = "\n\n";
  const bodyBudget = Math.max(0, maxChars - summaryHeader.length - separator.length);
  const bodyByteBudget =
    maxBytes !== undefined
      ? Math.max(
          0,
          maxBytes -
            Buffer.byteLength(summaryHeader, "utf8") -
            Buffer.byteLength(separator, "utf8"),
        )
      : bodyBudget;
  const totalSepChars = separator.length * Math.max(0, outcomes.length - 1);
  const totalSepBytes =
    Buffer.byteLength(separator, "utf8") * Math.max(0, outcomes.length - 1);
  const availChars = Math.max(0, bodyBudget - totalSepChars);
  const availBytes = Math.max(0, bodyByteBudget - totalSepBytes);

  const capCmdDisplay = (cmd: string, maxCmdChars: number, maxCmdBytes: number): string => {
    if (cmd.length <= maxCmdChars && Buffer.byteLength(cmd, "utf8") <= maxCmdBytes) {
      return cmd;
    }
    const charCap = Math.max(8, maxCmdChars - 3);
    const byteCap = Math.max(8, maxCmdBytes - 3);
    return `${sliceUtf8Bytes(sliceSafeChars(cmd, charCap), byteCap)}...`;
  };

  const formatNotRunBlock = (spec: NormalizedCommand): string => {
    const baseHeader = `## [NOT RUN] ${spec.name}`;
    const notRunBudgetTotal =
      failedCount > 0
        ? Math.min(availChars, Math.floor(availChars * 0.35))
        : availChars;
    const perNotRunShare = Math.floor(
      notRunBudgetTotal / Math.max(1, notRunCount),
    );
    const cmdRoom = perNotRunShare - baseHeader.length - 3; // "\n$ "
    if (cmdRoom < 16) {
      return baseHeader.length <= perNotRunShare || perNotRunShare < 16
        ? baseHeader
        : `${sliceSafeChars(baseHeader, perNotRunShare - 3)}...`;
    }
    const perNotRunCap = Math.min(180, cmdRoom);
    const shortCmd = capCmdDisplay(spec.command, perNotRunCap, perNotRunCap);
    return `${baseHeader}\n$ ${shortCmd}`;
  };

  const formatCmdHeaderPrefix = (
    headerLine: string,
    cmd: string,
    blockCharShare: number,
    blockByteShare: number,
  ): string => {
    const fullPrefix = `${headerLine}\n$ ${cmd}\n`;
    const headerLineBytes = Buffer.byteLength(headerLine, "utf8");
    const fullPrefixBytes = Buffer.byteLength(fullPrefix, "utf8");
    const maxPrefixChars = Math.max(
      headerLine.length + 24,
      Math.floor(blockCharShare * 0.35),
    );
    const maxPrefixBytes = Math.max(
      headerLineBytes + 24,
      Math.floor(blockByteShare * 0.35),
    );
    if (fullPrefix.length <= maxPrefixChars && fullPrefixBytes <= maxPrefixBytes) {
      return fullPrefix;
    }
    const remChars = blockCharShare - headerLine.length - 1;
    const remBytes = blockByteShare - headerLineBytes - 1;
    if (remChars < 48 || remBytes < 48) {
      return `${headerLine}\n`;
    }
    const maxCmdChars = Math.max(20, maxPrefixChars - headerLine.length - 4);
    const maxCmdBytes = Math.max(20, maxPrefixBytes - headerLineBytes - 4);
    const displayCmd = capCmdDisplay(cmd, maxCmdChars, maxCmdBytes);
    return `${headerLine}\n$ ${displayCmd}\n`;
  };

  let blocks: string[];
  if (outputMode === "full") {
    // True water-filling in full mode (short/empty commands donate 100% of unused budget
    // to rich commands) combined with single-pass Head-Tail folding + header capping.
    const rawEntries = outcomes.map(({ spec, result, passed }) => {
      if (!result) {
        const block = formatNotRunBlock(spec);
        return {
          notRun: true as const,
          block,
          charSize: block.length,
          byteSize: Buffer.byteLength(block, "utf8"),
        };
      }
      const badge = result.error
        ? "ERROR"
        : result.timedOut
          ? "TIMEOUT"
          : passed
            ? "PASS"
            : `FAIL (${formatExitFailureLabel(result.exitCode, result.signal)})`;
      const headerLine = `## [${badge}] ${spec.name} (${result.durationMs}ms)`;
      const fullPrefix = `${headerLine}\n$ ${spec.command}\n`;
      const combined = [
        normalizeTerminalOutput(result.stdout),
        normalizeTerminalOutput(result.stderr),
      ]
        .filter(Boolean)
        .join("\n");
      const rawBody = result.error
        ? `spawn error: ${result.error}`
        : combined || "(no output)";
      const fullBlock = `${fullPrefix}${rawBody}`;
      return {
        notRun: false as const,
        spec,
        headerLine,
        fullPrefix,
        rawBody,
        fullBlock,
        charSize: fullBlock.length,
        byteSize: Buffer.byteLength(fullBlock, "utf8"),
      };
    });

    const fullCharBudgets = computeWaterFillBudgets(
      rawEntries.map((e) => e.charSize),
      availChars,
    );
    const fullByteBudgets = computeWaterFillBudgets(
      rawEntries.map((e) => e.byteSize),
      availBytes,
    );

    blocks = rawEntries.map((entry, idx) => {
      if (entry.notRun) return entry.block;
      const charShare = fullCharBudgets[idx] ?? 0;
      const byteShare = fullByteBudgets[idx] ?? 0;
      if (entry.charSize <= charShare && entry.byteSize <= byteShare) {
        return entry.fullBlock;
      }
      const prefix = formatCmdHeaderPrefix(
        entry.headerLine,
        entry.spec.command,
        charShare,
        byteShare,
      );
      const allowedChars = Math.max(0, charShare - prefix.length);
      const allowedBytes = Math.max(
        0,
        byteShare - Buffer.byteLength(prefix, "utf8"),
      );
      let body = entry.rawBody;
      if (Buffer.byteLength(body, "utf8") > allowedBytes) {
        body = truncateHeadTailWithByteNotice(body, allowedBytes);
      }
      if (body.length > allowedChars) {
        body = truncateHeadTailWithNotice(body, allowedChars);
      }
      return `${prefix}${body}`;
    });
  } else {
    // Tiered budget pool + 2-pass water-filling (zero redundant ANSI/folding passes):
    // Fixed tier: PASS (concise 1-line summary <= 300 chars; yields budget if starving FAIL) + capped [NOT RUN]
    // Elastic tier: FAIL / ERROR / TIMEOUT commands water-fill the remaining char & UTF-8 byte budget
    blocks = new Array<string>(outcomes.length);
    interface PassEntry {
      index: number;
      compactHeader: string;
      body: string;
      fullBlock: string;
    }
    interface FailEntry {
      index: number;
      spec: NormalizedCommand;
      badgeLine: string;
      header: string;
      prepared: PreparedCompactCommandOutput;
      pass1Body: string;
      pass1Block: string;
    }
    const passEntries: PassEntry[] = [];
    const failEntries: FailEntry[] = [];
    let notRunChars = 0;
    let notRunBytes = 0;
    let passChars = 0;
    let passBytes = 0;

    for (let i = 0; i < outcomes.length; i++) {
      const { spec, result, passed } = outcomes[i]!;
      if (!result) {
        const block = formatNotRunBlock(spec);
        blocks[i] = block;
        notRunChars += block.length;
        notRunBytes += Buffer.byteLength(block, "utf8");
        continue;
      }

      if (passed) {
        const body = formatCompactCommandOutput({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          error: result.error,
          maxChars: 300,
        });
        const compactHeader = `- [PASS ${result.durationMs}ms] ${spec.name}`;
        const fullBlock = `${compactHeader} (\`${spec.command}\`): ${body}`;
        blocks[i] = fullBlock;
        passChars += fullBlock.length;
        passBytes += Buffer.byteLength(fullBlock, "utf8");
        passEntries.push({ index: i, compactHeader, body, fullBlock });
        continue;
      }

      const badge = result.error
        ? "ERROR"
        : result.timedOut
          ? "TIMEOUT"
          : `FAIL (${formatExitFailureLabel(result.exitCode, result.signal)})`;
      const badgeLine = `## [${badge} ${result.durationMs}ms] ${spec.name}`;
      const header = `${badgeLine}\n$ ${spec.command}\n`;

      // Prepare & fold ONCE per failing command to measure true folded size
      const prepared = prepareCompactCommandOutput({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        error: result.error,
      });
      const pass1Ceiling = Math.max(
        bodyBudget,
        prepared.bodyText.length + 256,
      );
      const pass1Body = renderPreparedCompactCommandOutput(
        prepared,
        pass1Ceiling,
      ).text;
      failEntries.push({
        index: i,
        spec,
        badgeLine,
        header,
        prepared,
        pass1Body,
        pass1Block: `${header}${pass1Body}`,
      });
    }

    if (failEntries.length > 0) {
      const availAfterNotRunChars = Math.max(0, availChars - notRunChars);
      const availAfterNotRunBytes = Math.max(0, availBytes - notRunBytes);

      const rawFailPoolChars = Math.max(0, availAfterNotRunChars - passChars);
      const rawFailPoolBytes = Math.max(0, availAfterNotRunBytes - passBytes);

      // When verbose PASS summaries would starve FAIL output, shrink PASS summaries first
      // so FAIL blocks ALWAYS keep up to 60% of available pool (never starved by long PASS names).
      if (passEntries.length > 0) {
        const totalFailDemandChars = failEntries.reduce(
          (sum, f) => sum + f.pass1Block.length,
          0,
        );
        const totalFailDemandBytes = failEntries.reduce(
          (sum, f) => sum + Buffer.byteLength(f.pass1Block, "utf8"),
          0,
        );
        const maxFailCeilingChars = Math.floor(availAfterNotRunChars * 0.85);
        const maxFailCeilingBytes = Math.floor(availAfterNotRunBytes * 0.85);
        const failFloorChars = Math.min(
          maxFailCeilingChars,
          Math.max(
            failEntries.reduce(
              (sum, f) =>
                sum + Math.min(f.header.length, 120) + Math.min(f.pass1Body.length, 160),
              0,
            ),
            Math.floor(availAfterNotRunChars * 0.6),
          ),
        );
        const failFloorBytes = Math.min(
          maxFailCeilingBytes,
          Math.max(
            failEntries.reduce(
              (sum, f) =>
                sum +
                Math.min(Buffer.byteLength(f.header, "utf8"), 120) +
                Math.min(Buffer.byteLength(f.pass1Body, "utf8"), 160),
              0,
            ),
            Math.floor(availAfterNotRunBytes * 0.6),
          ),
        );
        const desiredFailChars = Math.min(totalFailDemandChars, failFloorChars);
        const desiredFailBytes = Math.min(totalFailDemandBytes, failFloorBytes);

        if (rawFailPoolChars < desiredFailChars || rawFailPoolBytes < desiredFailBytes) {
          const passPoolChars = Math.max(
            0,
            availAfterNotRunChars - Math.max(rawFailPoolChars, desiredFailChars),
          );
          const passPoolBytes = Math.max(
            0,
            availAfterNotRunBytes - Math.max(rawFailPoolBytes, desiredFailBytes),
          );
          const passCharShares = computeWaterFillBudgets(
            passEntries.map((p) => p.fullBlock.length),
            passPoolChars,
          );
          const passByteShares = computeWaterFillBudgets(
            passEntries.map((p) => Buffer.byteLength(p.fullBlock, "utf8")),
            passPoolBytes,
          );

          passChars = 0;
          passBytes = 0;
          for (let pIdx = 0; pIdx < passEntries.length; pIdx++) {
            const p = passEntries[pIdx]!;
            const shareChars = passCharShares[pIdx] ?? 0;
            const shareBytes = passByteShares[pIdx] ?? 0;
            let shrunk = p.fullBlock;
            if (
              shrunk.length > shareChars ||
              Buffer.byteLength(shrunk, "utf8") > shareBytes
            ) {
              const noCmd = `${p.compactHeader}: ${p.body}`;
              if (
                noCmd.length <= shareChars &&
                Buffer.byteLength(noCmd, "utf8") <= shareBytes
              ) {
                shrunk = noCmd;
              } else {
                const hdrBytes = Buffer.byteLength(p.compactHeader, "utf8");
                const bodyCharsAvail = shareChars - p.compactHeader.length - 2;
                const bodyBytesAvail = shareBytes - hdrBytes - 2;
                if (bodyCharsAvail >= 8 && bodyBytesAvail >= 8) {
                  const trimmedBody = sliceUtf8Bytes(
                    sliceSafeChars(p.body, bodyCharsAvail - 3),
                    bodyBytesAvail - 3,
                  );
                  shrunk = `${p.compactHeader}: ${trimmedBody}...`;
                } else if (
                  p.compactHeader.length <= shareChars &&
                  hdrBytes <= shareBytes
                ) {
                  shrunk = p.compactHeader;
                } else {
                  shrunk = sliceUtf8Bytes(
                    sliceSafeChars(p.compactHeader, shareChars),
                    shareBytes,
                  );
                }
              }
            }
            blocks[p.index] = shrunk;
            passChars += shrunk.length;
            passBytes += Buffer.byteLength(shrunk, "utf8");
          }
        }
      }

      const failPoolChars = Math.max(0, availAfterNotRunChars - passChars);
      const failPoolBytes = Math.max(0, availAfterNotRunBytes - passBytes);

      const charBlockBudgets = computeWaterFillBudgets(
        failEntries.map((entry) => entry.pass1Block.length),
        failPoolChars,
      );
      const byteBlockBudgets = computeWaterFillBudgets(
        failEntries.map((entry) => Buffer.byteLength(entry.pass1Block, "utf8")),
        failPoolBytes,
      );

      for (let j = 0; j < failEntries.length; j++) {
        const entry = failEntries[j]!;
        const blockCharBudget = charBlockBudgets[j] ?? 0;
        const blockByteBudget = byteBlockBudgets[j] ?? 0;
        const pass1BodyBytes = Buffer.byteLength(entry.pass1Body, "utf8");

        const effectiveHeader = formatCmdHeaderPrefix(
          entry.badgeLine,
          entry.spec.command,
          blockCharBudget,
          blockByteBudget,
        );
        const headerChars = effectiveHeader.length;
        const headerBytes = Buffer.byteLength(effectiveHeader, "utf8");
        const allowedBodyChars = Math.max(0, blockCharBudget - headerChars);
        const allowedBodyBytes = Math.max(0, blockByteBudget - headerBytes);

        if (
          entry.pass1Body.length <= allowedBodyChars &&
          pass1BodyBytes <= allowedBodyBytes
        ) {
          blocks[entry.index] = `${effectiveHeader}${entry.pass1Body}`;
          continue;
        }

        const bytesPerChar = pass1BodyBytes / Math.max(1, entry.pass1Body.length);
        let targetChars = Math.min(
          allowedBodyChars,
          Math.floor(allowedBodyBytes / Math.max(1, bytesPerChar)),
        );
        let compactedBody =
          targetChars > 0
            ? renderPreparedCompactCommandOutput(entry.prepared, targetChars).text
            : "";

        // Converge char cap using actual compactedBody.length so dense CJK tails
        // converge in 1-2 iterations instead of stalling on diluted average density.
        for (let iter = 0; iter < 4 && targetChars > 1; iter++) {
          const curBytes = Buffer.byteLength(compactedBody, "utf8");
          if (curBytes <= allowedBodyBytes) break;
          const basisChars = Math.min(targetChars, compactedBody.length);
          if (basisChars <= 1) {
            targetChars = 1;
            compactedBody = renderPreparedCompactCommandOutput(entry.prepared, 1).text;
            break;
          }
          targetChars = Math.max(
            1,
            Math.min(
              basisChars - 1,
              Math.floor(basisChars * (allowedBodyBytes / curBytes) * 0.98),
            ),
          );
          compactedBody = renderPreparedCompactCommandOutput(
            entry.prepared,
            targetChars,
          ).text;
        }

        blocks[entry.index] = `${effectiveHeader}${compactedBody}`;
      }
    }
  }

  const nonEmptyBlocks = blocks.filter((b) => b.length > 0);
  const fittedBlocks = fitSectionsToByteBudget(
    nonEmptyBlocks,
    bodyBudget,
    bodyByteBudget,
    separator,
    "head-tail",
  );
  let text = truncateWithNotice(
    `${summaryHeader}${separator}${fittedBlocks}`,
    maxChars,
  );
  if (maxBytes !== undefined) {
    text = truncateWithByteNotice(text, maxBytes);
  }
  return { text, isError: false };
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== "number" && typeof val !== "string") return fallback;
  if (typeof val === "string" && val.trim() === "") return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}
