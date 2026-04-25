# 🧠 Hippocampus Memory AI

> Persistent Session Memory MCP Server for AI — Converts short-term context window into long-term searchable memory.

Like the brain's hippocampus converts short-term memory into long-term memory, this MCP server gives AI assistants **persistent, searchable memory** that survives context window overflow and session boundaries.

## Features

- **Structured Memory** — Not just flat text. Memories have detail atoms: files, functions, configs, commands, values, errors, endpoints, schemas, references
- **Full-Text Search** — SQLite FTS5 for instant recall by topic
- **Cross-Session Recall** — Query memories across ALL past sessions
- **Session Discovery** — Auto-scan Antigravity `brain/` directory, extract conversation titles
- **Noise Filter** — Signal scoring guides what's worth remembering vs skipping
- **Zero Data Loss** — WAL mode, transactions, retry logic, fallback JSON file, auto-backup
- **Batch Operations** — Store multiple memories in a single <50ms call
- **Auto-Dedup** — Optional duplicate detection prevents redundant entries

## Tools

| Tool | Description |
|------|-------------|
| `hippocampus_remember` | Store a memory with optional detail atoms |
| `hippocampus_recall` | Search memories by topic (FTS5 + tag filter) |
| `hippocampus_batch_remember` | Store multiple memories in one call |
| `hippocampus_checkpoint` | Save a progress snapshot |
| `hippocampus_timeline` | Chronological view of session events |
| `hippocampus_get_context` | Cross-session topic recall |
| `hippocampus_link_sessions` | Create cross-references between sessions |
| `hippocampus_discover_sessions` | Scan and index Antigravity sessions |
| `hippocampus_forget` | Soft/hard delete a memory |
| `hippocampus_rebuild_index` | Rebuild FTS5 search index |

## Resources

| URI | Description |
|-----|-------------|
| `memory://sessions` | List all known sessions |
| `memory://current` | Current session summary |
| `memory://topics` | All topics across sessions |
| `memory://stats` | Global statistics |
| `memory://health` | Database health status |

## Installation

```bash
# Clone
git clone https://github.com/SuperNova-SuperExplore/hippocampus-memory-ai.git
cd hippocampus-memory-ai

# Install dependencies
npm install

# Build
npm run build

# Run
npm start
```

## MCP Configuration

Add to your MCP config (e.g., Antigravity `mcp_config.json`):

```json
{
  "hippocampus": {
    "command": "node",
    "args": ["D:\\PHANTOM-OPS\\hippocampus-memory-ai\\dist\\index.js"],
    "env": {
      "BRAIN_PATH": "C:\\Users\\Azizi\\.gemini\\antigravity\\brain",
      "DB_PATH": "D:\\PHANTOM-OPS\\hippocampus-memory-ai\\hippocampus.db"
    }
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│              MCP Client (AI)                     │
│  hippocampus_remember() / hippocampus_recall()   │
└──────────────────┬──────────────────────────────┘
                   │ stdio
┌──────────────────▼──────────────────────────────┐
│           Hippocampus MCP Server                 │
├──────────────────────────────────────────────────┤
│  Tools Layer     │  Resources Layer              │
│  ├── remember    │  ├── memory://sessions        │
│  ├── recall      │  ├── memory://current         │
│  ├── checkpoint  │  ├── memory://stats           │
│  └── ...         │  └── memory://health          │
├──────────────────┴───────────────────────────────┤
│  Safeguards: Retry → Fallback → Backup           │
├──────────────────────────────────────────────────┤
│  SQLite (better-sqlite3) + FTS5                  │
│  ┌─────────┬──────────────┬──────────────┐       │
│  │memories │memory_details│ checkpoints  │       │
│  │sessions │ cross_refs   │  ops_log     │       │
│  └─────────┴──────────────┴──────────────┘       │
└──────────────────────────────────────────────────┘
```

## License

MIT
