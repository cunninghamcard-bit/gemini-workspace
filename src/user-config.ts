import type { WireInput } from "./json-value.js";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import * as z from "zod/v4";
import {
  defaultGeminiWorkspaceConfig,
  geminiWorkspaceConfigSchema,
  type GeminiWorkspaceConfig,
  type GeminiWorkspaceConfigInput,
} from "./config-schema.js";
import { expandHomePath } from "./path-utils.js";

const geminiWorkspaceAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
}).passthrough();

export type GeminiWorkspaceUserConfig = GeminiWorkspaceConfig;
export type GeminiWorkspaceAuthConfig = z.infer<typeof geminiWorkspaceAuthConfigSchema>;

export interface GeminiWorkspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: GeminiWorkspaceConfig;
  auth: GeminiWorkspaceAuthConfig;
}

export interface GeminiWorkspaceConfigEdit {
  path: (string | number)[];
  value: unknown;
}

export function geminiWorkspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.GEMINI_WORKSPACE_CONFIG_DIR ?? join(homedir(), ".gemini-workspace")));
}

export function geminiWorkspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(geminiWorkspaceConfigDir(env), "config.jsonc");
}

export function geminiWorkspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(geminiWorkspaceConfigDir(env), "auth.json");
}

export function loadGeminiWorkspaceFiles(env: NodeJS.ProcessEnv = process.env): GeminiWorkspaceFiles {
  const dir = geminiWorkspaceConfigDir(env);
  const configPath = geminiWorkspaceConfigPath(env);
  const authPath = geminiWorkspaceAuthPath(env);

  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsoncConfig(configPath) : defaultGeminiWorkspaceConfig(),
    auth: authExists ? readJsonFile(authPath, geminiWorkspaceAuthConfigSchema) : {},
  };
}

export function writeGeminiWorkspaceConfig(
  config: GeminiWorkspaceConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = geminiWorkspaceConfigPath(env);
  const parsed = geminiWorkspaceConfigSchema.parse(config);
  atomicWrite(filePath, serializeConfig(parsed), 0o600);
  return filePath;
}

export function setGeminiWorkspaceConfigValue(
  path: (string | number)[],
  value: WireInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return setGeminiWorkspaceConfigValues([{ path, value }], env);
}

export function setGeminiWorkspaceConfigValues(
  edits: GeminiWorkspaceConfigEdit[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const files = loadGeminiWorkspaceFiles(env);
  const source = files.configExists
    ? readFileSync(files.configPath, "utf8")
    : serializeConfig(files.config);

  const updated = edits.reduce(
    (document, edit) => applyEdits(document, modify(document, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })),
    source,
  );

  parseJsoncConfig(updated, files.configPath);
  atomicWrite(files.configPath, updated.endsWith("\n") ? updated : `${updated}\n`, 0o600);
  return files.configPath;
}

export function writeGeminiWorkspaceAuth(
  auth: GeminiWorkspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = geminiWorkspaceAuthPath(env);
  mkdirSync(geminiWorkspaceConfigDir(env), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(geminiWorkspaceAuthConfigSchema.parse(auth), null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsoncConfig(filePath: string): GeminiWorkspaceConfig {
  try {
    return parseJsoncConfig(readFileSync(filePath, "utf8"), filePath);
  } catch (error) {
    if (error instanceof GeminiWorkspaceConfigFileError) throw error;
    throw fileError("read", filePath, error);
  }
}

function parseJsoncConfig(source: string, filePath: string): GeminiWorkspaceConfig {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const first = errors[0]!;
    throw new GeminiWorkspaceConfigFileError(
      `Unable to read ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }

  try {
    return geminiWorkspaceConfigSchema.parse(value);
  } catch (error) {
    throw fileError("read", filePath, error);
  }
}

function serializeConfig(config: GeminiWorkspaceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function atomicWrite(filePath: string, source: string, mode: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );

  try {
    writeFileSync(temporaryPath, source, { mode, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    throw fileError("read", filePath, error);
  }
}

function fileError(action: "read", filePath: string, error: WireInput): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new GeminiWorkspaceConfigFileError(`Unable to ${action} ${filePath}: ${reason}`);
}

class GeminiWorkspaceConfigFileError extends Error {}
