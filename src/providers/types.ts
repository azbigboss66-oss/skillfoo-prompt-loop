export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelProvider = {
  name: string;
  chat(messages: ChatMessage[]): Promise<string>;
};
