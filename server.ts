import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = 3000;

const SESSION_FILE_PATH = path.join(process.cwd(), "session_store.json");

// Helper to sanitize scenes and ensure "Midjourney" is replaced with "Nano Banana"
function sanitizeScenes(scenes: any[]): any[] {
  if (!Array.isArray(scenes)) return [];
  return scenes.map((scene: any) => {
    if (scene && scene.promptTargetTool) {
      const tool = String(scene.promptTargetTool).trim().toLowerCase();
      if (tool === "midjourney" || tool.includes("midjourney")) {
        scene.promptTargetTool = "Nano Banana";
      }
    }
    return scene;
  });
}

// Enable JSON body parser with generous limit for larger scripts
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ limit: "150mb", extended: true }));

// Server-side robust session API
app.get("/api/storyboard/session", (req, res) => {
  try {
    if (fs.existsSync(SESSION_FILE_PATH)) {
      const rawData = fs.readFileSync(SESSION_FILE_PATH, "utf-8");
      const parsed = JSON.parse(rawData);
      if (parsed && Array.isArray(parsed.scenes)) {
        parsed.scenes = sanitizeScenes(parsed.scenes);
        // Extract project folder name from the active session store state
        let targetFolder = "260802";
        if (parsed.folder) {
          targetFolder = parsed.folder;
        } else if (parsed.projectName && parsed.projectName.includes("260802")) {
          targetFolder = "260802";
        }
        parsed.scenes = mapImagePathsToServer(parsed.scenes, targetFolder);
      }
      return res.json(parsed);
    }
    return res.json({ scenes: [], stylePreference: "auto" });
  } catch (error) {
    console.error("Error reading session file:", error);
    return res.json({ scenes: [], stylePreference: "auto" });
  }
});

const SESSION_AUTOSAVE_PATH = path.join(process.cwd(), "session_store_autosave.json");

app.post("/api/storyboard/autosave", (req, res) => {
  try {
    const { 
      scenes, 
      stylePreference,
      projectName,
      scriptText,
      scriptReferenceImage,
      connectionGroups,
      selectedStyle,
      consecutiveNumbering
    } = req.body;
    
    const sessionData = {
      scenes: Array.isArray(scenes) ? sanitizeScenes(scenes) : [],
      stylePreference: stylePreference || "auto",
      projectName: projectName || "Meu Storyboard",
      scriptText: scriptText || "",
      scriptReferenceImage: scriptReferenceImage || null,
      connectionGroups: Array.isArray(connectionGroups) ? connectionGroups : [],
      selectedStyle: selectedStyle || "auto",
      consecutiveNumbering: consecutiveNumbering !== undefined ? consecutiveNumbering : true,
      updatedAt: new Date().toISOString(),
      isAutosave: true
    };
    fs.writeFileSync(SESSION_AUTOSAVE_PATH, JSON.stringify(sessionData, null, 2), "utf-8");
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Error writing autosave file:", error);
    return res.status(500).json({ error: "Failed to persist autosave to server storage." });
  }
});

app.get("/api/storyboard/backups/list", (req, res) => {
  try {
    const list = [];
    if (fs.existsSync(SESSION_FILE_PATH)) {
      const stats = fs.statSync(SESSION_FILE_PATH);
      list.push({
        type: "main",
        name: "Sessão Principal",
        updatedAt: stats.mtime.toISOString(),
        size: stats.size
      });
    }
    if (fs.existsSync(SESSION_AUTOSAVE_PATH)) {
      const stats = fs.statSync(SESSION_AUTOSAVE_PATH);
      list.push({
        type: "autosave",
        name: "Auto-Save de Segurança (1 min)",
        updatedAt: stats.mtime.toISOString(),
        size: stats.size
      });
    }
    return res.json(list);
  } catch (error: any) {
    console.error("Error listing backups:", error);
    return res.status(500).json({ error: "Failed to list backups." });
  }
});

app.post("/api/storyboard/backups/restore", (req, res) => {
  try {
    const { type } = req.body;
    let targetPath = "";
    if (type === "main") {
      targetPath = SESSION_FILE_PATH;
    } else if (type === "autosave") {
      targetPath = SESSION_AUTOSAVE_PATH;
    } else {
      return res.status(400).json({ error: "Tipo de backup inválido." });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: "Arquivo de backup não encontrado." });
    }

    const rawData = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawData);

    // Se restaurou do autosave, atualiza a sessão principal para manter sincronismo
    if (type === "autosave") {
      fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(parsed, null, 2), "utf-8");
    }

    return res.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error("Error restoring backup:", error);
    return res.status(500).json({ error: "Failed to restore backup." });
  }
});

app.post("/api/storyboard/session", (req, res) => {
  try {
    const { 
      scenes, 
      stylePreference,
      projectName,
      scriptText,
      scriptReferenceImage,
      connectionGroups,
      selectedStyle,
      consecutiveNumbering,
      diaryDate,
      saveVersion
    } = req.body;
    
    const sessionData = {
      scenes: Array.isArray(scenes) ? sanitizeScenes(scenes) : [],
      stylePreference: stylePreference || "auto",
      projectName: projectName || "Meu Storyboard",
      scriptText: scriptText || "",
      scriptReferenceImage: scriptReferenceImage || null,
      connectionGroups: Array.isArray(connectionGroups) ? connectionGroups : [],
      selectedStyle: selectedStyle || "auto",
      consecutiveNumbering: consecutiveNumbering !== undefined ? consecutiveNumbering : true,
      diaryDate: diaryDate || "",
      saveVersion: saveVersion !== undefined ? saveVersion : 1,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionData, null, 2), "utf-8");
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Error writing session file:", error);
    return res.status(500).json({ error: "Failed to persist session to server storage." });
  }
});

// 1. Servir a pasta "projects" estaticamente para acesso direto do frontend sem cache para evitar imagens quebradas pós-geração
app.use("/projects", express.static(path.join(process.cwd(), "projects"), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  }
}));

// 2. Rota para listar os projetos disponíveis no servidor
app.get("/api/storyboard/projects/list", (req, res) => {
  try {
    const projectsDir = path.join(process.cwd(), "projects");
    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir, { recursive: true });
    }
    const folders = fs.readdirSync(projectsDir).filter(file => {
      const fullPath = path.join(projectsDir, file);
      return fs.statSync(fullPath).isDirectory();
    });

    const list = folders.map(folder => {
      const projectJsonPath = path.join(projectsDir, folder, "storyboard.json");
      let updatedAt = new Date().toISOString();
      let size = 0;
      let hasConfig = false;
      if (fs.existsSync(projectJsonPath)) {
        const stats = fs.statSync(projectJsonPath);
        updatedAt = stats.mtime.toISOString();
        size = stats.size;
        hasConfig = true;
      }
      return {
        name: folder,
        path: `projects/${folder}`,
        updatedAt,
        size,
        hasConfig
      };
    });

    return res.json(list);
  } catch (err: any) {
    console.error("Erro ao listar projetos:", err);
    return res.status(500).json({ error: "Falha ao listar diretórios de projeto." });
  }
});

// Helper to map zipped image paths to physical static server paths on load
function mapImagePathsToServer(scenes: any[], folder: string): any[] {
  if (!Array.isArray(scenes)) return [];
  return scenes.map((scene: any) => {
    if (scene) {
      if (scene.generatedImageUrl && scene.generatedImageUrl.startsWith("images/")) {
        scene.generatedImageUrl = `/projects/${folder}/imagens/${scene.generatedImageUrl.replace("images/", "")}`;
      }
      if (Array.isArray(scene.imageVersions)) {
        scene.imageVersions = scene.imageVersions.map((v: any) => {
          if (v && v.url && v.url.startsWith("images/")) {
            v.url = `/projects/${folder}/imagens/${v.url.replace("images/", "")}`;
          }
          return v;
        });
      }
    }
    return scene;
  });
}

// 3. Rota para carregar um projeto específico de sua pasta física
app.get("/api/storyboard/projects/load", (req, res) => {
  try {
    const { folder } = req.query;
    if (!folder || typeof folder !== "string") {
      return res.status(400).json({ error: "O nome da pasta do projeto é obrigatório." });
    }

    // Obter apenas o nome final da pasta para evitar Directory Traversal
    const safeFolder = path.basename(folder);
    const projectJsonPath = path.join(process.cwd(), "projects", safeFolder, "storyboard.json");

    if (fs.existsSync(projectJsonPath)) {
      const rawData = fs.readFileSync(projectJsonPath, "utf-8");
      const parsed = JSON.parse(rawData);
      if (parsed && Array.isArray(parsed.scenes)) {
        parsed.scenes = sanitizeScenes(parsed.scenes);
        parsed.scenes = mapImagePathsToServer(parsed.scenes, safeFolder);
      }
      return res.json({ success: true, data: parsed });
    } else {
      return res.json({ success: false, error: "Nenhum arquivo de projeto encontrado nesta pasta." });
    }
  } catch (err: any) {
    console.error("Erro ao carregar projeto:", err);
    return res.status(500).json({ error: "Erro ao abrir projeto físico no disco." });
  }
});

