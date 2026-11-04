import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/** One extension/session generation. No callback may use its context after disposal. */
export class SubagentRuntime<T extends { abortController?: AbortController }> {
  readonly controller = new AbortController();
  readonly agents = new Map<string, T>();
  context: ExtensionContext | null = null;
  widgetInterval: ReturnType<typeof setInterval> | null = null;
  statusInterval: ReturnType<typeof setInterval> | null = null;
  private surfaces = new Set<string>();
  private work = new Set<Promise<unknown>>();
  private disposal: Promise<void> | null = null;

  private readonly close: (surface: string) => void;
  constructor(close: (surface: string) => void) { this.close = close; }
  get alive() { return !this.controller.signal.aborted; }

  ownSurface(surface: string) {
    if (!this.alive) { try { this.close(surface); } catch {} return false; }
    this.surfaces.add(surface);
    return true;
  }
  closeSurface(surface: string) {
    if (!this.surfaces.delete(surface)) return;
    try { this.close(surface); } catch {}
  }
  track<TValue>(promise: Promise<TValue>): Promise<TValue> {
    this.work.add(promise);
    void promise.then(() => this.work.delete(promise), () => this.work.delete(promise));
    return promise;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let complete!: () => void;
    this.disposal = new Promise<void>((resolve) => { complete = resolve; });
    this.controller.abort();
    this.context = null;
    if (this.widgetInterval) clearInterval(this.widgetInterval);
    if (this.statusInterval) clearInterval(this.statusInterval);
    this.widgetInterval = this.statusInterval = null;
    for (const agent of this.agents.values()) agent.abortController?.abort();
    this.agents.clear();
    for (const surface of this.surfaces) this.closeSurface(surface);
    // Third-party operations may ignore cancellation. Let cooperative work settle,
    // but do not block Pi's session replacement indefinitely.
    const pending = Promise.allSettled([...this.work]).then(() => {});
    void Promise.race([pending, new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      pending.then(() => clearTimeout(timer));
    })]).then(complete);
    return this.disposal;
  }
}

const RUNTIME_KEY = Symbol.for("pi-subagents/runtime-dispose");
/** Retire the prior owner on reload or factory reuse without allowing its late
 * shutdown to unregister or dispose this generation. */
export function registerRuntime(runtime: { dispose(): Promise<void> }) {
  const global = globalThis as any;
  const previous = global[RUNTIME_KEY] as (() => void) | undefined;
  previous?.();
  const retire = () => { void runtime.dispose(); };
  global[RUNTIME_KEY] = retire;
  return () => { if (global[RUNTIME_KEY] === retire) delete global[RUNTIME_KEY]; };
}
