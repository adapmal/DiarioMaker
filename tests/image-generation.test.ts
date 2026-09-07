import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { generateGoogleImage, generateOpenAiImage, ImageRequestError, openAiImageSize, resolveImageModel } from "../server/imageGeneration";

const reference = { mimeType: "image/png", data: "cmVmZXJlbmNl" };

test("explicit model IDs survive dispatch; text/invalid models are rejected", () => {
  for (const id of ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "imagen-4.0-generate-001"]) {
    assert.deepEqual(resolveImageModel(id), { provider: "google", model: id });
  }
  assert.deepEqual(resolveImageModel("openai:gpt-image-1.5"), { provider: "openai", model: "gpt-image-1.5" });
  assert.equal(resolveImageModel("chatgpt-image-latest").provider, "openai");
  assert.equal(resolveImageModel("chatgpt_dalle3", "dall-e-3").model, "dall-e-3");
  assert.equal(resolveImageModel("nano_banana").model, "gemini-2.5-flash-image");
  assert.throws(() => resolveImageModel("gemini-2.5-flash"), ImageRequestError);
  assert.throws(() => resolveImageModel("openai:gemini-2.5-flash-image"), ImageRequestError);
  assert.throws(() => resolveImageModel({}), ImageRequestError);
});

test("Gemini receives exact prompt, reference and ratio; thought images are skipped", async () => {
  let sent: any;
  const ai = { models: { generateContent: async (request: any) => {
    sent = request;
    return { candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: "image/png", data: "intermediate" } },
      { inlineData: { mimeType: "image/png", data: "final" } },
    ] } }] };
  } } } as any;
  assert.equal(await generateGoogleImage(ai, "gemini-3-pro-image-preview", "My precise prompt", reference), "data:image/png;base64,final");
  assert.equal(sent.model, "gemini-3-pro-image-preview");
  assert.deepEqual(sent.contents[0].parts, [{ text: "My precise prompt" }, { inlineData: reference }]);
  assert.equal(sent.config.imageConfig.aspectRatio, "16:9");
});

test("Imagen preserves selected model; unsupported reference fails before API request", async () => {
  let calls = 0;
  const ai = { models: { generateImages: async (request: any) => {
    calls++; assert.equal(request.model, "imagen-4.0-generate-001");
    return { generatedImages: [{ image: { imageBytes: "image", mimeType: "image/jpeg" } }] };
  } } } as any;
  assert.equal(await generateGoogleImage(ai, "imagen-4.0-generate-001", "prompt", null), "data:image/jpeg;base64,image");
  await assert.rejects(generateGoogleImage(ai, "imagen-4.0-generate-001", "prompt", reference), ImageRequestError);
  assert.equal(calls, 1);
});

test("OpenAI sends reference bytes as multipart to edits and preserves the model", async () => {
  const request = async (url: any, init: any) => {
    assert.equal(url, "https://api.openai.com/v1/images/edits");
    assert.equal(init.headers.Authorization, "Bearer fake-test-key");
    assert.equal(init.headers["Content-Type"], undefined);
    assert.equal(init.body.get("model"), "gpt-image-1.5");
    assert.equal(init.body.get("size"), "1536x1024");
    assert.equal(await init.body.get("image").text(), "reference");
    return Response.json({ data: [{ b64_json: "result" }] });
  };
  assert.equal(await generateOpenAiImage("fake-test-key", "gpt-image-1.5", "prompt", reference, request as typeof fetch), "data:image/png;base64,result");
});

test("text-only request uses generations; output sizes match model families", async () => {
  const request = async (url: any, init: any) => {
    assert.equal(url, "https://api.openai.com/v1/images/generations");
    assert.deepEqual(JSON.parse(init.body), { model: "gpt-image-2", prompt: "prompt", n: 1, size: "1536x864" });
    return Response.json({ data: [{ b64_json: "result" }] });
  };
  await generateOpenAiImage("fake-test-key", "gpt-image-2", "prompt", null, request as typeof fetch);
  assert.equal(openAiImageSize("dall-e-3"), "1792x1024");
  assert.equal(openAiImageSize("dall-e-2"), "1024x1024");
});

test("failed download never leaks a remote image URL as a successful result", async () => {
  let calls = 0;
  const request = async () => ++calls === 1
    ? Response.json({ data: [{ url: "https://example.invalid/image.png" }] })
    : new Response("unavailable", { status: 503 });
  await assert.rejects(generateOpenAiImage("fake-test-key", "dall-e-3", "prompt", null, request as typeof fetch), /não pôde ser baixada/);
});

test("route uses saved OpenAI key without header, never falls back to Google, reports errors", async () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/storyboard/generate-image"');
  const end = source.indexOf("// Custom Express global error handler", start);
  let handler: any, calledKey = "", response: any, status = 200;
  const config: any = { customOpenAiKey: "fake-saved-key" };
  const context = {
    app: { post: (_: any, fn: any) => handler = fn },
    loadUserConfig: () => config,
    resolveImageModel, ImageRequestError, openAiImageSize,
    generateOpenAiImage: async (key: string) => { calledKey = key; return "data:image/png;base64,result"; },
    getGeminiClient: () => { throw new Error("Wrong provider"); },
    sanitizeErrorMessage: (text: string) => text,
    getCinematicFallbackImage: () => "data:image/png;base64,fallback",
    process: { env: {} }, console: { error() {}, log() {}, warn() {} },
  };
  vm.runInNewContext(transformSync(source.slice(start, end), { loader: "ts" }).code, context);
  const res = { json: (value: any) => response = value, status: (value: number) => { status = value; return res; } };
  await handler({ body: { prompt: "prompt", model: "gpt-image-2" }, get: () => undefined }, res);
  assert.equal(calledKey, "fake-saved-key");
  assert.equal(response.isAiGenerated, true);
  delete config.customOpenAiKey;
  await handler({ body: { prompt: "prompt", model: "gpt-image-2" }, get: () => undefined }, res);
  assert.equal(status, 400);
  assert.match(response.error, /chave OpenAI/);
  assert.equal(response.imageUrl, undefined);
});

test("generation route passes selected Google model and reference to the actual dispatch helper", async () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/storyboard/generate-image"');
  const end = source.indexOf("// Custom Express global error handler", start);
  let handler: any, sent: any, response: any;
  const context = {
    app: { post: (_: any, fn: any) => handler = fn },
    resolveImageModel, ImageRequestError, openAiImageSize,
    imageUrlToInlineData: async () => reference,
    getGeminiClient: () => ({}),
    generateGoogleImage: async (_: any, model: string, prompt: string, ref: any) => {
      sent = { model, prompt, ref }; return "data:image/png;base64,result";
    },
    sanitizeErrorMessage: (value: string) => value,
  };
  vm.runInNewContext(transformSync(source.slice(start, end), { loader: "ts" }).code, context);
  const res = { json: (value: any) => response = value, status: () => res };
  await handler({ body: { prompt: "scene", model: "gemini-3-pro-image-preview", visualInstructionImage: "reference" }, get: () => undefined }, res);
  assert.deepEqual(sent, { model: "gemini-3-pro-image-preview", prompt: "scene", ref: reference });
  assert.equal(response.isAiGenerated, true);
});