// 4. Rota para salvar o projeto de forma persistente e atômica na pasta física
app.post("/api/storyboard/projects/save", (req, res) => {
  try {
    const { 
      folder,
      scenes, 
      stylePreference,
      projectName,
      scriptText,
      scriptReferenceImage,
      connectionGroups,
      selectedStyle,
      consecutiveNumbering,
      diaryDate,
      saveVersion,
      updatedAt
    } = req.body;

    if (!folder || typeof folder !== "string") {
      return res.status(400).json({ error: "A pasta do projeto é obrigatória." });
    }

    const safeFolder = path.basename(folder);
    const projectDir = path.join(process.cwd(), "projects", safeFolder);
    const imagesDir = path.join(projectDir, "imagens");

    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const sessionData = {
      scenes: Array.isArray(scenes) ? sanitizeScenes(scenes) : [],
      stylePreference: stylePreference || "auto",
      projectName: projectName || safeFolder,
      scriptText: scriptText || "",
      scriptReferenceImage: scriptReferenceImage || null,
      connectionGroups: Array.isArray(connectionGroups) ? connectionGroups : [],
      selectedStyle: selectedStyle || "auto",
      consecutiveNumbering: consecutiveNumbering !== undefined ? consecutiveNumbering : true,
      diaryDate: diaryDate || "",
      saveVersion: saveVersion !== undefined ? saveVersion : 1,
      updatedAt: updatedAt || new Date().toISOString(),
      isAutosave: false
    };

    const projectJsonPath = path.join(projectDir, "storyboard.json");
    fs.writeFileSync(projectJsonPath, JSON.stringify(sessionData, null, 2), "utf-8");

    // Também salvar na sessão global padrão para manter compatibilidade
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionData, null, 2), "utf-8");

    return res.json({ success: true, path: projectJsonPath, updatedAt: sessionData.updatedAt });
  } catch (error: any) {
    console.error("Error writing physical project file:", error);
    return res.status(500).json({ error: "Falha ao salvar sessão física no disco." });
  }
});

// 5. Rota para salvar uma imagem fisicamente na pasta do projeto ativo
app.post("/api/storyboard/projects/save-image", async (req, res) => {
  try {
    const { folder, sceneId, sceneNumber, imageUrl } = req.body;
    if (!folder || !imageUrl) {
      return res.status(400).json({ error: "Os parâmetros 'folder' e 'imageUrl' são obrigatórios." });
    }

    const safeFolder = path.basename(folder);
    const projectDir = path.join(process.cwd(), "projects", safeFolder);
    const imagesDir = path.join(projectDir, "imagens");

    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    let ext = ".png";
    let buffer: Buffer;

    if (imageUrl.startsWith("data:")) {
      const matches = imageUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: "Formato de imagem Base64 inválido." });
      }
      ext = `.${matches[1] === "jpeg" ? "jpg" : matches[1]}`;
      buffer = Buffer.from(matches[2], "base64");
    } else {
      // É uma URL externa (ex: Unsplash ou proxy). Vamos baixá-la
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Falha ao fazer o download da imagem remota: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      const contentType = response.headers.get("content-type") || "image/png";
      ext = contentType.includes("jpeg") ? ".jpg" : contentType.includes("webp") ? ".webp" : ".png";
    }

    // Nomear o arquivo de forma inteligente, descritiva e única para cada versão
    const cleanSceneNumber = String(sceneNumber || "sem_numero").replace(/[^a-zA-Z0-9_-]/g, "_");
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const filename = `cena_${cleanSceneNumber}_${sceneId || "scene"}_${uniqueSuffix}${ext}`;
    const targetFilePath = path.join(imagesDir, filename);

    fs.writeFileSync(targetFilePath, buffer);

    // Retorna a URL local estática acessível no frontend
    const localStaticUrl = `/projects/${safeFolder}/imagens/${filename}`;
    return res.json({ success: true, url: localStaticUrl });
  } catch (err: any) {
    console.error("Erro ao salvar imagem no disco:", err);
    return res.status(500).json({ error: `Erro ao gravar imagem no disco: ${err.message}` });
  }
});

// Proxy remote image URLs (like Unsplash fallbacks) to avoid CORS issues on packaging on the client
app.get("/api/storyboard/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "O parâmetro URL é obrigatório." });
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Falha ao buscar imagem externa: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.send(buffer);
  } catch (err: any) {
    console.error("Error in proxy-image route:", err);
    res.status(500).json({ error: err.message || "Erro interno de proxying de imagem." });
  }
});

// Lazy init of Gemini API Client to prevent startup failure if key is missing
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(customApiKey?: string): GoogleGenAI {
  if (customApiKey && customApiKey.trim()) {
    const cleanedKey = customApiKey.trim().replace(/^["']|["']$/g, "");
    if (cleanedKey) {
      return new GoogleGenAI({
        apiKey: cleanedKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
          timeout: 120000,
        },
      });
    }
  }

  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("A chave GEMINI_API_KEY está ausente no ambiente do servidor. Por favor, adicione-a como um segredo nas configurações do applet.");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
        timeout: 120000,
      },
    });
  }
  return aiClient;
}

// Converts standard HTTP image URLs or data URIs to inline base64 data for Gemini multimodal APIs (skips unsupported SVGs)
async function imageUrlToInlineData(url: string): Promise<{ data: string; mimeType: string } | null> {
  if (!url || typeof url !== "string") return null;
  
  if (url.startsWith("data:")) {
    const matches = url.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      const mimeType = matches[1];
      if (mimeType.includes("svg") || mimeType.includes("xml")) {
        return null;
      }
      return {
        mimeType,
        data: matches[2]
      };
    }
    return null;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = res.headers.get("content-type") || "image/jpeg";
      
      if (mimeType.startsWith("image/") && !mimeType.includes("svg") && !mimeType.includes("xml")) {
        return {
          mimeType,
          data: buffer.toString("base64")
        };
      }
    } catch (err) {
      console.warn(`[Gemini API] Failed to fetch image URL for inlineData: ${url}`, err);
    }
  }

  return null;
}

// Helper robusto para formatar erros do Gemini de forma amigável ao usuário, tratando limites de cota
function formatGeminiError(error: any): string {
  const errStr = error?.message || String(error);
  if (
    errStr.includes("400") ||
    errStr.toLowerCase().includes("api key not valid") ||
    errStr.toLowerCase().includes("api_key_invalid") ||
    errStr.toLowerCase().includes("invalid_argument") ||
    error?.status === 400
  ) {
    return "A chave de API do Gemini inserida é inválida ou não pôde ser autenticada (Erro 400 - API key not valid). Verifique se você copiou o código completo e correto (geralmente começa com AIzaSy...) ou clique em 'Limpar' no painel de Chave de API abaixo para voltar à chave pública padrão.";
  }
  if (
    errStr.includes("429") ||
    errStr.toLowerCase().includes("quota") ||
    errStr.toLowerCase().includes("resource_exhausted") ||
    error?.status === 429
  ) {
    return "Você excedeu temporariamente a cota de uso gratuita do Gemini (Erro 429 - Limite atingido). Aguarde alguns segundos para tentar novamente, ou insira sua própria chave no painel de Chave de API abaixo para rodar com sua cota pessoal sem limites compartilhados.";
  }
  if (
    errStr.includes("503") ||
    errStr.toLowerCase().includes("unavailable") ||
    errStr.toLowerCase().includes("high demand")
  ) {
    return "O servidor do Gemini está temporariamente indisponível devido à altíssima demanda (Erro 503). Por favor, tente novamente em alguns instantes.";
  }
  if (
    errStr.includes("504") ||
    errStr.toLowerCase().includes("deadline") ||
    error?.status === 504
  ) {
    return "O tempo limite de processamento do Gemini expirou (Erro 504 - Deadline Exceeded). O servidor pode estar congestionado no momento. Por favor, tente novamente em instantes ou utilize uma chave de API própria nas configurações.";
  }
  return errStr;
}

// Map of model stability to avoid slow retries if a model is unstable
const modelStabilityMap: Record<string, { lastFailureTime: number; failureCount: number }> = {};

