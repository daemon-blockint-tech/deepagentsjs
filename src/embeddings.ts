import process from "node:process";

const OPENROUTER_EMBEDDING_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "openai/text-embedding-3-small";

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const model = process.env.OPENROUTER_EMBEDDING_MODEL || DEFAULT_MODEL;

  const res = await fetch(OPENROUTER_EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(process.env.OPENROUTER_APP_URL
        ? { "HTTP-Referer": process.env.OPENROUTER_APP_URL }
        : {}),
      ...(process.env.OPENROUTER_APP_TITLE
        ? { "X-Title": process.env.OPENROUTER_APP_TITLE }
        : {}),
    },
    body: JSON.stringify({
      input: text,
      model,
      encoding_format: "float",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding request failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const embedding = json.data?.[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new Error("Embedding response did not contain an embedding");
  }
  return embedding;
}
