/**
 * 🧠 Hippocampus — Fallback file writer
 * 
 * When SQLite fails, data goes to a JSONL fallback file.
 * Append-only — can't corrupt existing data.
 * On next healthy startup, pending entries get imported.
 */

import fs from "fs";
import path from "path";

export class FallbackWriter {
  private filePath: string;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    this.filePath = path.join(dir, "hippocampus_fallback.jsonl");
  }

  /**
   * Append a failed operation to the fallback file
   */
  write(operation: string, data: Record<string, unknown>): boolean {
    try {
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        op: operation,
        data,
        imported: false,
      });
      fs.appendFileSync(this.filePath, entry + "\n", "utf-8");
      return true;
    } catch {
      // If even fallback fails, we're in hardware failure territory
      return false;
    }
  }

  /**
   * Read all pending (unimported) entries from fallback file
   */
  readPending(): Array<{ ts: string; op: string; data: Record<string, unknown> }> {
    if (!fs.existsSync(this.filePath)) return [];

    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const entries = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (!parsed.imported) {
            entries.push(parsed);
          }
        } catch {
          // Skip corrupt lines
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Clear the fallback file after successful import
   */
  clear(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, "", "utf-8");
      }
    } catch {
      // ignore
    }
  }

  /**
   * Check if fallback file has pending entries
   */
  hasPending(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    try {
      const stats = fs.statSync(this.filePath);
      return stats.size > 0;
    } catch {
      return false;
    }
  }
}