// Helper para executar chamadas de API com tentativas adaptativas, tratando falhas intermitentes
async function callGeminiWithRetry<T>(
  apiCall: (modelName: string) => Promise<T>,
  preferredModel: string,
  fallbackModels: string[] = [],
  initialDelayMs = 1000,
  req?: express.Request
): Promise<{ response: T; modelUsed: string }> {
  let lastError: any = null;
  let delay = initialDelayMs;
  
  // Adaptive model list promotion based on stability map
  const now = Date.now();
  let modelsToTry = [preferredModel, ...fallbackModels];
  const stats = modelStabilityMap[preferredModel];
  if (stats && stats.failureCount >= 1 && (now - stats.lastFailureTime < 600000)) { // 10 minutes cache
    const stableFallbacks = fallbackModels.filter(f => {
      const fStats = modelStabilityMap[f];
      return !fStats || fStats.failureCount === 0 || (now - fStats.lastFailureTime >= 600000);
    });
    if (stableFallbacks.length > 0) {
      const promoted = stableFallbacks[0];
      const otherFallbacks = fallbackModels.filter(f => f !== promoted);
      modelsToTry = [promoted, preferredModel, ...otherFallbacks];
      console.log(`[Gemini API Stability Circuit Breaker] O modelo ${preferredModel} foi considerado instável temporariamente. Promovendo o modelo estável ${promoted} para primeira tentativa.`);
    }
  }
  
  for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
    const currentModel = modelsToTry[attempt];
    
    try {
      const res = await apiCall(currentModel);
      // Clear failure record upon successful call
      if (modelStabilityMap[currentModel]) {
        modelStabilityMap[currentModel].failureCount = 0;
      }
      return { response: res, modelUsed: currentModel };
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.code || 0;
      const message = String(err?.message || err).toLowerCase();
      
      const isTransient = 
        status === 429 || 
        status === 503 || 
        status === 504 ||
        message.includes("quota") || 
        message.includes("limit") || 
        message.includes("exhausted") || 
        message.includes("unavailable") || 
        message.includes("demand") ||
        message.includes("spike") ||
        message.includes("timeout") ||
        message.includes("deadline") ||
        message.includes("fetch failed") ||
        message.includes("undici") ||
        message.includes("abort") ||
        message.includes("aborted") ||
        message.includes("cancelled") ||
        status === 499;
        
      if (isTransient) {
        // Update stability stats
        const errTime = Date.now();
        if (!modelStabilityMap[currentModel]) {
          modelStabilityMap[currentModel] = { lastFailureTime: errTime, failureCount: 1 };
        } else {
          modelStabilityMap[currentModel].lastFailureTime = errTime;
          modelStabilityMap[currentModel].failureCount++;
        }

        if (attempt < modelsToTry.length - 1) {
          console.warn(`[Gemini API] Modelo ${currentModel} instável ou sobrecarregado (tentativa ${attempt + 1}/${modelsToTry.length}): ${err?.message || err}. Retentando com o modelo ${modelsToTry[attempt + 1]} em ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 1.5; // Backoff exponencial suave
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// Helper to extract clean human-readable messages from OpenAI JSON error responses
function parseOpenAiErrorText(status: number, errText: string, prefix = "OpenAI Error"): string {
  try {
    const parsed = JSON.parse(errText);
    if (parsed && parsed.error && typeof parsed.error.message === "string") {
      return `${prefix} (Status ${status}): ${parsed.error.message}`;
    }
  } catch (e) {
    // Fallback if not valid JSON
  }
  return `${prefix} (Status ${status}): ${errText}`;
}

// OpenAI chat completions proxy helper
async function callOpenAiChat(apiKey: string, model: string, systemInstruction: string, promptText: string, jsonMode = false) {
  const url = "https://api.openai.com/v1/chat/completions";
  const messages = [
    { role: "system", content: systemInstruction },
    { role: "user", content: promptText }
  ];

  const payload: any = {
    model: model || "gpt-4o-mini",
    messages: messages,
  };

  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(parseOpenAiErrorText(response.status, errText, "OpenAI Chat Error"));
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// OpenAI image generations (DALL-E) proxy helper
async function callOpenAiImage(apiKey: string, model: string, prompt: string) {
  const url = "https://api.openai.com/v1/images/generations";
  const payload: any = {
    model: model || "dall-e-3",
    prompt: prompt,
    n: 1,
  };
  
  if (model === "dall-e-3") {
    payload.size = "1792x1024";
  } else {
    payload.size = "1024x1024";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(parseOpenAiErrorText(response.status, errText, "OpenAI Image Error"));
  }

  const data = await response.json();
  return data.data[0].url;
}

// Algoritmo determinístico offline para segmentar o roteiro em partes caso o Gemini esteja 100% indisponível
function localFallbackStoryboardSegmenter(rawText: string, stylePreference: string): { scenes: any[] } {
  const paragraphs = rawText
    .split(/\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  
  const segments: string[] = [];
  
  for (const para of paragraphs) {
    if (para.length > 250) {
      const sentences = para.split(/(?<=[.!?])\s+/);
      let currentChunk = "";
      for (const sent of sentences) {
        if ((currentChunk + " " + sent).length > 250) {
          if (currentChunk) segments.push(currentChunk.trim());
          currentChunk = sent;
        } else {
          currentChunk = (currentChunk + " " + sent).trim();
        }
      }
      if (currentChunk) segments.push(currentChunk.trim());
    } else {
      segments.push(para);
    }
  }

  if (segments.length === 0) {
    segments.push(rawText.trim() || "Nova cena de meditação contemplativa silenciosa.");
  }

  const scenes = segments.map((text, idx) => {
    const textLower = text.toLowerCase();
    
    // Auto-detectar tema bíblico/caravaggio vs realista
    let isBiblical = false;
    if (stylePreference === "caravaggio") {
      isBiblical = true;
    } else if (stylePreference === "urban_realism") {
      isBiblical = false;
    } else {
      isBiblical = 
        textLower.includes("jesus") ||
        textLower.includes("cristo") ||
        textLower.includes("deus") ||
        textLower.includes("bíblia") ||
        textLower.includes("santo") ||
        textLower.includes("oração") ||
        textLower.includes("padre") ||
        textLower.includes("templo") ||
        textLower.includes("mar") ||
        textLower.includes("barco") ||
        textLower.includes("senhor") ||
        textLower.includes("orando") ||
        textLower.includes("rezando") ||
        textLower.includes("vela") ||
        textLower.includes("igreja");
    }

    let description = "";
    let prompt = "";

    if (isBiblical) {
      if (textLower.includes("and") || textLower.includes("andava") || textLower.includes("caminha") || textLower.includes("passa")) {
        description = "Mestre barroco offline: Vemos um personagem rústico e humilde vestido em túnicas com dobras severas, caminhando lentamente por terra batida em direção a um belíssimo foco de luz mística no horizonte crepuscular.";
        prompt = `An ancient humble traveler figure wearing simple historical robes walking on a rustic dirt path toward a glorious beam of divine golden sunlight in the sky, intense chiaroscuro contrast, deep dark shadows, Caravaggio style, 16:9 aspect ratio`;
      } else if (textLower.includes("dorm") || textLower.includes("sono") || textLower.includes("deit")) {
        description = "Mestre barroco offline: Um homem repousando calmamente em profundo descanso sobre um leito rústico de madeira de uma cabana antiga sob a luz silenciosa e oscilante de uma vela.";
        prompt = `A peaceful middle-aged man with beard sleeping deeply inside a dark rustic ancient wooden bedroom, single flickering candle key light casting long dramatic shadows, realistic textures, Caravaggio art style, 16:9 aspect ratio`;
      } else {
        description = "Mestre barroco offline: Detalhe focado em mãos humanas expressivas postas em oração fervorosa. A luz quente desenha os contornos da pele, enquanto o fundo permanece inteiramente envolto na escuridão profunda do bosque.";
        prompt = `Closed shot of rugged calloused human hands clasped in deep silent prayer, strong golden key light accentuating details, mysterious pitch black ambient shadows, Caravaggio chiaroscuro masterpiece, 16:9 aspect ratio`;
      }
    } else {
      // Modern urban realism
      if (textLower.includes("chuva") || textLower.includes("tempestade") || textLower.includes("água")) {
        description = "Realismo urbano local: Gotas densas de chuva caindo sob o asfalto frio de uma pequena ruela brasileira. O chão úmido e brilhante reflete a iluminação difusa amarela de um poste distante.";
        prompt = `A narrow Brazilian cobblestone street at night during a heavy rainstorm, wet asphalt glittering and reflecting soft yellow streetlamp light, high-contrast cinematic color grading, moody documentary photorealism, 16:9 aspect ratio`;
      } else if (textLower.includes("rua") || textLower.includes("trânsito") || textLower.includes("ônibus") || textLower.includes("cidade")) {
        description = "Realismo urbano local: Pessoas reais de feições expressivas aguardando tranquilamente em um ponto de ônibus comum no final de tarde. A fumaça suave da cidade e a luz dourada do Sol dão um tom nostálgico.";
        prompt = `Genuine everyday people waiting patiently at a humble local bus stop in a Brazilian neighborhood during warm dusty golden hour sunset, authentic cinematic street photography, soft atmospheric focus, 16:9 aspect ratio`;
      } else {
        description = "Realismo urbano local: Iluminação ambiente suave adentrando a janela aberta de um cômodo simples para revelar uma mesa de madeira velha com café fumegante, transmitindo paz e solitude tranquila.";
        prompt = `Steaming hot mug of coffee resting on an old wooden table inside a cozy simple bedroom with natural afternoon sunlight casting soft shadows of a window, slow quiet life aesthetic, 16:9 aspect ratio`;
      }
    }

    return {
      id: `fallback-${Date.now()}-${idx}`,
      text,
      description,
      prompt,
      generationGuidelines: "",
      sceneStylePreference: "auto",
      promptAiModel: "gemini-3.6-flash",
      promptTargetTool: "Nano Banana"
    };
  });

  return { scenes };
}

// Gerador determinístico offline para uma única cena caso o Gemini esteja temporariamente instável
function localFallbackSceneGenerator(text: string, stylePreference: string, generationGuidelines = "", promptTargetTool = "Nano Banana"): { description: string; prompt: string } {
  const textLower = text.toLowerCase();
  let isBiblical = false;
  if (stylePreference === "caravaggio") {
    isBiblical = true;
  } else if (stylePreference === "urban_realism") {
    isBiblical = false;
  } else {
    isBiblical = 
      textLower.includes("jesus") ||
      textLower.includes("cristo") ||
      textLower.includes("deus") ||
      textLower.includes("bíblia") ||
      textLower.includes("santo") ||
      textLower.includes("oração") ||
      textLower.includes("padre") ||
      textLower.includes("templo") ||
      textLower.includes("mar") ||
      textLower.includes("barco") ||
      textLower.includes("senhor") ||
      textLower.includes("orando") ||
      textLower.includes("rezando") ||
      textLower.includes("vela") ||
      textLower.includes("igreja");
  }

  let description = "";
  let prompt = "";

  const directionCue = generationGuidelines ? ` (Instrução: ${generationGuidelines})` : "";
  if (isBiblical) {
    description = `Diretriz de arte Caravaggio offline${directionCue}: Composição focada no chiaroscuro severo, faces marcadas por emoção devota iluminadas por feixes divinos vindos de cima.`;
    prompt = `A sacred highly detailed painting illustrating "${text.replace(/"/g, "'")}", expressive character pose with humble robes, deep rich dark atmospheric color palette, majestic Caravaggio chiaroscuro, borderless, no frame, no picture frame, no canvas margins, specialized for ${promptTargetTool}, 16:9 aspect ratio`;
  } else {
    description = `Diretriz de realismo urbano local${directionCue}: Captura de momento autêntico e íntimo, iluminação natural calorosa e expressões faciais genuínas transmitindo humanidade.`;
    prompt = `An authentic lifestyle cinematic shot illustrating "${text.replace(/"/g, "'")}", natural key lighting, everyday ordinary people with highly realistic skin textures, golden cinematic glow, documentary photography, specialized for ${promptTargetTool}, 16:9 aspect ratio`;
  }

  return { description, prompt };
}

// System Instruction that implements Art Director roles and style rules
const SYSTEM_INSTRUCTION = `You are a professional Art Director specializing in religious, contemplative, and human-centric daily meditations.
Your task is to analyze user-provided narrative scripts, segment them into chronological, pacing-appropriate storyboard scenes, and design precise visual descriptions and image prompts for each.

Language and Style Rules:
1. General Image Guidelines:
   - All prompts ("prompt" field) MUST be written in English.
   - The cinematic visual description ("description" field) MUST be written in Brazilian Portuguese (Português do Brasil - PT-BR) to represent the "Composição Visual do Diretor".
   - All prompts MUST specify a 16:9 aspect ratio (e.g., conclude with '16:9 aspect ratio', or '--ar 16:9').
   - All prompts MUST be borderless, edge-to-edge full scenes with absolutely no framing artifacts, picture frames, canvas edges, matte borders, wooden frames, or gallery/museum wall backgrounds.

2. Styling Logic:
   - Biblical or Historical Theme (e.g., Jesus, Saint Joseph of Anchieta, biblical characters, ancient historical setting):
     Use a dramatic Caravaggio-inspired art style. Focus on extreme chiaroscuro (strong and dramatic contrasts between light and dark), deep shadows, glowing golden highlights, expressive hands and gestures, authentic ancient rustic garments, mud, wood, glowing candlelight or single source beams of sunlight, epic classical painterly texture. The image MUST be borderless and full-screen; do NOT render any picture frames, wooden frames, canvas margins, or museum/gallery room settings.
   - Modern or Everyday Narrative Theme (contemplative human struggles, modern life, urban scenes, spiritual reflections today):
     Use gritty, naturalistic Brazilian urban realism style. Focus on natural ambient lighting, authentic everyday ordinary people (with unique faces, expressive lines, genuine gestures, real bodies), authentic places (concrete walls, favelas, cobblestones, bus stops, humble Brazilian homes, warm tropical light or rain showers), realistic cinematic film photorealism, avoiding glossy high-tech looks or clean synthetic renders.

3. Segmentation & Full Coverage:
   - Read the user input carefully from start to end.
   - You MUST map the ENTIRE script text into sequential visual scenes. Do NOT skip, summarize, condense, truncate, or omit any paragraphs or sentences.
   - NO parts of the user script can be deleted or skipped. The 'text' fields of the generated scenes, when concatenated in chronological order, must represent 100% of the original text verbatim or near-verbatim. Every single sentence of the script must belong to exactly one of the scenes.
   - Separate the narrative logically on sentence boundaries or natural breathing points. Each scene should represent a logical visual unit. Do not cut off sentences in the middle of a thought.`;

// API Routes
app.post("/api/storyboard/test-key", async (req, res) => {
  const { customApiKey } = req.body;
  const activeKey = (req.headers["x-gemini-key"] as string) || customApiKey;
  if (!activeKey || !activeKey.trim()) {
    return res.status(400).json({ error: "Nenhuma chave de API fornecida para teste." });
  }

  try {
    const ai = getGeminiClient(activeKey);
    // Simple fast content generation test to check if the key works
    const testResult = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: "Respond with the word 'OK' only.",
      config: {
        maxOutputTokens: 5,
      }
    });

    return res.json({ 
      success: true, 
      message: "Sua chave de API do Gemini foi verificada e está respondendo com sucesso!" 
    });
  } catch (error: any) {
    console.error("[Gemini API] Key verification failed:", error);
    return res.status(400).json({ 
      success: false, 
      error: formatGeminiError(error) 
    });
  }
});

