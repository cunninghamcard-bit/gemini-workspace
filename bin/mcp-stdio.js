#!/usr/bin/env node
// In stdio mode stdout carries the JSON-RPC stream, so non-protocol output has
// to be silenced before any module is evaluated. The import below is dynamic
// on purpose: a static import would hoist above these assignments.
const toStderr = (...args) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const { runEntrypoint } = await import("./run-entrypoint.js");

await runEntrypoint("../src/stdio.ts", "../dist/stdio.js");
