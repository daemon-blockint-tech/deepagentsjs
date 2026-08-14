import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { getQuickJS } from "quickjs-emscripten";

export interface EvalInput {
  code: string;
  timeout_ms?: number;
}

export async function runJavaScript({
  code,
  timeout_ms = 5000,
}: EvalInput): Promise<string> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  const context = runtime.newContext();

  const timeout = setTimeout(() => {
    context.dispose();
    runtime.dispose();
  }, timeout_ms);

  try {
    const result = context.evalCode(code);
    clearTimeout(timeout);

    if (result.error) {
      const err = context.dump(result.error);
      result.error.dispose();
      context.dispose();
      runtime.dispose();
      return JSON.stringify({ error: err, code });
    }

    const value = context.dump(result.value);
    result.value.dispose();
    context.dispose();
    runtime.dispose();
    return JSON.stringify({ result: value });
  } catch (error) {
    clearTimeout(timeout);
    context.dispose();
    runtime.dispose();
    return JSON.stringify({ error: (error as Error).message });
  }
}

export const evalTool = tool(
  async ({ code, timeout_ms }) => {
    return await runJavaScript({ code, timeout_ms });
  },
  {
    name: "eval",
    description:
      "Run JavaScript code in an isolated QuickJS interpreter. Use for in-memory computation, loops, or data transforms.",
    schema: z.object({
      code: z.string().describe("JavaScript code to evaluate"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds"),
    }),
  },
);
