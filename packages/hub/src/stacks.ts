import { stacksFileReader, stacksResponse, type Db, type StackState } from "@scout/core";

export class HubStacks {
  private db: Db;
  private read: ReturnType<typeof stacksFileReader>;
  private states = new Map<string, StackState>();
  private listeners = new Set<(event: { name: string; state: StackState }) => void>();

  constructor(db: Db, path?: string) { this.db = db; this.read = stacksFileReader(path); this.evaluate(); }
  response() { return stacksResponse(this.db, this.read()); }
  summary() {
    const stacks = this.response().stacks;
    return { total: stacks.length, running: stacks.filter((stack) => stack.state === "running").length };
  }
  subscribe(listener: (event: { name: string; state: StackState }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  evaluate(): void {
    const next = new Map<string, StackState>();
    for (const stack of this.response().stacks) {
      next.set(stack.name, stack.state);
      if (this.states.get(stack.name) === stack.state) continue;
      for (const listener of this.listeners) {
        try { listener({ name: stack.name, state: stack.state }); } catch { /* A closed stream must not interrupt a live read. */ }
      }
    }
    this.states = next;
  }
}
