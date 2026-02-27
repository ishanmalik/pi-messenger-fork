import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempCrewDirs } from "../../helpers/temp-dirs.js";
import { ensureDataSchemaInitialized } from "../../../crew/data/migration.js";

describe("crew/data/migration", () => {
  it("creates migration marker idempotently", () => {
    const dirs = createTempCrewDirs();

    const first = ensureDataSchemaInitialized(dirs.cwd);
    const second = ensureDataSchemaInitialized(dirs.cwd);

    expect(first.version).toBe(1);
    expect(second.version).toBeGreaterThanOrEqual(1);

    const markerPath = path.join(dirs.cwd, ".pi", "messenger", "data", "migration-state.json");
    expect(fs.existsSync(markerPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    expect(parsed.version).toBe(1);
  });
});