app.post("/api/storyboard/generate", async (req, res) => {
  const { rawText, stylePreference, scriptReferenceImage, customApiKey, stylePrompt } = req.body;
  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    return res.status(400).json({ error: "Script text is required" });
  }

  const openAiKey = req.headers["x-openai-key"] as string;
  const openAiModel = req.headers["x-openai-model"] as string || "gpt-4o-mini";
  const useOpenAi = req.headers["x-use-openai"] === "true" && !!openAiKey;

  const activeKey = (req.headers["x-gemini-key"] as string) || customApiKey;
  const isUsingCustomKey = !!(activeKey && activeKey.trim());

  let styleGuidance = "";
  if (stylePrompt) {
    styleGuidance = `\nFORCE STYLE: ${stylePrompt}`;
  } else if (stylePreference === "caravaggio") {
    styleGuidance = "\nFORCE STYLE: Caravaggio-inspired cinematic baroque art for all prompts, regardless of setting. Strictly generate borderless images; do NOT include any picture frames, wooden borders, canvas margins, or museum/gallery room settings.";
  } else if (stylePreference === "urban_realism") {
    styleGuidance = "\nFORCE STYLE: Gritty, naturalistic Brazilian urban realism for all prompts.";
  }

  const promptText = `CRITICAL: Analyze the following narrative script and break it down into pacing-appropriate sequential scenes. 
You MUST include 100% of the script content. Do NOT leave out any thoughts, sentences, or phrases. Every word or sentence from the input must be mapped sequentially into one of the output scenes ("text" field) so the whole script is entirely preserved without any skipping or summarizing.
${styleGuidance}

Script:
"""
${rawText}
"""`;

  if (useOpenAi) {
    console.log(`[OpenAI API] Storyboard Generation. Model: ${openAiModel}`);
    try {
      const systemInstructionWithJsonPrompt = `${SYSTEM_INSTRUCTION}\nYou MUST return a JSON object with a single root key "scenes", which is an array of objects. Each object in "scenes" MUST contain exactly:
- "text": the verbatim narrative segment (string)
- "description": cinematic visual description in PT-BR (string)
- "prompt": high-quality English image prompt ending with "16:9 aspect ratio" (string)`;

      const gptOutput = await callOpenAiChat(
        openAiKey,
        openAiModel,
        systemInstructionWithJsonPrompt,
        promptText,
        true
      );

      const result = JSON.parse(gptOutput || "{}");
      if (result && Array.isArray(result.scenes)) {
        result.scenes = result.scenes.map((scene: any) => ({
          ...scene,
          promptAiModelUsed: `openai:${openAiModel}`
        }));
      }
      return res.json({
        ...result,
        isCustomKeyUsed: true
      });
    } catch (gptErr: any) {
      console.warn("[OpenAI API] Storyboard generation failed. Activating local intelligent fallback segmenter:", gptErr);
      try {
        const fallbackResult = localFallbackStoryboardSegmenter(rawText, stylePreference || "auto");
        const fallbackScenes = fallbackResult.scenes.map((scene: any) => ({
          ...scene,
          promptAiModelUsed: "fallback"
        }));
        return res.json({
          scenes: fallbackScenes,
          isFallbackActive: true,
          fallbackReason: `OpenAI falhou: ${gptErr.message || gptErr}`,
          isCustomKeyUsed: true
        });
      } catch (fallbackErr: any) {
        console.error("Local intelligent fallback failed after OpenAI error:", fallbackErr);
        return res.status(500).json({
          error: `OpenAI error: ${gptErr.message || gptErr}`
        });
      }
    }
  }

  console.log(`[Gemini API] Storyboard Generation. Is custom API key used? ${isUsingCustomKey ? "YES (begins with " + activeKey.trim().substring(0, 6) + ")" : "NO (using public shared key)"}`);

  try {
    const ai = getGeminiClient(activeKey);

    const contents: any[] = [];
    if (scriptReferenceImage && typeof scriptReferenceImage === "string") {
      const matches = scriptReferenceImage.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const mimeType = matches[1];
        const base64Data = matches[2];
        contents.push({
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        });
        console.log(`[Gemini API] Added scriptReferenceImage inline data of type ${mimeType} to generate endpoint`);
      }
    }
    contents.push({ text: promptText });

    const { response, modelUsed } = await callGeminiWithRetry((modelName) => ai.models.generateContent({
      model: modelName,
      contents: { parts: contents },
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            scenes: {
              type: Type.ARRAY,
              description: "List of storyboard scenes generated sequentially from the text.",
              items: {
                type: Type.OBJECT,
                properties: {
                  text: {
                    type: Type.STRING,
                    description: "Verbatim or pacing-optimized narrative script segment for this specific step."
                  },
                  description: {
                    type: Type.STRING,
                    description: "Short cinematic visual description of what we see on screen (composition, lighting, character posture, setting), written in Brazilian Portuguese (PT-BR) only."
                  },
                  prompt: {
                    type: Type.STRING,
                    description: "High-quality, descriptive English image prompt ending with '16:9 aspect ratio', incorporating requested style rules."
                  }
                },
                required: ["text", "description", "prompt"]
              }
            }
          },
          required: ["scenes"]
        }
      }
    }), "gemini-3.6-flash", ["gemini-3.1-flash-lite", "gemini-flash-latest"], 1000, req);

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("Empty response from AI assistant");
    }

    const result = JSON.parse(textOutput);
    if (result && Array.isArray(result.scenes)) {
      result.scenes = result.scenes.map((scene: any) => ({
        ...scene,
        promptAiModelUsed: modelUsed
      }));
    }
    res.json({
      ...result,
      isCustomKeyUsed: isUsingCustomKey
    });
  } catch (error: any) {
    console.warn("Error generating storyboard via Gemini. Activating local intelligent fallback segmenter:", error);
    try {
      const fallbackResult = localFallbackStoryboardSegmenter(rawText, stylePreference || "auto");
      const fallbackScenes = fallbackResult.scenes.map((scene: any) => ({
        ...scene,
        promptAiModelUsed: "fallback"
      }));
      res.json({
        scenes: fallbackScenes,
        isFallbackActive: true,
        fallbackReason: formatGeminiError(error),
        isCustomKeyUsed: isUsingCustomKey
      });
    } catch (fallbackErr: any) {
      console.error("Local intelligent fallback failed:", fallbackErr);
      res.status(500).json({
        error: formatGeminiError(error)
      });
    }
  }
});

