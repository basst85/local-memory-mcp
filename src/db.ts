import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const zvec = require("@zvec/zvec") as typeof import("@zvec/zvec");

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

export type MemoryDb = {
  collection: import("@zvec/zvec").ZVecCollection;
  path: string;
  dimension: number;
  idSeed: number;
};

const DEFAULT_DB_PATH = "./data/memory.zvec";
const DEFAULT_DIM = 768;

export function openDb(
  dbPath = process.env.MEMORY_DB_PATH ?? DEFAULT_DB_PATH,
): MemoryDb {
  const normalizedPath = normalizePath(dbPath);
  mkdirSync(dirname(normalizedPath), { recursive: true });

  const dimension = Number(process.env.EMBEDDING_DIM ?? DEFAULT_DIM);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error("Invalid EMBEDDING_DIM");
  }

  let collection: import("@zvec/zvec").ZVecCollection;
  if (existsSync(normalizedPath)) {
    collection = zvec.ZVecOpen(normalizedPath);
  } else {
    const schema = new zvec.ZVecCollectionSchema({
      name: "memory",
      vectors: {
        name: "embedding",
        dataType: zvec.ZVecDataType.VECTOR_FP32,
        dimension,
      },
      fields: [
        { name: "id", dataType: zvec.ZVecDataType.INT64 },
        { name: "workspaceKey", dataType: zvec.ZVecDataType.STRING },
        { name: "type", dataType: zvec.ZVecDataType.STRING },
        { name: "text", dataType: zvec.ZVecDataType.STRING },
        { name: "summary", dataType: zvec.ZVecDataType.STRING },
        {
          name: "tagsJson",
          dataType: zvec.ZVecDataType.STRING,
          nullable: true,
        },
        { name: "importance", dataType: zvec.ZVecDataType.DOUBLE },
        { name: "createdAt", dataType: zvec.ZVecDataType.STRING },
        {
          name: "lastUsedAt",
          dataType: zvec.ZVecDataType.STRING,
          nullable: true,
        },
        { name: "supersededBy", dataType: zvec.ZVecDataType.INT64 },
      ],
    });

    collection = zvec.ZVecCreateAndOpen(normalizedPath, schema);
  }

  return {
    collection,
    path: normalizedPath,
    dimension,
    idSeed: Date.now() * 1000,
  };
}

export function saveMemory(
  db: MemoryDb,
  input: {
    workspaceKey: string;
    type: MemoryType;
    text: string;
    summary: string;
    tagsJson?: string | null;
    importance?: number;
    embedding: Float32Array;
  },
): MemoryItem {
  ensureEmbeddingDim(input.embedding, db.dimension);

  const id = nextId(db);
  const createdAt = new Date().toISOString();
  const importance = input.importance ?? 0.5;

  const status = db.collection.insertSync({
    id: String(id),
    vectors: { embedding: input.embedding },
    fields: {
      id,
      workspaceKey: input.workspaceKey,
      type: input.type,
      text: input.text,
      summary: input.summary,
      tagsJson: input.tagsJson ?? "",
      importance,
      createdAt,
      lastUsedAt: "",
      supersededBy: 0,
    },
  });
  ensureStatusOk(status, "insertSync");

  return {
    id,
    workspaceKey: input.workspaceKey,
    type: input.type,
    text: input.text,
    summary: input.summary,
    tagsJson: input.tagsJson ?? null,
    importance,
    createdAt,
    lastUsedAt: null,
    supersededBy: null,
  };
}

