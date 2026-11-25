import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expandHomePath } from "./path-utils.js";

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string;
}

export interface SkillsDiscoveryConfig {
  enabled: boolean;
  paths: string[];
}

const MAX_DESCRIPTION_CHARS = 160;
const MAX_SKILLS_PROMPT_CHARS = 4_500;

export function discoverLocalSkills(config: SkillsDiscoveryConfig): DiscoveredSkill[] {
  if (!config.enabled) return [];

  const home = homedir();
  const candidates = [
    ...config.paths.map((p) => resolve(expandHomePath(p))),
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".gemini-workspace", "skills"),
  ];

  const visitedDirs = new Set<string>();
  const skillsByName = new Map<string, DiscoveredSkill>();

  for (const root of candidates) {
    if (!existsSync(root) || visitedDirs.has(root)) continue;
    visitedDirs.add(root);

    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const skillDir = join(root, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      try {
        const parsed = parseSkillMarkdown(readFileSync(skillFile, "utf8"), basename(skillDir), skillFile);
        if (!skillsByName.has(parsed.name)) {
          skillsByName.set(parsed.name, parsed);
        }
      } catch {
        // Ignore malformed SKILL.md files so startup never fails.
      }
    }
  }

  return [...skillsByName.values()];
}

export function formatSkillsForInstructions(skills: readonly DiscoveredSkill[]): string {
  if (skills.length === 0) return "";

  const lines: string[] = [
    "Available local skills on this Mac (when a task matches a skill, read its SKILL.md with read_file first):",
  ];
  let totalChars = lines[0]!.length;

  for (const skill of skills) {
    const desc = skill.description.length > MAX_DESCRIPTION_CHARS
      ? `${skill.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
      : skill.description;
    const line = desc
      ? `- ${skill.name} (${skill.path}): ${desc}`
      : `- ${skill.name} (${skill.path})`;
    if (totalChars + line.length + 1 > MAX_SKILLS_PROMPT_CHARS) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  return lines.join("\n");
}

function parseSkillMarkdown(raw: string, fallbackName: string, skillPath: string): DiscoveredSkill {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { name: fallbackName, description: firstParagraph(normalized), path: skillPath };
  }

  const endIdx = normalized.indexOf("\n---\n", 4);
  if (endIdx < 0) {
    return { name: fallbackName, description: firstParagraph(normalized), path: skillPath };
  }

  const frontmatter = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5);
  let name = fallbackName;
  let description = "";

  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();

    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const blockLines: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) {
        i += 1;
        blockLines.push(lines[i]!.trim());
      }
      value = blockLines.join(" ");
    } else {
      value = stripQuotes(value);
    }

    if (key === "name" && value) name = value;
    if (key === "description" && value) description = value;
  }

  if (!description) {
    description = firstParagraph(body);
  }

  return {
    name,
    description: description.replace(/\s+/g, " ").trim(),
    path: skillPath,
  };
}

function stripQuotes(s: string): string {
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function firstParagraph(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return "";
}