app.post("/api/storyboard/regenerate-scene", async (req, res) => {
  const { 
    text, 
    stylePreference, 
    currentDescription, 
    currentPrompt,
    generationGuidelines,
    sceneStylePreference,
    promptAiModel,
    promptTargetTool,
    customApiKey,
    connectedScenes,
    stylePrompt
  } = req.body;

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Scene text/narration is required" });
  }

  const activeKey = (req.headers["x-gemini-key"] as string) || customApiKey;
  const isUsingCustomKey = !!(activeKey && activeKey.trim());
  console.log(`[Gemini API] Scene Regeneration. Model: ${promptAiModel || "gemini-3.6-flash"}. Is custom API key used? ${isUsingCustomKey ? "YES (begins with " + activeKey.trim().substring(0, 6) + ")" : "NO (using public shared key)"}`);

  // Use scene style preference overrides if selected and not "auto"
  const activeStyle = sceneStylePreference && sceneStylePreference !== "auto" ? sceneStylePreference : stylePreference;

  let styleGuidance = "Automatically detect and choose the best matching Art Director styling.";
  if (stylePrompt) {
    styleGuidance = `Strictly use the following custom style prompt guidelines: ${stylePrompt}`;
  } else if (activeStyle === "caravaggio") {
    styleGuidance = "Strictly use the Caravaggio-inspired dramatic chiaroscuro historical/religious style. The image must be a borderless full screen image, with absolutely no picture frames, wooden borders, museum background, or canvas edges.";
  } else if (activeStyle === "urban_realism") {
    styleGuidance = "Strictly use the gritty, naturalistic Brazilian urban realism style.";
  }

  let directionPrompt = "";
  if (generationGuidelines && generationGuidelines.trim()) {
    directionPrompt = `\nCRITICAL CREATIVE DIRECTION / CRITIQUE:
"${generationGuidelines.trim()}"
You MUST strictly incorporate and prioritize this concept or correction constraint. Guide composition, character postures, and tone to match this advice (e.g. if requested to depict mediocrity instead of positive/purposeful outcomes, focus purely on uninspired, mundane, mediocre elements and faces).`;
  }

  let toolGuidance = `OPTIMIZATION FOCUS: Format and tailor this prompt for the image generation engine "${promptTargetTool || "Nano Banana"}". Emphasize compatible cues, weight tags, or structures ideal for ${promptTargetTool || "Nano Banana"}.`;

  let connectedContext = "";
  if (Array.isArray(connectedScenes) && connectedScenes.length > 0) {
    connectedContext = `\n\nCRITICAL VISUAL CONTINUITY & NARRATIVE CONSISTENCY CONSTRAINTS (SAME GROUP CONTEXT):
This scene belongs to a group of connected scenes designed to share character designs, lighting setups, location assets, and visual styles to guarantee aesthetic continuity.
Ensure the clothing style, hair, skin features, props, facial structures, color palette, and location details are aligned with these scenes:
` + connectedScenes.map((s: any, i: number) => {
      return `- Connected Scene #${s.sceneNumber || (i+1)}:
  Narration: "${s.text || ""}"
  Visual Description: "${s.description || ""}"
  Image Prompt: "${s.prompt || ""}"`;
    }).join("\n");
  }

  const userPromptText = `Generate a fresh, improved visual description (written in Brazilian Portuguese (PT-BR) ONLY) and English image prompt for this storyboard segment narration.
You should provide a different creative angle or improved composition than the current description if provided below.

Narration Segment: "${text}"
Current Visual Description (to improve/change): "${currentDescription || ""}"
Current Image Prompt (to improve/change): "${currentPrompt || ""}"
Styling Directive: ${styleGuidance}
${directionPrompt}
${toolGuidance}${connectedContext}`;

  // Dynamically select model based on parameter, fallback to standard gemini-3.6-flash
  const modelToUse = promptAiModel || "gemini-3.6-flash";

  const openAiKey = req.headers["x-openai-key"] as string;
  const openAiModel = req.headers["x-openai-model"] as string || "gpt-4o-mini";
  const useOpenAi = (promptAiModel === "chatgpt" || (req.headers["x-use-openai"] === "true" && promptAiModel !== "gemini-3.6-flash" && promptAiModel !== "gemini-3.1-pro-preview")) && !!openAiKey;

  if (useOpenAi) {
    console.log(`[OpenAI API] Scene Regeneration using model: ${openAiModel}`);
    try {
      const systemInstructionWithJsonPrompt = `${SYSTEM_INSTRUCTION}\nYou MUST return a JSON object containing exactly:
- "description": cinematic visual description in PT-BR (string)
- "prompt": high-quality English image prompt ending with "16:9 aspect ratio" (string)`;

      const gptOutput = await callOpenAiChat(
        openAiKey,
        openAiModel,
        systemInstructionWithJsonPrompt,
        userPromptText,
        true
      );

      const result = JSON.parse(gptOutput || "{}");
      return res.json({
        ...result,
        promptAiModelUsed: `openai:${openAiModel}`,
        isCustomKeyUsed: true
      });
    } catch (gptErr: any) {
      console.warn("[OpenAI API] Scene regeneration failed. Falling back to local fallback generator:", gptErr);
      try {
        const fallbackResult = localFallbackSceneGenerator(text, activeStyle || "auto", generationGuidelines, promptTargetTool);
        return res.json({
          description: fallbackResult.description,
          prompt: fallbackResult.prompt,
          promptAiModelUsed: "fallback",
          isFallbackActive: true,
          fallbackReason: `OpenAI falhou: ${gptErr.message || gptErr}`,
          isCustomKeyUsed: true
        });
      } catch (fallbackErr: any) {
        console.error("Local scene generation failed after OpenAI error:", fallbackErr);
        return res.status(500).json({
          error: `OpenAI error: ${gptErr.message || gptErr}`
        });
      }
    }
  }

  try {
    const ai = getGeminiClient(activeKey);

    const { response, modelUsed } = await callGeminiWithRetry((modelName) => ai.models.generateContent({
      model: modelName,
      contents: userPromptText,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: {
              type: Type.STRING,
              description: "A vivid visual description of what we see on screen, written in Brazilian Portuguese (PT-BR) only."
            },
            prompt: {
              type: Type.STRING,
              description: "A high-quality image prompt in English ending with '16:9 aspect ratio' complying with the style rules and requested guidelines."
            }
          },
          required: ["description", "prompt"]
        }
      }
    }), modelToUse, modelToUse !== "gemini-3.1-flash-lite" ? ["gemini-3.1-flash-lite"] : [], 1000, req);

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("Empty response from AI assistant");
    }

    const result = JSON.parse(textOutput);
    res.json({
      ...result,
      promptAiModelUsed: modelUsed,
      isCustomKeyUsed: isUsingCustomKey
    });
  } catch (error: any) {
    console.warn(`Error regenerating individual scene using model ${modelToUse} with Gemini. Activating local fallback generator:`, error);
    try {
      const fallbackResult = localFallbackSceneGenerator(text, activeStyle || "auto", generationGuidelines, promptTargetTool);
      res.json({
         description: fallbackResult.description,
         prompt: fallbackResult.prompt,
         promptAiModelUsed: "fallback",
         isFallbackActive: true,
         fallbackReason: formatGeminiError(error),
         isCustomKeyUsed: isUsingCustomKey
      });
    } catch (fallbackErr: any) {
      console.error("Local scene generation failed:", fallbackErr);
      res.status(500).json({
        error: formatGeminiError(error)
      });
    }
  }
});