export function searchMemory(
  db: MemoryDb,
  input: {
    workspaceKey: string;
    queryEmbedding: Float32Array;
    topK?: number;
    type?: MemoryType;
  },
): SearchResult[] {
  ensureEmbeddingDim(input.queryEmbedding, db.dimension);

  const topK = Math.max(1, Math.min(50, input.topK ?? 8));
  const filterParts = [
    `workspaceKey = '${escapeForFilter(input.workspaceKey)}'`,
    "supersededBy = 0",
  ];
  if (input.type) {
    filterParts.push(`type = '${escapeForFilter(input.type)}'`);
  }

  let docs: import("@zvec/zvec").ZVecDoc[] = [];
  try {
    docs = db.collection.querySync({
      fieldName: "embedding",
      vector: input.queryEmbedding,
      topk: topK,
      filter: filterParts.join(" AND "),
      outputFields: [
        "id",
        "workspaceKey",
        "type",
        "text",
        "summary",
        "tagsJson",
        "importance",
        "createdAt",
        "lastUsedAt",
        "supersededBy",
      ],
    });
  } catch {
    docs = db.collection.querySync({
      fieldName: "embedding",
      vector: input.queryEmbedding,
      topk: 200,
      outputFields: [
        "id",
        "workspaceKey",
        "type",
        "text",
        "summary",
        "tagsJson",
        "importance",
        "createdAt",
        "lastUsedAt",
        "supersededBy",
      ],
    });
    docs = docs
      .filter((doc) => {
        const fields = doc.fields ?? {};
        const sameWorkspace =
          String(fields.workspaceKey ?? "") === input.workspaceKey;
        const sameType = input.type
          ? String(fields.type ?? "") === input.type
          : true;
        const active = Number(fields.supersededBy ?? 0) === 0;
        return sameWorkspace && sameType && active;
      })
      .slice(0, topK);
  }

  const now = new Date().toISOString();
  const results: SearchResult[] = docs.map((doc) => {
    const row = mapDocToItem(doc);
    return {
      ...row,
      distance: 1 - Number(doc.score ?? 0),
    };
  });

  for (const r of results) {
    try {
      db.collection.updateSync({
        id: String(r.id),
        fields: {
          lastUsedAt: now,
        },
      });
      r.lastUsedAt = now;
    } catch {
      // best effort
    }
  }

  results.sort((a, b) => score(a) - score(b));
  return results;

  function score(r: SearchResult): number {
    const dist = r.distance;
    const imp = 1 - Math.max(0, Math.min(1, r.importance));
    return dist + imp * 0.15 * 0.05;
  }
}

export function supersedeMemory(
  db: MemoryDb,
  input: { id: number; supersededBy: number },
): void {
  const doc = findOneByMemoryId(db, input.id);
  if (!doc) return;

  db.collection.updateSync({
    id: doc.id,
    fields: {
      supersededBy: input.supersededBy,
    },
  });
}

export function deleteMemory(
  db: MemoryDb,
  input: { id: number; workspaceKey?: string },
): MemoryItem | null {
  const doc = findOneByMemoryId(db, input.id);
  if (!doc) return null;

  const item = mapDocToItem(doc);
  if (input.workspaceKey && item.workspaceKey !== input.workspaceKey) {
    return null;
  }

  const status = db.collection.deleteSync(doc.id);
  ensureStatusOk(status, "deleteSync");
  return item;
}

function findOneByMemoryId(
  db: MemoryDb,
  id: number,
): import("@zvec/zvec").ZVecDoc | null {
  const docs = db.collection.querySync({
    filter: `id = ${id}`,
    topk: 1,
    outputFields: [
      "id",
      "workspaceKey",
      "type",
      "text",
      "summary",
      "tagsJson",
      "importance",
      "createdAt",
      "lastUsedAt",
      "supersededBy",
    ],
  });
  return docs.length ? docs[0] : null;
}

function mapDocToItem(doc: import("@zvec/zvec").ZVecDoc): MemoryItem {
  const fields = doc.fields ?? {};
  const supersededBy = Number(fields.supersededBy ?? 0);

  return {
    id: Number(fields.id ?? doc.id),
    workspaceKey: String(fields.workspaceKey ?? "default"),
    type: String(fields.type ?? "fact") as MemoryType,
    text: String(fields.text ?? ""),
    summary: String(fields.summary ?? ""),
    tagsJson: String(fields.tagsJson ?? "") || null,
    importance: Number(fields.importance ?? 0.5),
    createdAt: String(fields.createdAt ?? new Date(0).toISOString()),
    lastUsedAt: String(fields.lastUsedAt ?? "") || null,
    supersededBy: supersededBy > 0 ? supersededBy : null,
  };
}

function nextId(db: MemoryDb): number {
  db.idSeed += 1;
  return db.idSeed;
}

function ensureStatusOk(
  status: import("@zvec/zvec").ZVecStatus,
  operation: string,
) {
  if (!status.ok) {
    throw new Error(
      `${operation} failed: ${status.code} ${status.message}`.trim(),
    );
  }
}

function ensureEmbeddingDim(embedding: Float32Array, expected: number) {
  if (embedding.length !== expected) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expected}, got ${embedding.length}`,
    );
  }
}

function normalizePath(path: string): string {
  if (path.endsWith(".db")) {
    return path.replace(/\.db$/, ".zvec");
  }
  return path;
}

function escapeForFilter(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
