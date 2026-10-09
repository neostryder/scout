import { decideRecipe, recipeById, recipesResponse, scanRecipes, type Db, type Project } from "@scout/core";

export function recipesCommand(db: Db, args: string[], options: { projects?: () => Project[]; write?: (line: string) => void } = {}): void {
  const write = options.write ?? console.log;
  const command = args[0];
  if (command === "scan") { write(JSON.stringify(scanRecipes(db, options.projects?.() ?? []))); return; }
  if (command === "approve" || command === "reject") {
    const id = Number(args[1]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("id must be a positive integer");
    if (options.projects) scanRecipes(db, options.projects());
    const recipe = recipeById(db, id);
    if (!recipe) throw new Error("not found");
    if (command === "approve") {
      write(recipe.command);
      if (!args.includes("--yes")) throw new Error("recipes approve requires --yes");
    }
    write(JSON.stringify({ recipe: decideRecipe(db, { id, decision: command === "approve" ? "approve" : "reject", hash: recipe.hash, confirm: true }) }));
    return;
  }
  if (command && command !== "--state" && command !== "--db") throw new Error("recipes requires scan, approve, reject or --state");
  const index = args.indexOf("--state");
  if (index >= 0 && !args[index + 1]) throw new Error("--state requires a state");
  write(JSON.stringify(recipesResponse(db, index < 0 ? "all" : args[index + 1])));
}
