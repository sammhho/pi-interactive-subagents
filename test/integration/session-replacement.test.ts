/** Real Pi/mux regression for watcher ownership across /new and /reload. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestEnv, closeSurface, createTestEnv, createTrackedSurface, getAvailableBackends,
  PI_TIMEOUT, readScreen, restoreBackend, sendCommand, setBackend, sleep, startPi,
  TEST_MODEL, uniqueId, waitForFile,
} from "./harness.ts";
import { childSurface as readChildSurface, discoverLaunchArtifacts, entries, parentFiles, type Entry } from "./session-replacement-utils.ts";

// Poll persisted session entries, not scrollback: /reload retains old screen content.
async function until<T>(description: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(500);
  }
  throw new Error(`Timeout waiting for ${description}`);
}
function toolResult(file: string, tool: string, name: string): any | undefined {
  return entries(file).find((e) => e.type === "message" && e.message?.role === "toolResult" &&
    e.message?.toolName === tool && e.message?.details?.name === name &&
    e.message?.details?.status === "started")?.message.details;
}
function childSurface(details: any): string {
  const surface = readChildSurface(details);
  assert.ok(surface, `No surface in ${details.launchScriptFile}`);
  return surface;
}
async function waitForIdle(file: string, tool: string, name: string): Promise<void> {
  await until(`${name} parent turn to finish`, () => {
    const es = entries(file);
    const index = es.findIndex((e) => e.type === "message" && e.message?.role === "toolResult" &&
      e.message?.toolName === tool && e.message?.details?.name === name);
    return index >= 0 && es.slice(index + 1).some((e) => e.type === "message" &&
      e.message?.role === "assistant" && e.message?.stopReason === "stop") ? true : undefined;
  });
}
async function waitForResult(file: string, name: string): Promise<Entry> {
  return until(`result for ${name}`, () => entries(file).find((e) =>
    e.type === "custom_message" && e.customType === "subagent_result" && e.details?.name === name));
}
function assertNoOldNotification(file: string, name: string, offset: number): void {
  const stale = entries(file).slice(offset).filter((e) => e.type === "custom_message" &&
    ["subagent_result", "subagent_ping", "subagent_status"].includes(e.customType ?? "") &&
    (e.details?.name === name || (typeof e.content === "string" && e.content.includes(name))));
  assert.deepEqual(stale, [], `Outgoing watcher delivered to replacement: ${JSON.stringify(stale)}`);
}
function spawnPrompt(name: string, command: string): string {
  return `Call subagent exactly once with name ${JSON.stringify(name)}, agent "test-echo", model ${JSON.stringify(TEST_MODEL)}, and task ${JSON.stringify(`Run this exact bash command immediately: ${command}`)}. Then finish your turn immediately. Do not run the command yourself.`;
}

const backends = getAvailableBackends();
if (!backends.length) console.log("⚠️  No mux backend available — skipping session replacement integration tests");
for (const backend of backends) {
  describe(`session replacement [${backend}]`, { timeout: PI_TIMEOUT * 7 }, () => {
    for (const command of ["new", "reload"] as const) {
      it(`keeps replacement spawn and resume watchers alive after /${command}`, async () => {
        const env = createTestEnv(backend);
        const id = uniqueId();
        const sessionDir = join(env.dir, "parent-sessions");
        mkdirSync(sessionDir);
        const oldName = `Old-${id}`;
        const newName = `Fresh-${id}`;
        const resumeName = `Resume-${id}`;
        const oldStarted = join(env.dir, "old-started");
        const oldGate = join(env.dir, "old-gate");
        const freshStarted = join(env.dir, "fresh-started");
        const freshGate = join(env.dir, "fresh-gate");
        const freshDone = join(env.dir, "fresh-done");
        const resumeStarted = join(env.dir, "resume-started");
        const resumeGate = join(env.dir, "resume-gate");
        const resumeDone = join(env.dir, "resume-done");
        const childSessions = new Set<string>();
        const childSurfaces = new Set<string>();
        const remember = (details: any) => {
          if (details.sessionFile) childSessions.add(details.sessionFile);
          if (details.sessionPath) childSessions.add(details.sessionPath);
          childSurfaces.add(childSurface(details));
        };
        // The bounded gate also prevents a stranded shell if the test process is killed.
        const gateCommand = (started: string, gate: string, done?: string) =>
          `echo START > '${started}'; for i in $(seq 1 600); do [ -f '${gate}' ] && break; sleep 0.2; done; [ -f '${gate}' ] || exit 1${done ? `; echo DONE > '${done}'` : ""}`;
        const previousBackend = setBackend(backend);
        try {
          const surface = createTrackedSurface(env, `replacement-${id}`);
          await sleep(1000);
          startPi(surface, env.dir, spawnPrompt(oldName, gateCommand(oldStarted, oldGate)), {
            extraArgs: `--session-dir '${sessionDir}'`,
          });
          const original = await until("original parent session", () => parentFiles(sessionDir)[0]);
          const old = await until("old spawn", () => toolResult(original, "subagent", oldName));
          remember(old);
          await waitForFile(oldStarted, PI_TIMEOUT);
          await waitForIdle(original, "subagent", oldName);
          assert.ok(readScreen(childSurface(old), 50), "old child must be active before replacement");
          const oldEntryCount = entries(original).length;
          sendCommand(surface, `/${command}`);
          // Give the real interactive command handler time to complete before submitting a prompt.
          await sleep(3000);
          sendCommand(surface, spawnPrompt(newName, gateCommand(freshStarted, freshGate, freshDone)));
          const replacement = command === "new"
            ? await until("new parent session", () => parentFiles(sessionDir).find((f) => f !== original))
            : original;
          const replacementOffset = command === "reload" ? oldEntryCount : 0;
          const fresh = await until("replacement spawn", () => toolResult(replacement, "subagent", newName));
          remember(fresh);
          await waitForFile(freshStarted, PI_TIMEOUT);
          await waitForIdle(replacement, "subagent", newName);
          await sleep(2500); // More than two watcher polling intervals, while gate is closed.
          assert.ok(readScreen(childSurface(fresh), 50), "replacement child pane closed before gate release");
          assert.equal(existsSync(freshDone), false);
          assertNoOldNotification(replacement, oldName, replacementOffset);
          assert.equal(entries(replacement).some((e) => e.customType === "subagent_result" && e.details?.name === newName), false);
          writeFileSync(freshGate, "release");
          await waitForFile(freshDone, PI_TIMEOUT, /DONE/);
          const result = await waitForResult(replacement, newName);
          assert.equal(result.details.exitCode, 0, JSON.stringify(result));
          assert.doesNotMatch(result.content ?? "", /aborted while waiting|cancelled/i);
          await waitForIdle(replacement, "subagent", newName);
          // Wait for the result-triggered parent turn to end before sending the resume prompt.
          await until("result turn to finish", () => {
            const es = entries(replacement);
            const i = es.indexOf(es.find((e) => e.customType === "subagent_result" && e.details?.name === newName)!);
            return i >= 0 && es.slice(i + 1).some((e) => e.message?.role === "assistant" && e.message?.stopReason === "stop") ? true : undefined;
          });
          const resumeTask = `Run this exact bash command immediately: ${gateCommand(resumeStarted, resumeGate, resumeDone)}`;
          sendCommand(surface, `Call subagent_resume exactly once with sessionPath ${JSON.stringify(fresh.sessionFile)}, name ${JSON.stringify(resumeName)}, message ${JSON.stringify(resumeTask)}, and autoExit true. Then finish your turn immediately.`);
          const resumed = await until("replacement resume", () => toolResult(replacement, "subagent_resume", resumeName));
          remember(resumed);
          await waitForFile(resumeStarted, PI_TIMEOUT);
          await waitForIdle(replacement, "subagent_resume", resumeName);
          await sleep(2500);
          assert.ok(readScreen(childSurface(resumed), 50), "resumed child pane closed before gate release");
          assert.equal(existsSync(resumeDone), false);
          assertNoOldNotification(replacement, oldName, replacementOffset);
          writeFileSync(resumeGate, "release");
          await waitForFile(resumeDone, PI_TIMEOUT, /DONE/);
          const resumeResult = await waitForResult(replacement, resumeName);
          assert.equal(resumeResult.details.exitCode, 0, JSON.stringify(resumeResult));
          assert.equal(resumeResult.details.sessionFile, fresh.sessionFile);
          assert.doesNotMatch(resumeResult.content ?? "", /aborted while waiting|cancelled/i);
          assertNoOldNotification(replacement, oldName, replacementOffset);
        } finally {
          try {
            // Launch may have completed before a timed-out assertion observed its tool result.
            discoverLaunchArtifacts(sessionDir, env.dir, childSurfaces, childSessions);
          } catch {
            // Discovery is best effort; teardown must not mask the test failure.
          } finally {
            try {
              for (const child of childSurfaces) try { closeSurface(child); } catch {}
            } finally {
              try {
                cleanupTestEnv(env);
              } finally {
                try {
                  for (const file of childSessions) try { rmSync(file, { force: true }); } catch {}
                } finally {
                  restoreBackend(previousBackend);
                }
              }
            }
          }
        }
      });
    }
  });
}
