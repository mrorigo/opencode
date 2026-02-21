import { OpenAIResponsesLanguageModel } from "@/provider/sdk/copilot/responses/openai-responses-language-model"
import { describe, test, expect, mock } from "bun:test"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"

async function collect<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader()
  const result: T[] = []
  while (true) {
    const value = await reader.read()
    if (value.done) return result
    result.push(value.value)
  }
}

const PROMPT: LanguageModelV2Prompt = [{ role: "user", content: [{ type: "text", text: "hello" }] }]

function createMockFetch(chunks: string[]) {
  return mock(async () => {
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk + "\n\n"))
        }
        controller.close()
      },
    })

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  })
}

describe("OpenAIResponsesLanguageModel.doStream", () => {
  test("ignores malformed reasoning done chunks without crashing", async () => {
    const mockFetch = createMockFetch([
      `data: {"type":"response.created","response":{"id":"resp_1","created_at":1771708609,"model":"openai/gpt-5-nano","service_tier":null}}`,
      `data: {"type":"response.output_item.done","output_index":"toString","item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc"}}`,
      `data: {"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":1,"output_tokens":2,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}},"service_tier":null}}`,
      `data: [DONE]`,
    ])

    const model = new OpenAIResponsesLanguageModel("gpt-5-nano", {
      provider: "copilot.responses",
      url: () => "https://api.test.com/responses",
      headers: () => ({ Authorization: "Bearer test-token" }),
      fetch: mockFetch as unknown as typeof fetch,
    })

    const { stream } = await model.doStream({
      prompt: PROMPT,
      includeRawChunks: false,
    })

    const parts = await collect(stream)
    const finish = parts.find((part) => part.type === "finish")
    const error = parts.find((part) => part.type === "error")

    expect(finish).toMatchObject({
      type: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    })
    expect(error).toBeUndefined()
  })
})
