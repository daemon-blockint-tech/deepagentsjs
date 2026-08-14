import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const enabled = Boolean(
  process.env.SUPABASE_TEST_URL &&
  process.env.SUPABASE_TEST_ANON_KEY &&
  process.env.SUPABASE_TEST_SERVICE_KEY,
);

describe.skipIf(!enabled)("Supabase RLS", () => {
  let anonClient: SupabaseClient;
  let serviceClient: SupabaseClient;

  beforeAll(async () => {
    const url = process.env.SUPABASE_TEST_URL!;
    const anonKey = process.env.SUPABASE_TEST_ANON_KEY!;
    const serviceKey = process.env.SUPABASE_TEST_SERVICE_KEY!;

    anonClient = createClient(url, anonKey);
    serviceClient = createClient(url, serviceKey);

    const { data: existing } = await serviceClient
      .from("workspaces")
      .select("id")
      .eq("slug", "test-workspace")
      .single();

    if (!existing) {
      await serviceClient.from("workspaces").insert({
        slug: "test-workspace",
        name: "Test Workspace",
      });
    }
  });

  it("anon cannot read workspace_members", async () => {
    const { data, error } = await anonClient
      .from("workspace_members")
      .select("*");
    expect(error).toBeTruthy();
    expect(data).toBeNull();
  });

  it("service role can read workspace_members", async () => {
    const { data, error } = await serviceClient
      .from("workspace_members")
      .select("*");
    expect(error).toBeNull();
    expect(data).toBeDefined();
  });
});
