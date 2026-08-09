import process from "node:process";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluate } from "langsmith/evaluation";
import type { EvaluationResult } from "langsmith/evaluation";
import type { Example, Run } from "langsmith/schemas";
import { getCloneAgent } from "./agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

interface EvalInput {
  messages: Array<{ role: string; content: string }>;
}

interface EvalOutput {
  response: string;
}

const data: Example[] = [
  {
    id: "1",
    created_at: new Date().toISOString(),
    dataset_id: "",
    runs: [],
    inputs: { messages: [{ role: "user", content: "What is 2+2?" }] } as EvalInput,
    outputs: { response: "4" } as EvalOutput,
  },
  {
    id: "2",
    created_at: new Date().toISOString(),
    dataset_id: "",
    runs: [],
    inputs: { messages: [{ role: "user", content: "Translate 'hello' to French." }] } as EvalInput,
    outputs: { response: "bonjour" } as EvalOutput,
  },
  {
    id: "3",
    created_at: new Date().toISOString(),
    dataset_id: "",
    runs: [],
    inputs: { messages: [{ role: "user", content: "What is the capital of Japan?" }] } as EvalInput,
    outputs: { response: "Tokyo" } as EvalOutput,
  },
];

async function target(inputs: EvalInput): Promise<EvalOutput> {
  const agent = await getCloneAgent();
  const result = await agent.invoke(inputs);
  const messages = result?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  const content = last?.content ?? "";
  return { response: typeof content === "string" ? content : JSON.stringify(content) };
}

async function containsReference(args: {
  run: Run;
  example: Example;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
  attachments?: Record<string, unknown>;
}): Promise<EvaluationResult> {
  const response = String(args.outputs?.response ?? "").toLowerCase();
  const expected = String(args.referenceOutputs?.response ?? "").toLowerCase();
  const score = expected.length > 0 && response.includes(expected) ? 1 : 0;
  return { key: "contains_reference", score };
}

async function main() {
  await evaluate(target, {
    data,
    evaluators: [containsReference],
    experimentPrefix: "clone-chat-eval",
    maxConcurrency: 1,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
