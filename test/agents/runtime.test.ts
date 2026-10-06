import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { runAgentLoop, type LoopDeps, type Message } from "../../src/agents/runtime.ts";

const deps: LoopDeps = {
  provider: "gemini", apiKey: "fake-test-key", model: "test-model",
  system: "Report shop data accurately.", label: "test agent",
  tools: [{ name: "get_stock", description: "Read stock", input_schema: {
    type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"],
  } }],
  executeTool: async () => "Stock: 4",
};

function mockApi(t: TestContext, replies: unknown[], status = 200) {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    assert.ok(requests.length < replies.length, "Unexpected extra API request");
    const reply = replies[requests.length];
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json(reply, { status });
  };
  return requests;
}

const answer = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const toolCall = { candidates: [{ content: { parts: [{ functionCall: {
  id: "call-1", name: "get_stock", args: { product_id: "123" },
} }] } }] };

test("Gemini chat uses only the selected provider and keeps conversation context", async (t) => {
  const requests = mockApi(t, [answer("Hello seller")]);
  const history: Message[] = [{ role: "user", content: "Hello" }];
  assert.equal(await runAgentLoop(deps, history), "Hello seller");
  assert.match(requests[0].url, /generativelanguage.googleapis.com/);
  assert.equal(requests[0].headers.get("x-goog-api-key"), "fake-test-key");
  assert.equal(requests[0].headers.get("x-api-key"), null);
  assert.equal(history.at(-1)?.content, "Hello seller");
});

test("Gemini tool workflow executes the requested input and returns its result to the model", async (t) => {
  const requests = mockApi(t, [toolCall, answer("Stock is 4")]);
  const executed: unknown[] = [];
  const activity: string[] = [];
  const text = await runAgentLoop({ ...deps,
    executeTool: async (name, input) => { executed.push({ name, input }); return "Stock: 4"; },
    onTool: (name) => { activity.push(name); },
  }, [{ role: "user", content: "Check stock for 123" }]);
  assert.equal(text, "Stock is 4");
  assert.deepEqual(executed, [{ name: "get_stock", input: { product_id: "123" } }]);
  assert.deepEqual(activity, ["get_stock"]);
  assert.deepEqual(requests[1].body.contents.at(-1).parts, [{ functionResponse: {
    id: "call-1", name: "get_stock", response: { result: "Stock: 4" },
  } }]);
});

test("Tool failures reach the model as errors rather than successful shop data", async (t) => {
  const requests = mockApi(t, [toolCall, answer("Shop service unavailable")]);
  assert.equal(await runAgentLoop({ ...deps, executeTool: async () => {
    throw new Error("Shopee 503");
  } }, [{ role: "user", content: "Check stock" }]), "Shop service unavailable");
  assert.equal(requests[1].body.contents.at(-1).parts[0].functionResponse.response.result, "Error: Shopee 503");
});

test("Product photos are forwarded to Gemini as image data with their caption", async (t) => {
  const requests = mockApi(t, [answer("Draft ready")]);
  await runAgentLoop(deps, [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "fake-image" } },
    { type: "text", text: "Draft this product" },
  ] }]);
  assert.deepEqual(requests[0].body.contents[0].parts, [
    { inlineData: { mimeType: "image/png", data: "fake-image" } }, { text: "Draft this product" },
  ]);
});

test("Provider authentication errors fail without executing a shop tool", async (t) => {
  mockApi(t, [{ error: { message: "Invalid API key" } }], 403);
  let executed = false;
  await assert.rejects(runAgentLoop({ ...deps, executeTool: async () => {
    executed = true; return "unexpected";
  } }, [{ role: "user", content: "Check stock" }]), /Gemini API 403/);
  assert.equal(executed, false);
});

test("Anthropic remains available only when explicitly selected", async (t) => {
  const requests = mockApi(t, [{ stop_reason: "end_turn", content: [{ type: "text", text: "Hello" }] }]);
  assert.equal(await runAgentLoop({ ...deps, provider: "anthropic" }, [{ role: "user", content: "Hi" }]), "Hello");
  assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(requests[0].headers.get("x-api-key"), "fake-test-key");
});

test("Gemini signed parts survive tool follow-ups and later conversation turns verbatim", async (t) => {
  const signedParts = [
    { text: "internal reasoning", thought: true, thoughtSignature: "opaque-reasoning" },
    { functionCall: { id: "signed-call", name: "get_stock", args: { product_id: "123" } },
      thoughtSignature: "opaque-tool-signature" },
  ];
  const finalParts = [{ text: "Stock is 4", thoughtSignature: "opaque-answer" }];
  const requests = mockApi(t, [
    { candidates: [{ content: { parts: signedParts } }] },
    { candidates: [{ content: { parts: finalParts } }] },
    answer("Still 4"),
  ]);
  const history: Message[] = [{ role: "user", content: "Check stock" }];
  assert.equal(await runAgentLoop(deps, history), "Stock is 4");
  assert.deepEqual(requests[1].body.contents[1].parts, signedParts);
  assert.equal(requests[1].body.contents[2].parts[0].functionResponse.name, "get_stock");
  history.push({ role: "user", content: "What was the stock?" });
  await runAgentLoop(deps, history);
  assert.deepEqual(requests[2].body.contents[1].parts, signedParts);
  assert.deepEqual(requests[2].body.contents[3].parts, finalParts);
});
