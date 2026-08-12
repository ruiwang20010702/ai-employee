import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkRecipe } from "./work-recipe.mjs";

export async function loadWorkRecipes(directory) {
  const root = directory instanceof URL ? fileURLToPath(directory) : directory;
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const recipes = new Map();
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    const recipe = validateWorkRecipe(JSON.parse(await readFile(resolve(root, entry.name), "utf8")));
    if (recipes.has(recipe.id)) throw new Error(`Duplicate work recipe: ${recipe.id}`);
    recipes.set(recipe.id, recipe);
  }
  return recipes;
}
