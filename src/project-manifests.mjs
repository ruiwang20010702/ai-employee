import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { validateProjectManifest } from "./capability-policy.mjs";

export async function loadProjectManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const projects = new Map();
  for (const entry of entries.filter(
    (value) => value.isFile() && value.name.endsWith(".json"),
  )) {
    const path = resolve(directory, entry.name);
    const project = validateProjectManifest(JSON.parse(await readFile(path, "utf8")));
    if (projects.has(project.projectId)) {
      throw new Error(`Duplicate projectId: ${project.projectId}`);
    }
    projects.set(project.projectId, { ...project, manifestPath: path });
  }
  return projects;
}