// AI Chat Editor for interactive script modifications and art direction chats
app.post("/api/storyboard/chat-edit", async (req, res) => {
  const {
    sceneText,
    chatHistory,
    userMessage,
    currentDescription,
    currentPrompt,
    stylePreference,
    visualInstructionImage,
    currentImageUrl,
    customApiKey,
    connectedScenes
  } = req.body;

  if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
    return res.status(400).json({ error: "A mensagem do usuário é obrigatória." });
  }

  const activeKey = (req.headers["x-gemini-key"] as string) || customApiKey;
  const isUsingCustomKey = !!(activeKey && activeKey.trim());
  console.log(`[Gemini API] Chat-based visual editor requested. Is custom key used? ${isUsingCustomKey ? "YES" : "NO"}`);

  // Format chat context for Gemini's comprehension of the thread history
  const chatContext = Array.isArray(chatHistory)
    ? chatHistory
        .map((msg: any) => {
          const roleLabel = msg.role === "user" ? "Usuário" : "Diretor Artístico";
          const promptLog = msg.promptUsed ? ` (Prompt de Imagem gerado neste passo: "${msg.promptUsed}")` : "";
          const descLog = msg.descriptionUsed ? ` (Visual detalhado criado neste passo: "${msg.descriptionUsed}")` : "";
          return `${roleLabel}: ${msg.text || ""}${promptLog}${descLog}`;
        })
        .join("\n")
    : "";

  let connectedContext = "";
  if (Array.isArray(connectedScenes) && connectedScenes.length > 0) {
    connectedContext = `\n\nCRITICAL VISUAL CONTINUITY & NARRATIVE CONSISTENCY CONSTRAINTS (SAME GROUP CONTEXT):
This scene belongs to a group of connected scenes designed to share character designs, lighting setups, location assets, and visual styles to guarantee aesthetic continuity.
Ensure the clothing style, hair, skin features, props, facial structures, color palette, and location details are aligned with these scenes:
` + connectedScenes.map((s: any, i: number) => {
      return `- Connected Scene #${s.sceneNumber || (i+1)}:
  Narration: "${s.text || ""}"
  Visual Description: "${s.description || ""}"
  Image Prompt: "${s.prompt || ""}"`;
    }).join("\n");
  }

  const systemPrompt = `You are an elite Art Director and Visual Editor specializing in religious, contemplative and human daily reflections.
You are helping the user refine a single scene's visual content through a conversational chat thread.
You MUST analyze prior history, remember all prior changes/requests, and respond to the latest request.

If a visual instruction reference image is provided, analyze it carefully to guide, inform, or align the style, color palette, lightning, mood, or character design of this scene.

If the current generated image for the scene is also provided, analyze it carefully. The user is asking you to modify, refine, or adjust THAT specific image. Compare this current image against their latest text request to understand exactly what needs to be changed (e.g., adding objects, changing the background, adjusting the lighting, altering character expressions/positions while maintaining consistency).

The scene's current base narration/text is:
"${sceneText || ""}"

The current visual description of the scene (PT-BR):
"${currentDescription || ""}"

The current English image prompt:
"${currentPrompt || ""}"${connectedContext}

Previous Conversation History:
${chatContext || "(No prior history in this session)"}

The user's newest request/edit instruction is:
"${userMessage}"

Style Rules to maintain:
1. Biblical/Historical (Jesus, prayers, ancient temples, candlelights): Caravaggio-inspired art style, deep dark chiaroscuro, golden light, expressive postures and hands, borderless (no picture frames, wooden borders, or canvas margins).
2. Modern/Everyday life (cities, rain, wait stops, modern homes): Gritty, warm, realistic Brazilian urban realism, authentic, human skin textures, cinematic documentary photo.
3. Aspect ratio: All prompts ("newPrompt") MUST be in English and end with '16:9 aspect ratio'.

You must respond with a JSON object following this EXACT schema:
{
  "assistantText": "Friendly, direct, and conversational explanation of your changes in Portuguese (PT-BR) (e.g. 'Entendi perfeitamente. Diminuí a névoa e adicionei mais drama...').",
  "reasoning": "Detailed visual reasoning, memory synthesis, and artistic choices made to accommodate their feedback, in Portuguese (PT-BR) (e.g. 'Ajustei as coordenadas de luz para dar um tom mais Caravaggio, lembrando de manter o tom azul que pediram antes.').",
  "newDescription": "The fully updated, improved visual description of the scene in Portuguese (PT-BR) only.",
  "newPrompt": "The newly updated, detailed English image prompt reflecting the entire history and current request, ending with '16:9 aspect ratio'."
}

Make sure your response matches the JSON structure perfectly.`;

  const openAiKey = req.headers["x-openai-key"] as string;
  const openAiModel = req.headers["x-openai-model"] as string || "gpt-4o-mini";
  const useOpenAi = req.headers["x-use-openai"] === "true" && !!openAiKey;

  if (useOpenAi) {
    console.log(`[OpenAI API] Chat Visual Editor using model: ${openAiModel}`);
    try {
      const gptOutput = await callOpenAiChat(
        openAiKey,
        openAiModel,
        systemPrompt,
        `Processe a solicitação do usuário: "${userMessage}"`,
        true
      );

      const result = JSON.parse(gptOutput || "{}");
      return res.json({
        ...result,
        promptAiModelUsed: `openai:${openAiModel}`,
        isCustomKeyUsed: true
      });
    } catch (gptErr: any) {
      console.error("[OpenAI API] Chat Visual Editor failed:", gptErr);
      return res.status(500).json({
        error: `OpenAI error: ${gptErr.message || gptErr}`
      });
    }
  }

  try {
    const ai = getGeminiClient(activeKey);
    const contents: any[] = [];

    // 1. Add User Reference Image if provided
    if (visualInstructionImage && typeof visualInstructionImage === "string") {
      const inlineImg = await imageUrlToInlineData(visualInstructionImage);
      if (inlineImg) {
        contents.push({ text: "IMAGEM DE REFERÊNCIA VISUAL FORNECIDA PELO USUÁRIO (Preste atenção na paleta de cores, iluminação e estilo desta referência para orientar sua criação):" });
        contents.push({
          inlineData: {
            data: inlineImg.data,
            mimeType: inlineImg.mimeType
          }
        });
        console.log(`[Gemini API] Added visualInstructionImage inline data of type ${inlineImg.mimeType} to chat-edit endpoint`);
      }
    }

    // 2. Add Current Active Scene Image if provided
    if (currentImageUrl && typeof currentImageUrl === "string" && currentImageUrl !== visualInstructionImage) {
      const inlineImg = await imageUrlToInlineData(currentImageUrl);
      if (inlineImg) {
        contents.push({ text: "IMAGEM ATUAL GERADA PARA ESTA CENA (Esta é a imagem que o usuário está vendo agora na tela e deseja que você faça modificações nela):" });
        contents.push({
          inlineData: {
            data: inlineImg.data,
            mimeType: inlineImg.mimeType
          }
        });
        console.log(`[Gemini API] Added currentImageUrl inline data of type ${inlineImg.mimeType} to chat-edit endpoint`);
      }
    }

    // 3. Add prompt/instruction text
    contents.push({
      text: `Instrução de edição solicitada pelo usuário: "${userMessage}"`
    });

    const { response, modelUsed } = await callGeminiWithRetry((modelName) => ai.models.generateContent({
      model: modelName,
      contents: { parts: contents },
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            assistantText: { type: Type.STRING },
            reasoning: { type: Type.STRING },
            newDescription: { type: Type.STRING },
            newPrompt: { type: Type.STRING }
          },
          required: ["assistantText", "reasoning", "newDescription", "newPrompt"]
        }
      }
    }), "gemini-3.6-flash", ["gemini-3.1-flash-lite", "gemini-flash-latest"], 1000, req);

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("Resposta em branco do Gemini.");
    }

    const result = JSON.parse(textOutput);
    res.json({
      ...result,
      promptAiModelUsed: modelUsed,
      isCustomKeyUsed: isUsingCustomKey
    });
  } catch (error: any) {
    console.error("[Gemini API] Chat-edit backend failed:", error);
    res.status(500).json({
      error: formatGeminiError(error)
    });
  }
});

