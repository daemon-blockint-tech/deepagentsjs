import process from "node:process";
import { parseMultimodal } from "./compute/parse.js";

export interface DocumentPayload {
  name: string;
  type: string;
  content: string; // base64 encoded
}

export interface ParsedDocument {
  name: string;
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

const ENDPOINT = process.env.UDOP_ENDPOINT;
const API_KEY = process.env.UDOP_API_KEY;

/**
 * Parse a document using a remote UDOP-compatible endpoint.
 *
 * If UDOP_ENDPOINT is not set, the function extracts plain text for
 * text files and JSON content for JSON files. Other types return a note.
 */
export async function parseDocument(
  doc: DocumentPayload,
): Promise<ParsedDocument> {
  if (ENDPOINT) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        name: doc.name,
        mime_type: doc.type,
        content: doc.content,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`UDOP parse failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as {
      text?: string;
      metadata?: Record<string, unknown>;
    };
    return {
      name: doc.name,
      type: doc.type,
      text: json.text ?? "",
      metadata: json.metadata,
    };
  }

  // Try compute/parse for image, audio, PDF, DOCX
  const parsed = await parseMultimodal({
    mime_type: doc.type,
    data: doc.content,
    filename: doc.name,
  });
  if (parsed.text && !parsed.error) {
    return {
      name: doc.name,
      type: doc.type,
      text: parsed.text,
      metadata: parsed.metadata,
    };
  }

  // Fallback: handle plain text and JSON locally
  if (doc.type === "text/plain") {
    return {
      name: doc.name,
      type: doc.type,
      text: Buffer.from(doc.content, "base64").toString("utf-8"),
    };
  }

  if (doc.type === "application/json") {
    const text = Buffer.from(doc.content, "base64").toString("utf-8");
    return {
      name: doc.name,
      type: doc.type,
      text,
    };
  }

  return {
    name: doc.name,
    type: doc.type,
    text: `[Document "${doc.name}" is attached but could not be parsed. Set UDOP_ENDPOINT or COMPUTE_ENDPOINT to enable document understanding.]`,
  };
}

export async function parseDocuments(
  docs: DocumentPayload[],
): Promise<ParsedDocument[]> {
  if (docs.length === 0) return [];
  return Promise.all(docs.map((doc) => parseDocument(doc)));
}
