/**
 * LLM connectivity check for the configured provider.
 *
 *   LLM_PROVIDER=ollama LLM_MODEL=llama3.1 npm run ai:check
 *   LLM_PROVIDER=anthropic LLM_MODEL=<model> LLM_API_KEY=... npm run ai:check
 *
 * Sends a tiny prompt and reports latency/token usage. Exit code 0 = reachable.
 * Never prints the API key.
 */
import { createLlmProvider } from '../src/ai/providers/index.js';
import { getConfig } from '../src/config/index.js';

async function main(): Promise<void> {
  const { llm } = getConfig();
  console.log(
    `provider=${llm.provider} model=${llm.model ?? '(unset)'} baseUrl=${llm.baseUrl ?? '(default)'} apiKey=${llm.apiKey ? 'set' : 'not set'}`,
  );
  const provider = createLlmProvider({ ...llm, maxRetries: 0 });
  const response = await provider.generate({
    systemPrompt: 'You are a connectivity probe. Reply with exactly: OK',
    userPrompt: 'Reply with OK.',
    maxTokens: 10,
    temperature: 0,
  });
  console.log(
    `reply="${response.content.trim().slice(0, 50)}" model=${response.model} latency=${response.latencyMs}ms ` +
      `tokens(in/out)=${response.inputTokens ?? '?'}/${response.outputTokens ?? '?'}`,
  );
}

main().catch((error: unknown) => {
  console.error(`LLM check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