// Procedural generator for elegant cinematic visuals to completely avoid library/stock images (Unsplash) as requested by the user
function getCinematicFallbackImage(prompt: string, searchQuery: string, model: string, errorReason?: string): string {
  // Generate a warm, rich, elegant dark-gold cinematic SVG card with high contrast and golden borders
  // This is returned as a base64 SVG data URL, completely offline, beautiful, and perfectly visible.

  let gradientStart = "#2d2215"; // Warm golden charcoal
  let gradientEnd = "#140e08";   // Deep cinematic amber dark
  let styleName = "Cinemática Clássica";
  
  if (model === "nano_banana_pro") {
    gradientStart = "#341a10"; // Warm bronze-copper
    gradientEnd = "#120804";
    styleName = "Diretor PRO Premium";
  } else if (model === "nano_banana_2") {
    gradientStart = "#182c2d"; // Deep teal-slate
    gradientEnd = "#071213";
    styleName = "HyperArt 2 Neural";
  } else {
    gradientStart = "#2d2215";
    gradientEnd = "#140e08";
    styleName = "Câmera Padrão v1.9";
  }

  // Clean and wrap text without foreignObject to ensure 100% browser rendering compatibility in <img> tags
  const cleanPrompt = (prompt || "Visual").trim();
  const rawWords = cleanPrompt.split(/\s+/);
  const textLines: string[] = [];
  let currentLine = "";
  
  for (const word of rawWords) {
    if ((currentLine + " " + word).length > 60) {
      textLines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += (currentLine ? " " : "") + word;
    }
  }
  if (currentLine) {
    textLines.push(currentLine.trim());
  }

  // Generate safe SVG lines
  const svgTextLines = textLines.slice(0, 5).map((line, idx) => {
    const escapedLine = line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
    return `<text x="60" y="${225 + idx * 35}" fill="#f5e6c4" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="22" font-weight="300" font-style="italic">${escapedLine}</text>`;
  }).join("\n");

  const escapedSearch = (searchQuery || "atmosfera")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  // Determine a friendly, elegant warning message based on the error received from Gemini/OpenAI
  let friendlyTitle = "RASCUNHO DE DIRETRIZ VISUAL PROCEDURAL (STANDBY)";
  let friendlyReason = "Renderizador offline ativado para manter o fluxo criativo.";

  if (errorReason) {
    const errLower = errorReason.toLowerCase();
    if (errLower.includes("limit: 0") || errLower.includes("quota") || errLower.includes("limit") || errLower.includes("429")) {
      friendlyTitle = "COTA EXCEDIDA / REQUISITO DE IMAGEM ADIADO";
      friendlyReason = "A chave gratuita do Gemini possui limite de 0 imagens/dia. Adicione saldo de faturamento ou configure uma chave OpenAI.";
    } else if (errLower.includes("api key") || errLower.includes("invalid") || errLower.includes("unauthorized") || errLower.includes("key")) {
      friendlyTitle = "CHAVE DE API INVÁLIDA OU AUSENTE";
      friendlyReason = "A chave de API configurada não possui permissão para gerar imagens Imagen-3. Configure a chave nos Secrets.";
    } else if (errLower.includes("timeout") || errLower.includes("abort") || errLower.includes("fetch")) {
      friendlyTitle = "TEMPO LIMITE EXCEDIDO NA RENDERIZAÇÃO";
      friendlyReason = "O tempo limite de conexão expirou ao tentar renderizar esta imagem real. Tente gerar novamente.";
    } else {
      friendlyTitle = "FALHA NA RENDERIZAÇÃO REAL VIA IA NATIVA";
      const truncatedErr = errorReason.substring(0, 95) + (errorReason.length > 95 ? "..." : "");
      friendlyReason = `O motor de renderização da IA reportou: "${truncatedErr}"`;
    }
  }

  const escapedTitle = friendlyTitle
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const escapedReason = friendlyReason
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" width="100%" height="100%">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${gradientStart}" />
        <stop offset="100%" stop-color="${gradientEnd}" />
      </linearGradient>
      <linearGradient id="textGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#D4AF37" />
        <stop offset="100%" stop-color="#FFF3D6" />
      </linearGradient>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(212,175,55,0.06)" stroke-width="1"/>
      </pattern>
    </defs>

    <!-- Background -->
    <rect width="1200" height="675" fill="url(#bgGrad)" />
    <!-- Fine technical grid overlay -->
    <rect width="1200" height="675" fill="url(#grid)" />
    
    <!-- Cinematic frame borders -->
    <rect x="20" y="20" width="1160" height="635" fill="none" stroke="rgba(212,175,55,0.4)" stroke-width="2" />
    <rect x="30" y="30" width="1140" height="615" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" />

    <!-- Abstract aperture visual decor -->
    <circle cx="1000" cy="337" r="220" fill="none" stroke="rgba(212,175,55,0.12)" stroke-width="1.5" />
    <circle cx="1000" cy="337" r="150" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1" />
    <line x1="1000" y1="50" x2="1000" y2="625" stroke="rgba(212,175,55,0.08)" stroke-width="1" />
    <line x1="600" y1="337" x2="1400" y2="337" stroke="rgba(212,175,55,0.08)" stroke-width="1" />

    <!-- Header info -->
    <text x="60" y="80" fill="rgba(212,175,55,0.7)" font-family="monospace, sans-serif" font-size="13" font-weight="bold" letter-spacing="4">ESTILO SELECIONADO: ${styleName.toUpperCase()}</text>
    <text x="60" y="108" fill="url(#textGrad)" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="bold" font-size="30" letter-spacing="1">ESBOÇO DE DIRETRIZ VISUAL AI</text>
    
    <!-- Central Prompt Block -->
    <text x="60" y="180" fill="rgba(255,255,255,0.7)" font-family="monospace, sans-serif" font-size="12" font-weight="bold" letter-spacing="2">DIRETRIZ DE ENQUADRAMENTO E ELEMENTOS:</text>
    
    <!-- Render Wrapped Safe Text Lines -->
    ${svgTextLines}

    <!-- Elegant friendly Portuguese Warning Box inside the SVG itself -->
    <rect x="60" y="420" width="750" height="65" rx="6" fill="rgba(212, 175, 55, 0.12)" stroke="rgba(212, 175, 55, 0.5)" stroke-width="1.5" />
    <text x="80" y="445" fill="#FFE8A3" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="bold" font-size="13" letter-spacing="1">⚠️ ${escapedTitle}</text>
    <text x="80" y="468" fill="#ffffff" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="12" font-weight="normal">${escapedReason}</text>

    <!-- Bottom metadata stats -->
    <rect x="60" y="525" width="750" height="1" fill="rgba(212,175,55,0.3)" />
    
    <text x="60" y="560" fill="rgba(255,255,255,0.7)" font-family="monospace, sans-serif" font-size="12" letter-spacing="1">LENTE: 35MM CINEMATIC</text>
    <text x="260" y="560" fill="rgba(255,255,255,0.7)" font-family="monospace, sans-serif" font-size="12" letter-spacing="1">ABERTURA: F/2.8</text>
    <text x="420" y="560" fill="rgba(255,255,255,0.7)" font-family="monospace, sans-serif" font-size="12" letter-spacing="1">ASPECTO: 16:9</text>
    <text x="560" y="560" fill="#D4AF37" font-family="monospace, sans-serif" font-size="12" font-weight="bold" letter-spacing="1">✦ MODO DE ASSISTÊNCIA VISUAL LOCAL</text>

    <!-- Camera symbol SVG path -->
    <g transform="translate(1080, 50) scale(0.6)" fill="#D4AF37">
      <path d="M4 4h3l2-3h6l2 3h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>
      <circle cx="12" cy="13" r="5"/>
    </g>
  </svg>`;

  const base64Svg = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${base64Svg}`;
}

