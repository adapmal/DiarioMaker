import type { GoogleGenAI, Part } from "@google/genai";

export interface InlineImage { data: string; mimeType: string }

export class ImageRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Legacy UI labels have explicit mappings. Explicit provider IDs are never substituted.
const legacyGoogleModels: Record<string, string> = {
  nano_banana: "gemini-2.5-flash-image",
  nano_banana_pro: "gemini-3-pro-image",
  nano_banana_2: "gemini-3.1-flash-image",
};

export function resolveImageModel(requested: unknown, defaultOpenAiModel = "gpt-image-2") {
  if (requested !== undefined && typeof requested !== "string") {
    throw new ImageRequestError("O modelo de imagem deve ser um identificador de texto.");
  }
  const value = (requested as string | undefined)?.trim() || "nano_banana";
  const explicitOpenAi = value.startsWith("openai:");
  const model = value === "chatgpt_dalle3" ? defaultOpenAiModel : value.replace(/^(openai:|google:|models\/)/, "");
  if (/^(gpt-image-[\w.-]+|dall-e-[23]|chatgpt-image-latest)$/.test(model)) {
    return { provider: "openai" as const, model };
  }
  if (explicitOpenAi) throw new ImageRequestError(`Modelo OpenAI de imagem não reconhecido: ${model}`);
  const googleModel = legacyGoogleModels[model] || model;
  if (!/^(gemini-[\w.-]*image[\w.-]*|imagen-[\w.-]+)$/.test(googleModel)) {
    throw new ImageRequestError(`Selecione um modelo de imagem válido: ${value}`);
  }
  return { provider: "google" as const, model: googleModel };
}

export function openAiImageSize(model: string): string {
  if (model === "dall-e-2") return "1024x1024";
  if (model === "dall-e-3") return "1792x1024";
  if (model.startsWith("gpt-image-2")) return "1536x864";
  return "1536x1024";
}

export async function generateGoogleImage(ai: Pick<GoogleGenAI, "models">, model: string, prompt: string, reference: InlineImage | null) {
  if (model.startsWith("imagen-")) {
    if (reference) throw new ImageRequestError("Esta geração Imagen aceita somente texto. Para usar a referência, selecione um modelo Gemini de imagem.");
    const result = await ai.models.generateImages({
      model, prompt,
      config: { numberOfImages: 1, outputMimeType: "image/jpeg", aspectRatio: "16:9" },
    });
    const image = result.generatedImages?.[0]?.image;
    if (!image?.imageBytes) throw new Error(`O modelo ${model} não retornou imagem. Verifique a resposta do provedor e o prompt.`);
    return `data:${image.mimeType || "image/jpeg"};base64,${image.imageBytes}`;
  }
  const parts: Part[] = [{ text: prompt }];
  if (reference) parts.push({ inlineData: reference });
  const result = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } },
  });
  const image = result.candidates?.[0]?.content?.parts?.find(
    part => !part.thought && part.inlineData?.data && part.inlineData.mimeType?.startsWith("image/"),
  )?.inlineData;
  if (!image?.data) throw new Error(`O modelo ${model} não retornou imagem. Verifique o prompt ou as restrições informadas pelo provedor.`);
  return `data:${image.mimeType};base64,${image.data}`;
}

export async function generateOpenAiImage(apiKey: string, model: string, prompt: string, reference: InlineImage | null, request: typeof fetch = fetch) {
  if (reference && model.startsWith("dall-e-")) {
    throw new ImageRequestError("Para usar uma imagem de referência neste fluxo, selecione um modelo GPT Image.");
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: string | FormData;
  const size = openAiImageSize(model);
  if (reference) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    form.set("size", size);
    form.set("n", "1");
    const ext = reference.mimeType === "image/jpeg" ? "jpg" : reference.mimeType.split("/")[1];
    form.set("image", new Blob([new Uint8Array(Buffer.from(reference.data, "base64"))], { type: reference.mimeType }), `reference.${ext}`);
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ model, prompt, n: 1, size });
  }
  const response = await request(`https://api.openai.com/v1/images/${reference ? "edits" : "generations"}`, {
    method: "POST", headers, body, signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `OpenAI: falha na geração (HTTP ${response.status}).`;
    try { message = JSON.parse(text).error?.message || message; } catch {}
    throw new Error(message);
  }
  const data = await response.json();
  const result = data.data?.[0];
  if (result?.b64_json) return `data:image/png;base64,${result.b64_json}`;
  if (result?.url && /^https?:\/\//.test(result.url)) {
    const image = await request(result.url, { signal: AbortSignal.timeout(30000) });
    if (!image.ok) throw new Error("A imagem foi gerada, mas não pôde ser baixada para o aplicativo.");
    const mime = image.headers.get("content-type")?.split(";")[0] || "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error("O provedor retornou um formato de imagem inválido.");
    return `data:${mime};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
  }
  throw new Error(`O modelo ${model} não retornou uma imagem válida.`);
}
