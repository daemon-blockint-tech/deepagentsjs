/**
 * Read the agent's filesystem for a thread.
 *
 * The clone agent's backend is a CompositeBackend over StateBackend, so the
 * files the agent writes with write_file/edit_file live in LangGraph state
 * under the `files` key — not on disk and not in a container. These helpers
 * expose that state to the IDE frontend read-only; the agent remains the only
 * writer.
 */
import { getCloneAgent, threadConfig, DEFAULT_MODEL } from "./agent.js";

/** v1 stored content as lines, v2 as a string or bytes. Both still appear. */
interface StoredFile {
  content: string | string[] | Uint8Array;
  mimeType?: string;
  created_at?: string;
  modified_at?: string;
}

export interface ThreadFileEntry {
  path: string;
  name: string;
  size: number;
  /** Absent for binary files — the viewer shows a placeholder instead. */
  isBinary: boolean;
  modifiedAt?: string;
}

function isBinary(file: StoredFile): boolean {
  return file.content instanceof Uint8Array;
}

/** Normalize either storage format to text. Returns null for binary. */
function toText(file: StoredFile): string | null {
  if (file.content instanceof Uint8Array) return null;
  return Array.isArray(file.content) ? file.content.join("\n") : file.content;
}

async function readFilesFromState(
  threadId: string,
  model: string,
): Promise<Record<string, StoredFile>> {
  const agent = (await getCloneAgent(model)) as unknown as {
    graph?: { getState: (config: unknown) => Promise<{ values?: unknown }> };
  };
  if (!agent.graph?.getState) return {};

  const snapshot = await agent.graph.getState(threadConfig(threadId));
  const values = snapshot?.values as
    | { files?: Record<string, StoredFile> }
    | undefined;
  return values?.files ?? {};
}

/**
 * Flat list of every file the agent has written on this thread.
 *
 * The tree is built client-side from the paths — StateBackend has no real
 * directories, so there is nothing to walk.
 */
export async function listThreadFiles(
  threadId: string,
  model = DEFAULT_MODEL,
): Promise<ThreadFileEntry[]> {
  const files = await readFilesFromState(threadId, model);

  return Object.entries(files)
    .map(([path, file]) => {
      const text = toText(file);
      return {
        path,
        name: path.split("/").filter(Boolean).pop() ?? path,
        size:
          text !== null
            ? Buffer.byteLength(text, "utf8")
            : (file.content as Uint8Array).byteLength,
        isBinary: isBinary(file),
        modifiedAt: file.modified_at,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface ThreadFileContent {
  path: string;
  content: string | null;
  isBinary: boolean;
  modifiedAt?: string;
}

/** Returns null when the thread has no such file. */
export async function readThreadFile(
  threadId: string,
  filePath: string,
  model = DEFAULT_MODEL,
): Promise<ThreadFileContent | null> {
  const files = await readFilesFromState(threadId, model);
  const file = files[filePath];
  if (!file) return null;

  return {
    path: filePath,
    content: toText(file),
    isBinary: isBinary(file),
    modifiedAt: file.modified_at,
  };
}
