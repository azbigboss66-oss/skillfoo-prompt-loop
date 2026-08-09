import type { ChatMessage, ModelProvider } from "./types.js";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
}

/**
 * Create an OpenAI-compatible API provider.
 *
 * Reads baseUrl, apiKeyEnv, and model from config.
 * If the API key is missing from the environment, throws a clear error.
 *
 * The endpoint must implement the OpenAI Chat Completions request and response
 * contract. Provider-specific protocols are intentionally not guessed here.
 */
export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig
): ModelProvider {
  const apiKey = process.env[config.apiKeyEnv];

  if (!apiKey) {
    throw new Error(`Missing API key env: ${config.apiKeyEnv}`);
  }

  return {
    name: "openai-compatible",
    async chat(messages: ChatMessage[]): Promise<string> {
      const url = `${config.baseUrl}/chat/completions`;

      const body: Record<string, unknown> = {
        model: config.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `API request failed: ${response.status} ${response.statusText}` +
            (text ? ` - ${text}` : "")
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(
          "API response is not OpenAI Chat Completions compatible: choices[0].message.content is missing.",
        );
      }
      return content;
    },
  };
}
