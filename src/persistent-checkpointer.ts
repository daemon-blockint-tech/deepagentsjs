/**
 * Persistent Checkpointer Factory
 *
 * Uses PostgresSaver when DATABASE_URL is available, falls back to
 * MemorySaver for local development without a database.
 *
 * The PostgresSaver persists agent state (including paused HITL
 * approvals) to Supabase Postgres, so pending approvals survive
 * server restarts.
 */
import process from "node:process"
import { MemorySaver } from "@langchain/langgraph"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"

export type Checkpointer = MemorySaver | PostgresSaver

let checkpointerInstance: Checkpointer | null = null
let setupPromise: Promise<Checkpointer> | null = null

/**
 * Build the Supabase Postgres connection string from env vars.
 *
 * Supabase exposes the pooler connection at:
 *   postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
 *
 * We construct it from NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD,
 * or use DATABASE_URL directly if provided.
 */
function getConnectionString(): string | null {
  // Direct override
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  // Construct from Supabase URL + password
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const dbPassword = process.env.SUPABASE_DB_PASSWORD
  if (!supabaseUrl || !dbPassword) return null

  // Extract project ref from URL: https://[ref].supabase.co
  const match = supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)
  if (!match) return null
  const projectRef = match[1]

  // Use the direct connection (not pooler) for LISTEN/NOTIFY support
  return `postgresql://postgres:${encodeURIComponent(dbPassword)}@db.${projectRef}.supabase.co:5432/postgres`
}

/**
 * Get (or lazily create) the checkpointer.
 *
 * On first call, if DATABASE_URL or Supabase credentials are available,
 * creates a PostgresSaver and runs .setup() to create the required
 * tables. Otherwise, falls back to MemorySaver.
 *
 * Memoized — the same checkpointer is reused across all agents.
 */
export async function getCheckpointer(): Promise<Checkpointer> {
  if (checkpointerInstance) return checkpointerInstance
  if (setupPromise) return setupPromise

  setupPromise = (async () => {
    const connString = getConnectionString()

    if (!connString) {
      console.warn(
        "[checkpointer] No DATABASE_URL or Supabase credentials found — " +
          "falling back to MemorySaver (pending approvals will be lost on restart)"
      )
      checkpointerInstance = new MemorySaver()
      return checkpointerInstance
    }

    try {
      // PostgresSaver manages its own connection pool internally
      const saver = PostgresSaver.fromConnString(connString)
      // Run setup to create checkpoint tables if they don't exist
      await saver.setup()

      console.info(
        "[checkpointer] PostgresSaver initialized — " +
          "agent state + pending approvals will persist across restarts"
      )

      checkpointerInstance = saver
      return checkpointerInstance
    } catch (err) {
      console.error(
        "[checkpointer] Failed to initialize PostgresSaver — " +
          "falling back to MemorySaver:",
        err instanceof Error ? err.message : String(err)
      )
      checkpointerInstance = new MemorySaver()
      return checkpointerInstance
    }
  })()

  return setupPromise
}
