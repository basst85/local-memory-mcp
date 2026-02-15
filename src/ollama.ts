export type OllamaEmbedResponse = {
  embeddings: number[][];
};

export type EmbedOptions = {
  baseUrl?: string; // default http://localhost:11434
  model?: string; // default embeddinggemma
  input: string | string[];
  signal?: AbortSignal;
};

/**
 * Calls Ollama's /api/embed endpoint.
 * Docs: https://docs.ollama.com/capabilities/embeddings
 */
export async function embedWithOllama(opts: EmbedOptions): Promise<Float32Array[]> {
  const baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = opts.model ?? process.env.OLLAMA_EMBED_MODEL ?? "embeddinggemma";

  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: opts.input }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/embed failed: ${res.status} ${res.statusText}${body ? `\n${body}` : ""}`);
  }

  const json = (await res.json()) as OllamaEmbedResponse;
  if (!json?.embeddings?.length) {
    throw new Error("Ollama /api/embed returned no embeddings");
  }

  return json.embeddings.map((arr) => new Float32Array(arr));
}
