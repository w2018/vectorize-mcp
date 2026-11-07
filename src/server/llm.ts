/** 极简 OpenAI 兼容对话客户端：只用于「记忆整理」调用通用大模型，不涉及任何向量。 */
export interface ChatModelOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 推理型模型可降档，避免思考 token 吃满上限后 content 为空或请求超时。 */
  reasoningEffort?: "low" | "high";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class ChatModel {
  constructor(private readonly options: ChatModelOptions) {}

  get descriptor() {
    return { baseUrl: this.options.baseUrl, model: this.options.model };
  }

  async chat(messages: ChatMessage[], maxTokens = 1024): Promise<string> {
    const url =
      this.options.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 60000,
    );
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.options.apiKey)
        headers.authorization = "Bearer " + this.options.apiKey;
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: 0,
          max_tokens: maxTokens,
          ...(this.options.reasoningEffort
            ? { reasoning_effort: this.options.reasoningEffort }
            : {}),
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          /* keep raw text */
        }
        throw new Error("模型服务返回 HTTP " + res.status + "：" + detail);
      }
      let body: {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      } = {};
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("模型返回的不是合法 JSON");
      }
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        const finish = body.choices?.[0]?.finish_reason;
        throw new Error(
          "模型没有返回内容" +
            (finish ? "（finish_reason=" + finish + "）" : "") +
            "；若为推理模型，请降低推理档位或提高 max_tokens。",
        );
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
