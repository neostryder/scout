import { decideRecipe, scanRecipes, type Db, type Project, type RecipeEvent } from "@scout/core";

export class HubRecipes {
  private db: Db;
  private projects: () => Project[];
  private listeners = new Set<(event: RecipeEvent) => void>();

  constructor(db: Db, projects: () => Project[]) { this.db = db; this.projects = projects; }
  subscribe(listener: (event: RecipeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish = (event: RecipeEvent): void => {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* A closed stream must not interrupt a scan. */ }
    }
  };
  scan() { return scanRecipes(this.db, this.projects(), new Date().toISOString(), this.publish); }
  decide(body: Record<string, unknown>) {
    this.scan();
    return decideRecipe(this.db, body, new Date().toISOString(), this.publish);
  }
}
