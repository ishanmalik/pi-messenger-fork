import * as fs from "node:fs";
import * as path from "node:path";

const DATA_SCHEMA_VERSION = 1;

export interface DataMigrationState {
  version: number;
  appliedAt: string;
  note: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function markerPath(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "data", "migration-state.json");
}

export function ensureDataSchemaInitialized(cwd: string): DataMigrationState {
  const filePath = markerPath(cwd);
  ensureDir(path.dirname(filePath));

  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, "utf-8")) as DataMigrationState;
      if (typeof existing.version === "number" && existing.version >= DATA_SCHEMA_VERSION) {
        return existing;
      }
    } catch {
      // rewrite below
    }
  }

  const state: DataMigrationState = {
    version: DATA_SCHEMA_VERSION,
    appliedAt: new Date().toISOString(),
    note: "Initialized canonical data pipeline directories and schema marker.",
  };

  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return state;
}
