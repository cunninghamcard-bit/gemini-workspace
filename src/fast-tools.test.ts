import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { callFastTool, fastToolDefinitions, isFastTool } from "./fast-tools.js";

const dir = mkdtempSync(path.join(tmpdir(), "fast-tools-"));
writeFileSync(path.join(dir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
after(() => rmSync(dir, { recursive: true, force: true }));

const text = (r: Awaited<ReturnType<typeof callFastTool>>) =>
  r.content.map((c) => ("text" in c ? c.text : "")).join("");

test("exposes all five agy-fast tools with Gemini-safe schemas", () => {
  const defs = fastToolDefinitions();
  assert.deepEqual(defs.map((d) => d.name).sort(), [
    "apply_edits", "batch_search", "quick_outline", "read_slices", "run_checks",
  ]);
  const json = JSON.stringify(defs);
  for (const banned of ["$schema", "additionalProperties", "$defs", "\"const\""]) {
    assert.ok(!json.includes(banned), `schema contains ${banned}`);
  }
  for (const d of defs) {
    assert.ok(isFastTool(d.name));
    assert.ok((d.inputSchema.required as string[]).includes("cwd"), `${d.name} requires cwd`);
  }
});

test("timeouts are capped under Gemini Web's 60s RPC deadline", () => {
  const runChecks = fastToolDefinitions().find((d) => d.name === "run_checks")!;
  const props = runChecks.inputSchema.properties as Record<string, { maximum?: number }>;
  assert.equal(props.timeoutSec?.maximum, 45);
});

test("rejects relative or missing cwd", async () => {
  const res = await callFastTool("batch_search", { cwd: "src", queries: [{ type: "text", pattern: "x" }] });
  assert.equal(res.isError, true);
  assert.match(text(res), /absolute/);
  assert.equal((await callFastTool("quick_outline", { paths: ["a.ts"] })).isError, true);
});

test("batch_search, quick_outline, apply_edits and run_checks run against a real directory", async () => {
  const search = await callFastTool("batch_search", { cwd: dir, queries: [{ type: "text", pattern: "alpha" }] });
  assert.ok(!search.isError, text(search));
  assert.match(text(search), /a\.ts/);

  const outline = await callFastTool("quick_outline", { cwd: dir, paths: ["a.ts"] });
  assert.ok(!outline.isError, text(outline));
  assert.match(text(outline), /alpha/);

  const edit = await callFastTool("apply_edits", {
    cwd: dir,
    edits: [{ path: "a.ts", hunks: [{ target: "return 1;", replacement: "return 2;" }] }],
  });
  assert.ok(!edit.isError, text(edit));
  assert.match(readFileSync(path.join(dir, "a.ts"), "utf8"), /return 2;/);

  const checks = await callFastTool("run_checks", {
    cwd: dir,
    commands: [{ command: "echo ok" }, { command: "exit 3", name: "bad" }],
  });
  // A failing check is reported in the text, not as a tool-call error.
  assert.ok(!checks.isError, text(checks));
  assert.match(text(checks), /bad/);
  assert.match(text(checks), /exit(?: code)?:? ?3|code 3|\b3\b/i);
});
