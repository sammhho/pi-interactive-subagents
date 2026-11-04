import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLaunchArtifacts, entries } from "./integration/session-replacement-utils.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "replacement-utils-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("session replacement test helpers", () => {
  it("retries a partially written final record while preserving completed records", () => withTempDir((dir) => {
    const path = join(dir, "session.jsonl");
    const first = { type: "first" };
    const second = { type: "second" };
    assert.deepEqual(entries(path), []);
    writeFileSync(path, `${JSON.stringify(first)}\n{"type":"sec`);
    assert.deepEqual(entries(path), [first]);
    writeFileSync(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}`);
    assert.deepEqual(entries(path), [first, second]);
    writeFileSync(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    assert.deepEqual(entries(path), [first, second]);
  }));

  it("rejects malformed newline-terminated records even with a partial tail", () => withTempDir((dir) => {
    const path = join(dir, "session.jsonl");
    writeFileSync(path, '{"type":"first"}\nnot-json\n{"type":');
    assert.throws(() => entries(path), SyntaxError);
  }));

  it("continues artifact discovery despite malformed sessions and missing scripts", () => withTempDir((dir) => {
    const sessionDir = join(dir, "sessions");
    const scriptsDir = join(dir, "scripts");
    mkdirSync(sessionDir);
    mkdirSync(scriptsDir);
    const script = join(scriptsDir, "child.sh");
    writeFileSync(script, "# Surface: pane-script\n# Session: child-script.jsonl\n");
    writeFileSync(join(sessionDir, "bad.jsonl"), "broken\n");
    writeFileSync(join(sessionDir, "good.jsonl"), [
      { type: "message", message: { details: { launchScriptFile: join(dir, "missing.sh"), sessionFile: "child-missing.jsonl" } } },
      { type: "message", message: { details: { launchScriptFile: script, sessionPath: "child-path.jsonl" } } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n{\"partial\":");
    const surfaces = new Set<string>();
    const sessions = new Set<string>();
    discoverLaunchArtifacts(sessionDir, dir, surfaces, sessions);
    assert.deepEqual([...surfaces], ["pane-script"]);
    assert.deepEqual([...sessions].sort(), ["child-missing.jsonl", "child-path.jsonl", "child-script.jsonl"]);
    // Failure to list the parent sessions must not prevent script discovery either.
    const fallback = new Set<string>();
    discoverLaunchArtifacts(join(dir, "missing"), dir, fallback, new Set());
    assert.deepEqual([...fallback], ["pane-script"]);
  }));
});