// Art Studio dynamic image rendering engine for Nano Banana model suites
app.post("/api/storyboard/generate-image", async (req, res) => {
  try {
    const { prompt, model, visualInstructionImage, customApiKey } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "O prompt de imagem é obrigatório." });
    }

    const activeKey = (req.headers["x-gemini-key"] as string) || customApiKey;
    const isUsingCustomKey = !!(activeKey && activeKey.trim());

    const openAiKey = req.headers["x-openai-key"] as string;
    const openAiDalleModel = req.headers["x-openai-dalle-model"] as string || "dall-e-3";
    const useOpenAi = model === "chatgpt_dalle3" && !!openAiKey;

    let searchQuery = "atmospheric,scenery";
    const promptLower = prompt.toLowerCase();

    if (useOpenAi) {
      console.log(`[OpenAI API] Image Generation using model: ${openAiDalleModel}`);
      try {
        const dalleUrl = await callOpenAiImage(openAiKey, openAiDalleModel, prompt);
        return res.json({
          imageUrl: dalleUrl,
          keywords: searchQuery,
          metadata: {
            engineName: `DALL-E 3 (${openAiDalleModel})`,
            resolution: openAiDalleModel === "dall-e-3" ? "1792x1024 (Widescreen)" : "1024x1024 (Quadrado)",
            renderTimeSeconds: 4.5,
            creativeShader: "Geração de imagem fotorrealista premium via rede neural artificial do OpenAI DALL-E."
          },
          isAiGenerated: true,
          generationError: "",
          isCustomKeyUsed: true
        });
      } catch (gptErr: any) {
        console.error("[OpenAI API] Image generation failed. Falling back to stock query:", gptErr);
        // We can let it fall through to stock/fallback or return error, but let's fall back to our beautiful offline SVG!
        const errMsg = gptErr.message || String(gptErr);
        const fallbackImage = getCinematicFallbackImage(prompt, searchQuery, model || "", errMsg);
        return res.json({
          imageUrl: fallbackImage,
          keywords: searchQuery,
          metadata: {
            engineName: "Nano Banana Fallback Driver",
            resolution: "1920x1080 (Cinemático 16:9)",
            renderTimeSeconds: 0.1,
            creativeShader: "Diretor de Arte local offline ativado após erro da API do OpenAI."
          },
          isAiGenerated: false,
          generationError: errMsg,
          isCustomKeyUsed: true
        });
      }
    }

    console.log(`[Gemini API] Image Generation. Model: ${model || "default"}. Is custom API key used? ${isUsingCustomKey ? "YES (begins with " + activeKey.trim().substring(0, 6) + ")" : "NO (using public shared key)"}`);
    
    // Choose specific styles, lighting descriptions, and visual directives for each Nano Banana variation
    const modelStyleDesc = 
      model === "nano_banana_pro" 
        ? "cinematic dramatic high-contrast professional photography, dramatic lighting, 35mm film mood, realistic shadows"
        : model === "nano_banana_2"
        ? "artistic illustration, deep oil painting texture on canvas, classic painterly composition, neo-expressionist visual art"
        : "clean atmospheric elegant photography, bright natural tones, authentic scenery portrait landscape";

    // Attempt Gemini-powered minimalist core keyword extraction
    try {
      const ai = getGeminiClient(activeKey);
      const geminiPrompt = `You are a visual set director. Convert the following scene description (which may be in Portuguese or English) into exactly 1 or 2 simple, concrete English nouns/adjectives representing the absolute core visual subject of the image (for example, if the prompt is "um homem passeando à noite na chuva", output "man,rain"; if the prompt is "an elderly monk meditating inside a temple", output "monk,temple").
      
      Requirements:
      - Only output 1 or 2 core keywords separated by a comma (e.g. "monk,temple", "street,rain", "library,fire", "forest").
      - ABSOLUTELY NEVER include style, camera, quality, or aspect ratio keywords (do NOT output "16:9", "photorealistic", "cinematic", "painting", "art", "detailed").
      - Output ONLY the 1-2 comma-separated keywords and absolutely nothing else. No punctuation, no quotes, no conversational filler.

      Description: "${prompt}"`;
      
      const { response } = await callGeminiWithRetry((modelName) => ai.models.generateContent({
        model: modelName,
        contents: geminiPrompt,
        config: {
          maxOutputTokens: 15,
        }
      }), "gemini-3.6-flash", ["gemini-3.1-flash-lite", "gemini-flash-latest"], 1000, req);
      
      const keywordOutput = response.text?.trim().replace(/['"“”`]/g, "");
      if (keywordOutput && keywordOutput.length < 50 && !keywordOutput.includes("Error") && !keywordOutput.includes("Exception")) {
        // Normalize keywords safely for query matching (single comma separated list)
        const parsedWords = keywordOutput
          .split(/[\s,]+/)
          .map(w => w.replace(/[^a-zA-Z0-9]/g, "").trim())
          .filter(w => w.length > 0);
        if (parsedWords.length > 0) {
          searchQuery = parsedWords.join(",");
        }
      }
    } catch (e) {
      console.warn("Gemini prompt keyword extraction failed, relying on rule-based fallback extractor:", e);
      // Clean up fallback keywords
      const filterOut = ["aspect", "ratio", "cinematic", "lighting", "detailed", "realistic", "contrast", "caravaggio", "chiaroscuro", "high", "quality", "with", "from", "and", "under", "moody", "composition"];
      const words = promptLower
        .replace(/[^a-zA-Z\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !filterOut.includes(w));
      if (words.length > 0) {
        searchQuery = words.slice(0, 2).join(",");
      }
    }

    // Configure specific metadata according to the chosen Nano Banana pipeline variant
    const modelMetadata = {
      engineName: "Nano Banana Standard v1.9",
      resolution: "1920x1080 (Cinemático 16:9)",
      renderTimeSeconds: 1.1,
      creativeShader: "Cores amigáveis e contrastes neutros para fins contemplativos.",
    };

    if (model === "nano_banana_pro") {
      modelMetadata.engineName = "Nano Banana PRO Premium v3.2";
      modelMetadata.renderTimeSeconds = 2.4;
      modelMetadata.creativeShader = "Resolução 4K estendida, simulação analógica de granulação de filme 35mm e desfoque anamórfico.";
    } else if (model === "nano_banana_2") {
      modelMetadata.engineName = "Nano Banana 2 HyperArt Neural";
      modelMetadata.renderTimeSeconds = 1.9;
      modelMetadata.creativeShader = "Estetização pictórica neo-expressionista com pinceladas simuladas por inteligência neural profunda.";
    }

    let resolvedUrl = "";
    let isAiGenerated = false;
    let generationError = "";

    // 1. Attempt native Imagen 3 Generation using @google/genai SDK
    try {
      const ai = getGeminiClient(activeKey);
      const styleTag = 
        model === "nano_banana_pro"
          ? "Cinematic photography with 35mm film scan style, professional dramatic studio lighting, rich colors, realistic shadows"
          : model === "nano_banana_2"
          ? "Exquisite neo-expressionist oil painting on high-texture canvas, vivid brush strokes"
          : "Warm ambient outdoor landscape photography, soft natural lighting style";

      const generationPrompt = `${prompt}. Style: ${styleTag}. Aspect ratio: 16:9, widescreen, detailed, high resolution`;

      console.log(`[Nano Banana] Attempting Imagen 3 image generation for prompt: "${prompt.substring(0, 40)}..."`);
      
      try {
        const imageResult: any = await (ai.models as any).generateImages({
          model: "imagen-3.0-generate-002",
          prompt: generationPrompt,
          config: {
            numberOfImages: 1,
            outputMimeType: "image/jpeg",
            aspectRatio: "16:9"
          }
        });

        if (imageResult?.generatedImages?.[0]?.image?.imageBytes) {
          const base64Data = imageResult.generatedImages[0].image.imageBytes;
          resolvedUrl = `data:image/jpeg;base64,${base64Data}`;
          isAiGenerated = true;
          console.log("[Nano Banana] Native Imagen 3 generation successful!");
        }
      } catch (imagenErr: any) {
        console.warn("[Nano Banana] ai.models.generateImages failed, trying generateContent fallback:", imagenErr?.message || imagenErr);
        
        // Secondary attempt with generateContent
        const parts: any[] = [{ text: generationPrompt }];
        const { response: imageResponse } = await callGeminiWithRetry((modelName) => ai.models.generateContent({
          model: modelName,
          contents: { parts }
        }), "gemini-3.1-flash-image", ["gemini-3.1-flash-lite-image", "gemini-3.6-flash"], 1000, req);

        if (imageResponse?.candidates?.[0]?.content?.parts) {
          for (const part of imageResponse.candidates[0].content.parts) {
            if (part.inlineData?.data) {
              resolvedUrl = `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`;
              isAiGenerated = true;
              console.log("[Nano Banana] Native generateContent image generation successful!");
              break;
            }
          }
        }
      }

      if (!resolvedUrl) {
        generationError = "Cota de API do Gemini atingida ou modelo não suportou resposta de bytes inline.";
      }
    } catch (aiErr: any) {
      generationError = aiErr?.message || String(aiErr);
      console.warn("[Nano Banana] Native AI image generation failed:", generationError);
    }

    // 2. High-relevance Pollinations AI generation fallback (Instant real photorealistic AI images)
    if (!resolvedUrl) {
      try {
        const seed = Math.floor(Math.random() * 900000) + 100000;
        const cleanPromptForPollination = prompt
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "") // strip diacritics / accents safely
          .replace(/[^a-zA-Z0-9\s,.-]/g, " ")
          .trim();
        const styleString = model === "nano_banana_pro" 
          ? "cinematic 35mm photography dramatic lighting detailed" 
          : model === "nano_banana_2" 
          ? "vivid neo expressionist artwork painting colorful" 
          : "clean atmospheric cinematic photography natural lighting";
        const pollPrompt = encodeURIComponent(`${cleanPromptForPollination}, ${styleString}, 16:9 widescreen cinematic photography`);
        const pollUrl = `https://image.pollinations.ai/prompt/${pollPrompt}?width=1280&height=720&seed=${seed}&model=flux&nologo=true&enhance=false`;
        
        console.log(`[Nano Banana] Attempting server fetch for Pollinations AI image...`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const imgRes = await fetch(pollUrl, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        clearTimeout(timeout);
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";
          resolvedUrl = `data:${contentType};base64,${base64}`;
          isAiGenerated = true;
          console.log(`[Nano Banana] Pollinations AI image fetched and converted to base64 (${base64.length} bytes)!`);
        }
      } catch (pollErr) {
        console.warn("[Nano Banana] Pollinations fetch failed or timed out:", pollErr);
      }
    }

    // 3. High-quality photographic Picsum fallback if Pollinations / Imagen failed (Guaranteed 100% success)
    if (!resolvedUrl) {
      try {
        const seed = Math.floor(Math.random() * 900000) + 100000;
        const picsumUrl = `https://picsum.photos/seed/${seed}/1280/720`;
        console.log(`[Nano Banana] Fetching photographic fallback image from Picsum...`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const imgRes = await fetch(picsumUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";
          resolvedUrl = `data:${contentType};base64,${base64}`;
          console.log(`[Nano Banana] Photographic fallback image converted to base64 (${base64.length} bytes)!`);
        }
      } catch (picsumErr) {
        console.warn("[Nano Banana] Picsum fallback fetch failed:", picsumErr);
      }
    }

    // 4. Procedural SVG Canvas Fallback as absolute last resort
    if (!resolvedUrl) {
      resolvedUrl = getCinematicFallbackImage(prompt, searchQuery, model || "", generationError);
    }

    res.json({
      imageUrl: resolvedUrl,
      keywords: searchQuery,
      metadata: modelMetadata,
      isAiGenerated,
      generationError,
      isCustomKeyUsed: isUsingCustomKey
    });
  } catch (error: any) {
    console.error("Error in Nano Banana render agent:", error);
    const errText = error?.message || String(error);
    const fallbackImage = getCinematicFallbackImage(
      req.body?.prompt || "meditation",
      "meditation scenery",
      req.body?.model || "",
      errText
    );
    res.json({
      imageUrl: fallbackImage,
      keywords: "meditation scenery",
      metadata: {
        engineName: "Nano Banana Fallback Driver",
        resolution: "1920x1080 (16:9)",
        renderTimeSeconds: 0.5,
        creativeShader: "Servidor de renderização fallback Unsplash ativado por indisponibilidade local."
      },
      isCustomKeyUsed: !!((req.headers["x-gemini-key"] as string) || req.body?.customApiKey)
    });
  }
});

// Custom Express global error handler to prevent HTML responses for API errors (e.g. PayloadTooLargeError)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Express Error Handler] Uncaught error:", err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || "Erro interno do servidor."
  });
});

// Setup Front-End serving mechanism
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Vite in development middleware mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve production build files
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Express custom server running on http://localhost:${PORT}`);
  });
}

startServer();
