import * as fs from "node:fs";

export interface ProgressCompactionOptions {
  maxRawLines: number;
  keepRecentLines: number;
  maxLineChars?: number;
}

export interface ProgressCompactionResult {
  compacted: boolean;
  removedLines: number;
  resultingLines: number;
}

function trimLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return line.slice(0, Math.max(0, maxChars - 1)) + "…";
}

export function compactProgressFile(
  progressPath: string,
  options: ProgressCompactionOptions,
): ProgressCompactionResult {
  const maxRawLines = Math.max(20, options.maxRawLines);
  const keepRecentLines = Math.max(5, Math.min(options.keepRecentLines, maxRawLines));
  const maxLineChars = Math.max(200, options.maxLineChars ?? 2000);

  if (!fs.existsSync(progressPath)) {
    return { compacted: false, removedLines: 0, resultingLines: 0 };
  }

  let content = "";
  try {
    content = fs.readFileSync(progressPath, "utf-8");
  } catch {
    return { compacted: false, removedLines: 0, resultingLines: 0 };
  }

  const rawLines = content.split("\n").filter(line => line.length > 0);
  if (rawLines.length <= maxRawLines) {
    return { compacted: false, removedLines: 0, resultingLines: rawLines.length };
  }

  const removedLines = rawLines.length - keepRecentLines;
  const recent = rawLines.slice(-keepRecentLines).map(line => trimLine(line, maxLineChars));
  const marker = `[${new Date().toISOString()}] (system) [COMPACTED] ${removedLines} earlier progress entr${removedLines === 1 ? "y" : "ies"} removed`;

  const next = [marker, ...recent].join("\n") + "\n";
  try {
    fs.writeFileSync(progressPath, next);
  } catch {
    return { compacted: false, removedLines: 0, resultingLines: rawLines.length };
  }

  return {
    compacted: true,
    removedLines,
    resultingLines: keepRecentLines + 1,
  };
}
