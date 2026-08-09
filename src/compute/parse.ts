import process from "node:process";
import { embedText } from "../embeddings.js";

export interface ParseInput {
  mime_type: string;
  data: string; // base64 encoded file
  filename?: string;
}

export interface ParseResult {
  text: string;
  metadata: Record<string, unknown>;
  error?: string;
}

const SUPPORTED_IMAGE = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const SUPPORTED_DOCUMENT = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
];
const SUPPORTED_AUDIO = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/webm"];

/**
 * Compute module: parse image, PDF/DOCX, or audio into text + metadata.
 * Routes to the external COMPUTE_ENDPOINT (e.g. a Python/FastAPI service)
 * if configured; otherwise returns a structured stub so the agent can continue.
 */
export async function parseMultimodal(input: ParseInput): Promise<ParseResult> {
  const endpoint = process.env.COMPUTE_ENDPOINT;
  if (!endpoint) {
    return {
      text: `Stub parse for ${input.filename ?? "unnamed"} (${input.mime_type}). Set COMPUTE_ENDPOINT to a real parser.`,
      metadata: { mime_type: input.mime_type, stub: true },
    };
  }

  const res = await fetch(`${endpoint}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mime_type: input.mime_type,
      data: input.data,
      filename: input.filename,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Compute parse failed: ${res.status} ${body}`);
  }

  return (await res.json()) as ParseResult;
}

export async function parseImage(input: ParseInput) {
  if (!SUPPORTED_IMAGE.includes(input.mime_type)) {
    throw new Error(`Unsupported image type: ${input.mime_type}`);
  }
  return parseMultimodal(input);
}

export async function parseDocument(input: ParseInput) {
  if (!SUPPORTED_DOCUMENT.includes(input.mime_type)) {
    throw new Error(`Unsupported document type: ${input.mime_type}`);
  }
  return parseMultimodal(input);
}

export async function parseAudio(input: ParseInput) {
  if (!SUPPORTED_AUDIO.includes(input.mime_type)) {
    throw new Error(`Unsupported audio type: ${input.mime_type}`);
  }
  return parseMultimodal(input);
}

/**
 * Embed parsed multimodal content. For documents, this is the extracted text.
 * For images/audio, it is a generated caption or transcript (already in text).
 */
export async function embedMultimodal(input: ParseInput): Promise<number[]> {
  const parsed = await parseMultimodal(input);
  return embedText(parsed.text);
}
