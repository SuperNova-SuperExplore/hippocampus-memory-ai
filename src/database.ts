/**
 * 🧠 Hippocampus Database Layer
 * 
 * SQLite database with FTS5 full-text search, WAL mode,
 * transaction safety, and health checks.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface DbStats {
  sessions: number;
  memories: number;
  details: number;
  checkpoints: number;
  crossRefs: number;
  opsLogs: number;
  dbSizeBytes: number;
  dbPath: string;
}

export interface HealthReport {
  status: "healthy" | "degraded" | "critical";
  checks: { name: string; passed: boolean; message: string }[];
  timestamp: string;
}

export class HippocampusDB {
  public db: Database.Database;
  private dbPath: string;
  private writeCount: number = 0;
  private lastBackupTime: number = Date.now();

  constructor(dbPath: string) {
    this.dbPath = dbPath;

    // Auto-create directory if needed
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open/create database
    this.db = new Database(dbPath);

    // Set pragmas for performance + safety
    this.setPragmas();

    // Initialize schema
    this.initSchema();

    // Initialize FTS5
    this.initFTS();
  }

  // ═══════════════════════════════════════
  // PRAGMAS — Performance + Safety
  // ═══════════════════════════════════════

  private setPragmas(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("temp_store = MEMORY");
  }

  // ═══════════════════════════════════════
  // SCHEMA — All tables
  // ═══════════════════════════════════════

  private initSchema(): void {
    this.db.exec(`
      -- TABLE 1: Sessions — Maps Antigravity conversation-id
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        title_auto_generated INTEGER DEFAULT 1,
        brain_path TEXT,
        overview_path TEXT,
        first_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_active TEXT DEFAULT (datetime('now')),
        total_memories INTEGER DEFAULT 0,
        total_checkpoints INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );

      -- TABLE 2: Memories — Core memory storage
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        category TEXT DEFAULT 'general',
        priority INTEGER DEFAULT 3,
        trigger_type TEXT,
        source_step_index INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- TABLE 3: Memory Details — Atomic detail layer
      CREATE TABLE IF NOT EXISTS memory_details (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL,
        detail_type TEXT NOT NULL,
        name TEXT,
        value TEXT,
        context TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- TABLE 4: Checkpoints — Session progress snapshots
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        topics_covered TEXT DEFAULT '[]',
        decisions_made TEXT DEFAULT '[]',
        open_questions TEXT DEFAULT '[]',
        memory_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- TABLE 5: Cross-references — Links between sessions
      CREATE TABLE IF NOT EXISTS cross_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_session_id TEXT NOT NULL,
        to_session_id TEXT NOT NULL,
        relationship TEXT,
        context TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (from_session_id) REFERENCES sessions(id),
        FOREIGN KEY (to_session_id) REFERENCES sessions(id)
      );

      -- TABLE 6: Operation log — Track success/failure
      CREATE TABLE IF NOT EXISTS ops_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        duration_ms INTEGER,
        timestamp TEXT DEFAULT (datetime('now'))
      );

      -- TABLE 7: Watcher state — Track auto-ingest read positions
      CREATE TABLE IF NOT EXISTS watcher_state (
        session_id TEXT PRIMARY KEY,
        overview_path TEXT NOT NULL,
        last_byte_offset INTEGER DEFAULT 0,
        last_step_index INTEGER DEFAULT -1,
        entries_ingested INTEGER DEFAULT 0,
        last_processed TEXT DEFAULT (datetime('now'))
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority);
      CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(is_active);
      CREATE INDEX IF NOT EXISTS idx_details_memory ON memory_details(memory_id);
      CREATE INDEX IF NOT EXISTS idx_details_type ON memory_details(detail_type);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
      CREATE INDEX IF NOT EXISTS idx_cross_refs_from ON cross_refs(from_session_id);
      CREATE INDEX IF NOT EXISTS idx_cross_refs_to ON cross_refs(to_session_id);
    `);
  }

  // ═══════════════════════════════════════
  // FTS5 — Full-text search
  // ═══════════════════════════════════════

  private initFTS(): void {
    // Check if FTS tables exist before creating
    const hasFts = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();

    if (!hasFts) {
      this.db.exec(`
        -- FTS5 on memories
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          tags,
          category,
          content=memories,
          content_rowid=id
        );

        -- FTS5 on details
        CREATE VIRTUAL TABLE details_fts USING fts5(
          name,
          value,
          context,
          content=memory_details,
          content_rowid=id
        );

        -- Sync triggers: memories → memories_fts
        CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags, category)
          VALUES (new.id, new.content, new.tags, new.category);
        END;

        CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, category)
          VALUES ('delete', old.id, old.content, old.tags, old.category);
        END;

        CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, category)
          VALUES ('delete', old.id, old.content, old.tags, old.category);
          INSERT INTO memories_fts(rowid, content, tags, category)
          VALUES (new.id, new.content, new.tags, new.category);
        END;

        -- Sync triggers: memory_details → details_fts
        CREATE TRIGGER details_fts_ai AFTER INSERT ON memory_details BEGIN
          INSERT INTO details_fts(rowid, name, value, context)
          VALUES (new.id, new.name, new.value, new.context);
        END;

        CREATE TRIGGER details_fts_ad AFTER DELETE ON memory_details BEGIN
          INSERT INTO details_fts(details_fts, rowid, name, value, context)
          VALUES ('delete', old.id, old.name, old.value, old.context);
        END;

        CREATE TRIGGER details_fts_au AFTER UPDATE ON memory_details BEGIN
          INSERT INTO details_fts(details_fts, rowid, name, value, context)
          VALUES ('delete', old.id, old.name, old.value, old.context);
          INSERT INTO details_fts(rowid, name, value, context)
          VALUES (new.id, new.name, new.value, new.context);
        END;
      `);
    }

    // Ops log cleanup trigger
    const hasCleanup = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='ops_log_cleanup'")
      .get();

    if (!hasCleanup) {
      this.db.exec(`
        CREATE TRIGGER ops_log_cleanup AFTER INSERT ON ops_log BEGIN
          DELETE FROM ops_log WHERE id < (SELECT MAX(id) - 1000 FROM ops_log);
        END;
      `);
    }
  }

  // ═══════════════════════════════════════
  // HEALTH CHECK — Startup validation
  // ═══════════════════════════════════════

  healthCheck(): HealthReport {
    const checks: HealthReport["checks"] = [];
    let overallStatus: HealthReport["status"] = "healthy";

    // Check 1: DB file exists + writable
    try {
      fs.accessSync(this.dbPath, fs.constants.R_OK | fs.constants.W_OK);
      checks.push({ name: "db_access", passed: true, message: "DB file readable + writable" });
    } catch {
      checks.push({ name: "db_access", passed: false, message: "DB file access denied" });
      overallStatus = "critical";
    }

    // Check 2: Integrity check
    try {
      const result = this.db.pragma("integrity_check") as { integrity_check: string }[];
      const ok = result[0]?.integrity_check === "ok";
      checks.push({
        name: "integrity",
        passed: ok,
        message: ok ? "Integrity check passed" : `Integrity issue: ${result[0]?.integrity_check}`,
      });
      if (!ok) overallStatus = "critical";
    } catch (e) {
      checks.push({ name: "integrity", passed: false, message: `Integrity check error: ${e}` });
      overallStatus = "critical";
    }

    // Check 3: Quick check
    try {
      const result = this.db.pragma("quick_check") as { quick_check: string }[];
      const ok = result[0]?.quick_check === "ok";
      checks.push({
        name: "quick_check",
        passed: ok,
        message: ok ? "Quick check passed" : `Quick check issue: ${result[0]?.quick_check}`,
      });
      if (!ok && overallStatus === "healthy") overallStatus = "degraded";
    } catch (e) {
      checks.push({ name: "quick_check", passed: false, message: `Quick check error: ${e}` });
      if (overallStatus === "healthy") overallStatus = "degraded";
    }

    // Check 4: Test write/read/delete
    try {
      this.db.exec(`
        INSERT INTO ops_log (operation, status) VALUES ('health_check', 'test');
      `);
      const row = this.db
        .prepare("SELECT id FROM ops_log WHERE operation = 'health_check' AND status = 'test' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;
      if (row) {
        this.db.prepare("DELETE FROM ops_log WHERE id = ?").run(row.id);
      }
      checks.push({ name: "write_read_delete", passed: true, message: "CRUD test passed" });
    } catch (e) {
      checks.push({ name: "write_read_delete", passed: false, message: `CRUD test failed: ${e}` });
      overallStatus = "critical";
    }

    // Check 5: FTS5 responds
    try {
      this.db.prepare("SELECT * FROM memories_fts LIMIT 0").all();
      this.db.prepare("SELECT * FROM details_fts LIMIT 0").all();
      checks.push({ name: "fts5", passed: true, message: "FTS5 indexes responsive" });
    } catch (e) {
      checks.push({ name: "fts5", passed: false, message: `FTS5 error: ${e}` });
      if (overallStatus === "healthy") overallStatus = "degraded";
    }

    // Check 6: Disk space (basic check via DB size)
    try {
      const stats = fs.statSync(this.dbPath);
      const dbSizeMB = stats.size / (1024 * 1024);
      checks.push({
        name: "disk_space",
        passed: true,
        message: `DB size: ${dbSizeMB.toFixed(2)} MB`,
      });
    } catch (e) {
      checks.push({ name: "disk_space", passed: false, message: `Disk check error: ${e}` });
    }

    // Check 7: WAL mode active
    try {
      const result = this.db.pragma("journal_mode") as { journal_mode: string }[];
      const isWal = result[0]?.journal_mode === "wal";
      checks.push({
        name: "wal_mode",
        passed: isWal,
        message: isWal ? "WAL mode active" : `Journal mode: ${result[0]?.journal_mode}`,
      });
      if (!isWal && overallStatus === "healthy") overallStatus = "degraded";
    } catch (e) {
      checks.push({ name: "wal_mode", passed: false, message: `WAL check error: ${e}` });
    }

    return {
      status: overallStatus,
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════
  // STATS — Database statistics
  // ═══════════════════════════════════════

  getStats(): DbStats {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      return row.c;
    };

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.dbPath).size;
    } catch {
      // ignore
    }

    return {
      sessions: count("sessions"),
      memories: count("memories"),
      details: count("memory_details"),
      checkpoints: count("checkpoints"),
      crossRefs: count("cross_refs"),
      opsLogs: count("ops_log"),
      dbSizeBytes,
      dbPath: this.dbPath,
    };
  }

  // ═══════════════════════════════════════
  // REBUILD — FTS5 index rebuild
  // ═══════════════════════════════════════

  rebuildFTSIndex(): { memoriesFts: string; detailsFts: string } {
    let memStatus = "rebuilt";
    let detStatus = "rebuilt";

    try {
      this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    } catch {
      memStatus = "recreated";
    }

    try {
      this.db.exec("INSERT INTO details_fts(details_fts) VALUES('rebuild')");
    } catch {
      detStatus = "recreated";
    }

    // If either failed, drop both and recreate from scratch
    if (memStatus === "recreated" || detStatus === "recreated") {
      this.db.exec(`
        DROP TABLE IF EXISTS memories_fts;
        DROP TABLE IF EXISTS details_fts;
        DROP TRIGGER IF EXISTS memories_fts_ai;
        DROP TRIGGER IF EXISTS memories_fts_ad;
        DROP TRIGGER IF EXISTS memories_fts_au;
        DROP TRIGGER IF EXISTS details_fts_ai;
        DROP TRIGGER IF EXISTS details_fts_ad;
        DROP TRIGGER IF EXISTS details_fts_au;
      `);
      this.initFTS();
      memStatus = "recreated";
      detStatus = "recreated";
    }

    return { memoriesFts: memStatus, detailsFts: detStatus };
  }

  // ═══════════════════════════════════════
  // OPS LOG — Track operations
  // ═══════════════════════════════════════

  logOperation(operation: string, status: string, errorMessage?: string, durationMs?: number): void {
    try {
      this.db
        .prepare("INSERT INTO ops_log (operation, status, error_message, duration_ms) VALUES (?, ?, ?, ?)")
        .run(operation, status, errorMessage ?? null, durationMs ?? null);
    } catch {
      // Silent fail — ops log is not critical
    }
  }

  // ═══════════════════════════════════════
  // SESSION — Ensure session exists
  // ═══════════════════════════════════════

  ensureSession(sessionId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO sessions (id) VALUES (?)")
      .run(sessionId);
  }

  // ═══════════════════════════════════════
  // BACKUP — Auto-backup logic
  // ═══════════════════════════════════════

  incrementWriteCount(): void {
    this.writeCount++;
    const hoursSinceBackup = (Date.now() - this.lastBackupTime) / (1000 * 60 * 60);

    if (this.writeCount >= 100 || hoursSinceBackup >= 24) {
      this.createBackup();
      this.writeCount = 0;
      this.lastBackupTime = Date.now();
    }
  }

  createBackup(): boolean {
    const backupPath = this.dbPath.replace(/\.db$/, ".backup.db");
    try {
      this.db.backup(backupPath);
      return true;
    } catch {
      // Fallback: file copy
      try {
        fs.copyFileSync(this.dbPath, backupPath);
        return true;
      } catch {
        return false;
      }
    }
  }

  // ═══════════════════════════════════════
  // CLOSE — Graceful shutdown
  // ═══════════════════════════════════════

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
