import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type Entry = { type: string; customType?: string; content?: string; details?: any; message?: any };

// The writer may be midway through its final JSONL record when a poll reads it.
export function entries(path: string): Entry[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const trailing = lines.pop()!;
  const result = lines.filter(Boolean).map((line) => JSON.parse(line));
  if (trailing) {
    try { result.push(JSON.parse(trailing)); } catch { /* incomplete trailing record */ }
  }
  return result;
}

export function parentFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
}

export function childSurface(details: any): string | undefined {
  return readFileSync(details.launchScriptFile, "utf8").match(/^# Surface: (.+)$/m)?.[1];
}

function collectLaunchArtifacts(dir: string, surfaces: Set<string>, sessions: Set<string>): void {
  let children;
  try { children = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of children) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectLaunchArtifacts(path, surfaces, sessions);
    else if (entry.isFile() && entry.name.endsWith(".sh")) {
      try {
        const script = readFileSync(path, "utf8");
        const surface = script.match(/^# Surface: (.+)$/m)?.[1];
        const session = script.match(/^# Session: (.+)$/m)?.[1];
        if (surface) surfaces.add(surface);
        if (session) sessions.add(session);
      } catch { /* A launch artifact may disappear during cleanup. */ }
    }
  }
}

// Best effort: one disappearing or malformed artifact must not hide the rest.
export function discoverLaunchArtifacts(sessionDir: string, dir: string, surfaces: Set<string>, sessions: Set<string>): void {
  let files: string[] = [];
  try { files = parentFiles(sessionDir); } catch {}
  for (const file of files) {
    try {
      for (const e of entries(file)) {
        const d = e.message?.details;
        if (!d?.launchScriptFile) continue;
        if (d.sessionFile) sessions.add(d.sessionFile);
        if (d.sessionPath) sessions.add(d.sessionPath);
        try {
          const surface = childSurface(d);
          if (surface) surfaces.add(surface);
        } catch {}
      }
    } catch { /* Keep discovering artifacts from other sessions and scripts. */ }
  }
  collectLaunchArtifacts(dir, surfaces, sessions);
}
