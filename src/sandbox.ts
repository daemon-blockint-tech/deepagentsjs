import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { tool } from "@langchain/core/tools";

const execFileAsync = promisify(execFile);

const SANDBOX_ENABLED = process.env.SANDBOX_ENABLED === "true";

// Restricted command allowlist. Only these base commands can be executed.
const ALLOWED_COMMANDS = new Set([
  "node",
  "python",
  "python3",
  "git",
  "ls",
  "cat",
  "echo",
  "pwd",
  "which",
]);

const BLOCKED_PATTERNS = [
  /[;&|`$]/,
  />></,
  />[^>]/,
  /<[^<]/,
  /\$\(/,
  /\`/,
];

function isCommandAllowed(command: string): boolean {
  const base = command.trim().split(/\s+/)[0];
  if (!ALLOWED_COMMANDS.has(base)) return false;
  if (BLOCKED_PATTERNS.some((p) => p.test(command))) return false;
  return true;
}

export interface ExecuteInput {
  command: string;
  timeoutMs?: number;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a shell command in a restricted local sandbox.
 * Disabled unless SANDBOX_ENABLED=true.
 */
export async function executeCommand(input: ExecuteInput): Promise<ExecuteResult> {
  if (!SANDBOX_ENABLED) {
    throw new Error(
      "Sandbox is disabled. Set SANDBOX_ENABLED=true to enable restricted command execution."
    );
  }

  if (!isCommandAllowed(input.command)) {
    throw new Error(`Command not allowed: ${input.command}`);
  }

  const [cmd, ...args] = input.command.trim().split(/\s+/);
  const timeout = input.timeoutMs ?? 30000;

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      cwd: process.env.SANDBOX_CWD || process.cwd(),
      shell: false,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout || "",
      stderr: execError.stderr || "",
      exitCode: execError.code ?? 1,
    };
  }
}

export const executeTool = tool(
  async ({ command, timeout_ms }) => {
    const result = await executeCommand({ command, timeoutMs: timeout_ms });
    return JSON.stringify(result);
  },
  {
    name: "run_shell",
    description:
      "Run a restricted shell command in a sandbox. Only enabled when SANDBOX_ENABLED=true.",
    schema: z.object({
      command: z.string().describe("The command to run"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds"),
    }),
  }
);
