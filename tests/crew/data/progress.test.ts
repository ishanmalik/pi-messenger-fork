import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compactProgressFile } from "../../../crew/data/progress.js";

describe("crew/data/progress", () => {
  it("compacts oversized progress logs while preserving recent lines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-progress-test-"));
    const progressPath = path.join(root, "task-1.progress.md");

    const lines: string[] = [];
    for (let i = 1; i <= 220; i++) {
      lines.push(`[2026-01-01T00:00:00.000Z] (worker) line ${i}`);
    }

    fs.writeFileSync(progressPath, lines.join("\n") + "\n");

    const result = compactProgressFile(progressPath, {
      maxRawLines: 200,
      keepRecentLines: 80,
    });

    expect(result.compacted).toBe(true);
    expect(result.removedLines).toBe(140);

    const compactedLines = fs.readFileSync(progressPath, "utf-8").trim().split("\n");
    expect(compactedLines.length).toBe(81);
    expect(compactedLines[0]).toContain("[COMPACTED]");
    expect(compactedLines[1]).toContain("line 141");
    expect(compactedLines[80]).toContain("line 220");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
