import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { embedWithOllama } from "./ollama";
import {
  openDb,
  saveMemory,
  searchMemory,
  supersedeMemory,
  deleteMemory,
  type MemoryType,
} from "./db";

const server = new McpServer({
  name: "local-memory-mcp",
  version: "0.1.0",
});

const db = openDb();

const MemoryTypeSchema = z.enum([
  "decision",
  "preference",
  "fact",
  "gotcha",
  "todo",
  "api_contract",
]);

function workspaceKeyFrom(input?: string) {
  return (
    input ??
    process.env.WORKSPACE_KEY ??
    // safe fallback
    "default"
  );
}

server.registerTool(
  "memory.ping",
  { inputSchema: {} },
  async () => {
    const { v } = db.query("select vec_version() as v;").get() as any;
    return {
      content: [
        {
          type: "text",
          text: `ok\nvec_version=${v}\ndb=${process.env.MEMORY_DB_PATH ?? "./data/memory.db"}`,
        },
      ],
    };
  }
);

server.registerTool(
  "memory.search",
  {
    inputSchema: {
      query: z.string().min(1),
      topK: z.number().int().min(1).max(50).optional(),
      workspaceKey: z.string().min(1).optional(),
      type: MemoryTypeSchema.optional(),
    },
  },
  async ({ query, topK, workspaceKey, type }) => {
    const ws = workspaceKeyFrom(workspaceKey);

    const [qEmbedding] = await embedWithOllama({ input: query });

    const results = searchMemory(db, {
      workspaceKey: ws,
      queryEmbedding: qEmbedding,
      topK,
      type: type as MemoryType | undefined,
    });

    const lines = results.map(
      (r) =>
        `- (#${r.id}, ${r.type}, dist=${r.distance.toFixed(4)}) ${r.summary.replace(/\s+/g, " ")}`
    );

    const payload = {
      workspaceKey: ws,
      query,
      count: results.length,
      items: results.map((r) => ({
        id: r.id,
        type: r.type,
        summary: r.summary,
        text: r.text,
        tagsJson: r.tagsJson,
        importance: r.importance,
        createdAt: r.createdAt,
        distance: r.distance,
      })),
    };

    return {
      content: [
        {
          type: "text",
          text:
            (lines.length
              ? `Relevant memories (workspace=${ws}):\n${lines.join("\n")}`
              : `No memories found (workspace=${ws}).`) +
            `\n\nJSON:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    };
  }
);

server.registerTool(
  "memory.save",
  {
    inputSchema: {
      workspaceKey: z.string().min(1).optional(),
      type: MemoryTypeSchema,
      text: z.string().min(1),
      summary: z
        .string()
        .min(1)
        .max(300)
        .describe("1–2 lines, intended for prompt injection"),
      tags: z.array(z.string().min(1)).optional(),
      importance: z.number().min(0).max(1).optional(),
    },
  },
  async ({ workspaceKey, type, text, summary, tags, importance }) => {
    const ws = workspaceKeyFrom(workspaceKey);

    // Embed the full text (or you can embed summary + text). Keep it simple.
    const [embedding] = await embedWithOllama({ input: text });

    const item = saveMemory(db, {
      workspaceKey: ws,
      type: type as MemoryType,
      text,
      summary,
      tagsJson: tags?.length ? JSON.stringify(tags) : null,
      importance,
      embedding,
    });

    return {
      content: [
        {
          type: "text",
          text: `Saved memory #${item.id} (workspace=${ws}, type=${item.type}).\nSummary: ${item.summary}`,
        },
      ],
    };
  }
);

server.registerTool(
  "memory.supersede",
  {
    inputSchema: {
      id: z.number().int().positive(),
      supersededBy: z.number().int().positive(),
    },
  },
  async ({ id, supersededBy }) => {
    supersedeMemory(db, { id, supersededBy });
    return {
      content: [
        {
          type: "text",
          text: `Marked memory #${id} as superseded by #${supersededBy}.`,
        },
      ],
    };
  }
);

server.registerTool(
  "memory.delete",
  {
    inputSchema: {
      id: z.number().int().positive(),
      workspaceKey: z.string().min(1).optional(),
    },
  },
  async ({ id, workspaceKey }) => {
    const ws = workspaceKeyFrom(workspaceKey);
    const deleted = deleteMemory(db, { id, workspaceKey: ws });

    if (!deleted) {
      return {
        content: [
          {
            type: "text",
            text: `Memory #${id} not found in workspace=${ws}.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Deleted memory #${deleted.id} (workspace=${deleted.workspaceKey}, type=${deleted.type}).`,
        },
      ],
    };
  }
);

// Start stdio transport (for VS Code MCP / Claude Desktop style integrations)
const transport = new StdioServerTransport();
await server.connect(transport);
