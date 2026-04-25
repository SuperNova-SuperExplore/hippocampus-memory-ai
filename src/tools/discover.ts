/**
 * 🧠 Hippocampus — Session Discovery
 * 
 * Scan Antigravity brain/ directory, discover sessions,
 * extract titles from overview.txt first messages.
 */

import fs from "fs";
import path from "path";
import { HippocampusDB } from "../database.js";
import type { SessionRecord } from "../types.js";

// UUID regex pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════
// Title Extraction from overview.txt
// ═══════════════════════════════════════

function extractTitleFromOverview(overviewPath: string): { title: string; firstMessage: string; createdAt: string | null } {
  const fallback = { title: "Untitled Session", firstMessage: "", createdAt: null };

  try {
    // Read file — try UTF-8, fallback to latin1
    let content: string;
    try {
      content = fs.readFileSync(overviewPath, "utf-8");
    } catch {
      content = fs.readFileSync(overviewPath, "latin1");
    }

    const lines = content.trim().split("\n").filter(Boolean);

    // Try first 5 lines to find a valid user message
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      try {
        const entry = JSON.parse(lines[i]);

        // Look for USER_INPUT type
        if (entry.type === "USER_INPUT" || entry.source === "USER_EXPLICIT") {
          const rawContent: string = entry.content || "";

          // Extract actual message from XML tags
          const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
          const userMessage = match ? match[1].trim() : rawContent.trim();

          if (userMessage) {
            // Generate title from first ~10 meaningful words
            const title = generateTitle(userMessage);
            return {
              title,
              firstMessage: userMessage.substring(0, 500),
              createdAt: entry.created_at || null,
            };
          }
        }
      } catch {
        // Skip corrupt JSON lines
        continue;
      }
    }
  } catch {
    // File read failed
  }

  return fallback;
}

/**
 * Generate a readable title from a user message
 */
function generateTitle(message: string): string {
  // Clean up the message
  let clean = message
    .replace(/<[^>]+>/g, "")  // Remove XML/HTML tags
    .replace(/\s+/g, " ")  // Normalize whitespace
    .trim();

  if (!clean) return "Untitled Session";

  // Take first meaningful chunk (up to ~60 chars)
  const words = clean.split(" ");
  let title = "";

  for (const word of words) {
    if ((title + " " + word).trim().length > 60) break;
    title = (title + " " + word).trim();
  }

  // Capitalize first letter
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // Add ellipsis if truncated
  if (words.length > title.split(" ").length) {
    title += "...";
  }

  return title || "Untitled Session";
}

// ═══════════════════════════════════════
// Session Scanner
// ═══════════════════════════════════════

export interface DiscoverInput {
  rescan?: boolean;
  brain_path?: string;
}

export interface DiscoveredSession {
  id: string;
  title: string;
  brain_path: string;
  overview_exists: boolean;
  created_at: string | null;
  is_new: boolean;
}

export interface DiscoverResult {
  sessions_found: number;
  sessions_new: number;
  sessions_existing: number;
  sessions: DiscoveredSession[];
  brain_path: string;
}

export function discoverSessions(
  db: HippocampusDB,
  input: DiscoverInput,
  defaultBrainPath: string
): DiscoverResult {
  const startTime = Date.now();
  const brainPath = input.brain_path || defaultBrainPath;

  if (!brainPath || !fs.existsSync(brainPath)) {
    db.logOperation("discover", "error", `Brain path not found: ${brainPath}`, Date.now() - startTime);
    return {
      sessions_found: 0,
      sessions_new: 0,
      sessions_existing: 0,
      sessions: [],
      brain_path: brainPath || "NOT_SET",
    };
  }

  const discovered: DiscoveredSession[] = [];
  let newCount = 0;
  let existingCount = 0;

  // Scan brain/ directory
  const entries = fs.readdirSync(brainPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!UUID_REGEX.test(entry.name)) continue;

    const sessionId = entry.name;
    const sessionPath = path.join(brainPath, sessionId);
    const overviewPath = path.join(sessionPath, ".system_generated", "logs", "overview.txt");
    const overviewExists = fs.existsSync(overviewPath);

    // Check if already in DB
    const existing = db.db
      .prepare("SELECT id, title FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string; title: string | null } | undefined;

    // Skip if exists and not rescanning
    if (existing && !input.rescan) {
      existingCount++;
      discovered.push({
        id: sessionId,
        title: existing.title || "Untitled",
        brain_path: sessionPath,
        overview_exists: overviewExists,
        created_at: null,
        is_new: false,
      });
      continue;
    }

    // Extract title from overview
    let title = "Untitled Session";
    let firstMessage = "";
    let createdAt: string | null = null;

    if (overviewExists) {
      const extracted = extractTitleFromOverview(overviewPath);
      title = extracted.title;
      firstMessage = extracted.firstMessage;
      createdAt = extracted.createdAt;
    }

    // Upsert into DB
    db.db
      .prepare(
        `INSERT INTO sessions (id, title, title_auto_generated, brain_path, overview_path, first_message, created_at)
         VALUES (?, ?, 1, ?, ?, ?, COALESCE(?, datetime('now')))
         ON CONFLICT(id) DO UPDATE SET
           title = CASE WHEN title_auto_generated = 1 THEN excluded.title ELSE title END,
           brain_path = excluded.brain_path,
           overview_path = excluded.overview_path,
           first_message = COALESCE(excluded.first_message, first_message)`
      )
      .run(
        sessionId,
        title,
        sessionPath,
        overviewExists ? overviewPath : null,
        firstMessage || null,
        createdAt
      );

    newCount++;
    discovered.push({
      id: sessionId,
      title,
      brain_path: sessionPath,
      overview_exists: overviewExists,
      created_at: createdAt,
      is_new: !existing,
    });
  }

  db.logOperation("discover", "success", undefined, Date.now() - startTime);

  return {
    sessions_found: discovered.length,
    sessions_new: newCount,
    sessions_existing: existingCount,
    sessions: discovered,
    brain_path: brainPath,
  };
}

/**
 * Rename a session (override auto-generated title)
 */
export function renameSession(db: HippocampusDB, sessionId: string, newTitle: string) {
  db.ensureSession(sessionId);

  db.db
    .prepare("UPDATE sessions SET title = ?, title_auto_generated = 0 WHERE id = ?")
    .run(newTitle.trim(), sessionId);

  return {
    session_id: sessionId,
    new_title: newTitle.trim(),
    message: `Session renamed to "${newTitle.trim()}"`,
  };
}
