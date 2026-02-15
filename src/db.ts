import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

export type MemoryType =
  | "decision"
  | "preference"
  | "fact"
  | "gotcha"
  | "todo"
  | "api_contract";

export type MemoryItem = {
  id: number;
  workspaceKey: string;
  type: MemoryType;
  text: string;
  summary: string;
  tagsJson: string | null;
  importance: number;
  createdAt: string;
  lastUsedAt: string | null;
  supersededBy: number | null;
};

export type SearchResult = MemoryItem & { distance: number };

const DEFAULT_DB_PATH = "./data/memory.db";
const DEFAULT_DIM = 768;

export function openDb(dbPath = process.env.MEMORY_DB_PATH ?? DEFAULT_DB_PATH): Database {
  // On macOS, Bun may use Apple's SQLite which disables extension loading.
  // If you hit extension-loading errors, set CUSTOM_SQLITE_PATH to a SQLite build that supports extensions.
  // See: https://bun.com/reference/bun/sqlite/Database/loadExtension
  // and sqlite-vec Bun recipe.
  const custom = process.env.CUSTOM_SQLITE_PATH;
  if (custom) {
    Database.setCustomSQLite(custom);
  }

  const db = new Database(dbPath);
  db.query("PRAGMA journal_mode=WAL;").run();
  db.query("PRAGMA synchronous=NORMAL;").run();

  // Load sqlite-vec extension into this connection.
  sqliteVec.load(db);

  initSchema(db);
  return db;
}

function initSchema(db: Database) {
  const dim = Number(process.env.EMBEDDING_DIM ?? DEFAULT_DIM);
  if (!Number.isFinite(dim) || dim <= 0) throw new Error("Invalid EMBEDDING_DIM");

  db.query(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_key TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      superseded_by INTEGER
    );
  `).run();

  // vec0 virtual tables require an integer primary key column.
  // vec0 supports metadata columns and partition keys.
  // Docs: https://alexgarcia.xyz/sqlite-vec/features/vec0.html
  db.query(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
      memory_id INTEGER PRIMARY KEY,
      workspace_key TEXT PARTITION KEY,
      type TEXT,
      embedding FLOAT[${dim}]
    );
  `).run();

  db.query(`
    CREATE INDEX IF NOT EXISTS idx_memory_items_workspace ON memory_items(workspace_key);
  `).run();
}

export function saveMemory(db: Database, input: {
  workspaceKey: string;
  type: MemoryType;
  text: string;
  summary: string;
  tagsJson?: string | null;
  importance?: number;
  embedding: Float32Array;
}): MemoryItem {
  const createdAt = new Date().toISOString();
  const importance = input.importance ?? 0.5;

  const insertItem = db.query(
    `INSERT INTO memory_items (workspace_key, type, text, summary, tags_json, importance, created_at)
     VALUES ($workspace_key, $type, $text, $summary, $tags_json, $importance, $created_at)
     RETURNING id, workspace_key, type, text, summary, tags_json, importance, created_at, last_used_at, superseded_by`
  );

  const row = insertItem.get({
    $workspace_key: input.workspaceKey,
    $type: input.type,
    $text: input.text,
    $summary: input.summary,
    $tags_json: input.tagsJson ?? null,
    $importance: importance,
    $created_at: createdAt,
  }) as any;

  const memoryId = Number(row.id);

  // Keep the vec table in sync.
  const insertVec = db.query(
    `INSERT INTO vec_memory (memory_id, workspace_key, type, embedding)
     VALUES ($memory_id, $workspace_key, $type, $embedding)`
  );

  // bun:sqlite can bind Float32Array directly (sqlite-vec Bun recipe).
  insertVec.run({
    $memory_id: memoryId,
    $workspace_key: input.workspaceKey,
    $type: input.type,
    $embedding: input.embedding,
  });

  return mapItemRow(row);
}

export function searchMemory(db: Database, input: {
  workspaceKey: string;
  queryEmbedding: Float32Array;
  topK?: number;
  type?: MemoryType;
}): SearchResult[] {
  const topK = Math.max(1, Math.min(50, input.topK ?? 8));

  // KNN query: must include "embedding match" and "k = N" in WHERE.
  // Docs: https://alexgarcia.xyz/sqlite-vec/features/vec0.html
  const stmt = db.query(
    `
    SELECT
      mi.id,
      mi.workspace_key,
      mi.type,
      mi.text,
      mi.summary,
      mi.tags_json,
      mi.importance,
      mi.created_at,
      mi.last_used_at,
      mi.superseded_by,
      vm.distance
    FROM vec_memory vm
    JOIN memory_items mi ON mi.id = vm.memory_id
    WHERE vm.embedding MATCH $q
      AND k = $k
      AND vm.workspace_key = $workspace_key
      ${input.type ? "AND vm.type = $type" : ""}
      AND mi.superseded_by IS NULL
    `
  );

  const rows = stmt.all({
    $q: input.queryEmbedding,
    $k: topK,
    $workspace_key: input.workspaceKey,
    ...(input.type ? { $type: input.type } : {}),
  }) as any[];

  const now = new Date().toISOString();
  const touch = db.query(`UPDATE memory_items SET last_used_at = $now WHERE id = $id`);

  const results: SearchResult[] = rows.map((r) => ({ ...mapItemRow(r), distance: Number(r.distance) }));
  for (const r of results) {
    touch.run({ $now: now, $id: r.id });
  }

  // Simple re-rank: combine distance with importance.
  // Distance is smaller=better.
  results.sort((a, b) => score(a) - score(b));
  return results;

  function score(r: SearchResult): number {
    const dist = r.distance;
    const imp = 1 - Math.max(0, Math.min(1, r.importance)); // higher importance => lower score
    return dist + imp * 0.15 * 0.05;
  }
}

export function supersedeMemory(db: Database, input: { id: number; supersededBy: number }): void {
  db.query(`UPDATE memory_items SET superseded_by = $superseded_by WHERE id = $id`).run({
    $id: input.id,
    $superseded_by: input.supersededBy,
  });
}

export function deleteMemory(db: Database, input: { id: number; workspaceKey?: string }): MemoryItem | null {
  const row = db
    .query(
      `SELECT id, workspace_key, type, text, summary, tags_json, importance, created_at, last_used_at, superseded_by
       FROM memory_items
       WHERE id = $id
       ${input.workspaceKey ? "AND workspace_key = $workspace_key" : ""}`
    )
    .get({
      $id: input.id,
      ...(input.workspaceKey ? { $workspace_key: input.workspaceKey } : {}),
    }) as any;

  if (!row) return null;

  db.query("BEGIN;").run();
  try {
    db.query(`DELETE FROM vec_memory WHERE memory_id = $id`).run({ $id: input.id });
    db.query(`DELETE FROM memory_items WHERE id = $id`).run({ $id: input.id });
    db.query("COMMIT;").run();
  } catch (err) {
    db.query("ROLLBACK;").run();
    throw err;
  }

  return mapItemRow(row);
}

function mapItemRow(row: any): MemoryItem {
  return {
    id: Number(row.id),
    workspaceKey: String(row.workspace_key),
    type: row.type as MemoryType,
    text: String(row.text),
    summary: String(row.summary),
    tagsJson: row.tags_json == null ? null : String(row.tags_json),
    importance: Number(row.importance),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
    supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
  };
}
