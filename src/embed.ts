export type OllamaEmbedResponse = {
  embeddings: number[][];
};

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "embeddinggemma";

export async function embedText(
  input: string | string[],
): Promise<Float32Array[]> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const model = process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_MODEL;

  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Ollama /api/embed failed: ${res.status} ${res.statusText}${body ? `\n${body}` : ""}`,
    );
  }

  const json = (await res.json()) as OllamaEmbedResponse;
  if (!json?.embeddings?.length) {
    throw new Error("Ollama /api/embed returned no embeddings");
  }

  return json.embeddings.map((arr) => new Float32Array(arr));
}
