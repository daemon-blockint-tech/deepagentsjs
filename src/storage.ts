import crypto from "node:crypto";
import { getSupabaseClient } from "./supabase.js";

const BUCKETS = {
  media: process.env.STORAGE_MEDIA_BUCKET || "media",
  documents: process.env.STORAGE_DOCUMENTS_BUCKET || "documents",
};

function getBucket(type: "media" | "documents"): string {
  return BUCKETS[type];
}

async function ensureBucket(name: string) {
  const supabase = getSupabaseClient();
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.some((b) => b.name === name)) {
    const { error } = await supabase.storage.createBucket(name, {
      public: false,
    });
    if (error) throw new Error(error.message);
  }
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export interface StorageUploadInput {
  workspace_id: string;
  type: "media" | "documents";
  file_name: string;
  mime_type: string;
  data: Uint8Array | string; // base64 string or raw bytes
  object_id?: string;
}

export interface StorageUploadResult {
  id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  url: string;
}

/**
 * Upload a file to Supabase Storage (S3-compatible) and record it in
 * `media_objects` or `documents`. Accepts raw bytes or base64 string.
 */
export async function uploadFile(
  input: StorageUploadInput,
): Promise<StorageUploadResult> {
  const supabase = getSupabaseClient();
  const bucket = getBucket(input.type);
  await ensureBucket(bucket);

  const bytes =
    typeof input.data === "string"
      ? Uint8Array.from(Buffer.from(input.data, "base64"))
      : input.data;

  const path = `${input.workspace_id}/${crypto.randomUUID()}${getFileExtension(
    input.file_name,
  )}`;

  const { data: uploadData, error } = await supabase.storage
    .from(bucket)
    .upload(path, bytes, {
      contentType: input.mime_type,
      upsert: false,
    });

  if (error) throw new Error(error.message);

  const { data: signed } = await supabase.storage
    .from(bucket)
    .createSignedUrl(uploadData.path, 3600);

  const file_path = uploadData.path;
  const size_bytes = bytes.length;

  const record = {
    workspace_id: input.workspace_id,
    object_id: input.object_id,
    file_path,
    file_name: input.file_name,
    mime_type: input.mime_type,
    size_bytes,
  };

  let id: string;

  if (input.type === "media") {
    const { data, error: insertError } = await supabase
      .from("media_objects")
      .insert(record)
      .select("id")
      .single();
    if (insertError || !data)
      throw new Error(insertError?.message || "Insert failed");
    id = data.id;
  } else {
    const { data, error: insertError } = await supabase
      .from("documents")
      .insert(record)
      .select("id")
      .single();
    if (insertError || !data)
      throw new Error(insertError?.message || "Insert failed");
    id = data.id;
  }

  return {
    id,
    file_path,
    file_name: input.file_name,
    mime_type: input.mime_type,
    size_bytes,
    url: signed?.signedUrl || "",
  };
}

export interface StorageDownloadInput {
  type: "media" | "documents";
  id: string;
}

export async function downloadFile(input: StorageDownloadInput): Promise<{
  url: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}> {
  const supabase = getSupabaseClient();
  const bucket = getBucket(input.type);

  const table = input.type === "media" ? "media_objects" : "documents";
  const { data: row, error } = await supabase
    .from(table)
    .select("file_path, file_name, mime_type, size_bytes")
    .eq("id", input.id)
    .single();

  if (error || !row) throw new Error(error?.message || "File not found");

  const { data: signed } = await supabase.storage
    .from(bucket)
    .createSignedUrl(row.file_path, 3600);

  return {
    url: signed?.signedUrl || "",
    file_path: row.file_path,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
  };
}

export async function deleteFile(
  type: "media" | "documents",
  id: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  const bucket = getBucket(type);
  const table = type === "media" ? "media_objects" : "documents";

  const { data: row, error } = await supabase
    .from(table)
    .select("file_path")
    .eq("id", id)
    .single();

  if (error || !row) throw new Error(error?.message || "File not found");

  const { error: removeError } = await supabase.storage
    .from(bucket)
    .remove([row.file_path]);

  if (removeError) throw new Error(removeError.message);

  const { error: deleteError } = await supabase
    .from(table)
    .delete()
    .eq("id", id);
  if (deleteError) throw new Error(deleteError.message);
}
