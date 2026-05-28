import { openDB, type DBSchema } from "idb";
import type { ProjectState } from "./shared/types";

interface StoryDB extends DBSchema {
  projects: {
    key: string;
    value: ProjectState;
    indexes: {
      updatedAt: number;
    };
  };
}

const DB_NAME = "jsstory-storyboard";
const STORE = "projects";

export async function saveProject(project: ProjectState): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.put(STORE, {
    ...project,
    createdAt: project.createdAt ?? now,
    updatedAt: now
  });
}

export async function loadLatestProject(): Promise<ProjectState | null> {
  const db = await getDb();
  const projects = await db.getAllFromIndex(STORE, "updatedAt");
  return projects.at(-1) ?? null;
}

export async function loadProjects(): Promise<ProjectState[]> {
  const db = await getDb();
  const projects = await db.getAllFromIndex(STORE, "updatedAt");
  return projects.reverse();
}

export async function loadProject(id: string): Promise<ProjectState | null> {
  const db = await getDb();
  return await db.get(STORE, id) ?? null;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

async function getDb() {
  return openDB<StoryDB>(DB_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
    }
  });
}
