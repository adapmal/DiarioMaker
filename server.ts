import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import multer from "multer";

dotenv.config();

const app = express();
const PORT = 3000;

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 250 * 1024 * 1024 } });

const SESSION_FILE_PATH = path.join(process.cwd(), "session_store.json");
const USER_CONFIG_PATH = path.join(process.cwd(), "user_config.json");
const API_SECRETS_PATH = path.join(process.cwd(), "api_secrets.json");
const PROJECTS_DIR = path.join(process.cwd(), "projects");
const SERVER_LOG_FILE = path.join(process.cwd(), "server_error.log");

function logErrorToFile(context: string, err: any) {
  const timestamp = new Date().toISOString();
  const message = err?.stack || err?.message || String(err);
  const logLine = `[${timestamp}] [${context}] ${message}\n----------------------------------------\n`;
  console.error(logLine);
  try {
    fs.appendFileSync(SERVER_LOG_FILE, logLine, "utf-8");
  } catch (_) {}
}

// Helper to load sensitive API keys from git-ignored api_secrets.json
function loadApiSecrets() {
  try {
    if (fs.existsSync(API_SECRETS_PATH)) {
      const data = fs.readFileSync(API_SECRETS_PATH, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn("Failed to load api_secrets.json:", err);
  }
  return {};
}

// Helper to load settings from user_config.json merged with api_secrets.json
function loadUserConfig() {
  let config: any = {};
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const data = fs.readFileSync(USER_CONFIG_PATH, "utf-8");
      config = JSON.parse(data);
    }
  } catch (err) {
    console.warn("Failed to load user_config.json:", err);
  }
  const secrets = loadApiSecrets();
  return { ...config, ...secrets };
}

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

// Enable JSON body parser with generous 500mb limit for projects with heavy Base64 image caches
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));

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
    const jsonStr = JSON.stringify(sessionData, null, 2);
    try {
      fs.writeFileSync(SESSION_AUTOSAVE_PATH, jsonStr, "utf-8");
    } catch (wErr) {
      try {
        const tmpPath = `${SESSION_AUTOSAVE_PATH}.tmp_${Date.now()}`;
        fs.writeFileSync(tmpPath, jsonStr, "utf-8");
        fs.renameSync(tmpPath, SESSION_AUTOSAVE_PATH);
      } catch (rErr) {
        console.warn("Retried atomic write for session_store_autosave.json:", rErr);
      }
    }
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
    const jsonStr = JSON.stringify(sessionData, null, 2);
    try {
      fs.writeFileSync(SESSION_FILE_PATH, jsonStr, "utf-8");
    } catch (wErr) {
      try {
        const tmpPath = `${SESSION_FILE_PATH}.tmp_${Date.now()}`;
        fs.writeFileSync(tmpPath, jsonStr, "utf-8");
        fs.renameSync(tmpPath, SESSION_FILE_PATH);
      } catch (rErr) {
        console.warn("Retried atomic write for session_store.json:", rErr);
      }
    }
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Error writing session file:", error);
    return res.status(500).json({ error: "Failed to persist session to server storage." });
  }
});

// Endpoint to physically clean up session_store.json, session_store_autosave.json, and temporary project images
app.post("/api/storyboard/projects/clear-cache", (req, res) => {
  try {
    const { folder } = req.body;
    
    // Delete legacy local session stores
    if (fs.existsSync(SESSION_FILE_PATH)) {
      fs.unlinkSync(SESSION_FILE_PATH);
    }
    if (fs.existsSync(SESSION_AUTOSAVE_PATH)) {
      fs.unlinkSync(SESSION_AUTOSAVE_PATH);
    }

    // Delete generated project images for target project folder if requested
    if (folder && typeof folder === "string") {
      const safeFolder = path.basename(folder);
      const imagesDir = path.join(process.cwd(), "projects", safeFolder, "imagens");
      
      if (fs.existsSync(imagesDir)) {
        const files = fs.readdirSync(imagesDir);
        for (const file of files) {
          const filePath = path.join(imagesDir, file);
          if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
          }
        }
      }
    }

    return res.json({ success: true, message: "Physical cache and autosave files successfully deleted." });
  } catch (err: any) {
    console.error("Error cleaning physical server cache:", err);
    return res.status(500).json({ error: `Failed to clear server physical cache: ${err.message}` });
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
    const jsonStr = JSON.stringify(sessionData, null, 2);
    try {
      fs.writeFileSync(projectJsonPath, jsonStr, "utf-8");
    } catch (wErr) {
      try {
        const tmpPath = `${projectJsonPath}.tmp_${Date.now()}`;
        fs.writeFileSync(tmpPath, jsonStr, "utf-8");
        fs.renameSync(tmpPath, projectJsonPath);
      } catch (rErr) {
        console.warn("Retried atomic write for project JSON:", rErr);
      }
    }

    try {
      fs.writeFileSync(SESSION_FILE_PATH, jsonStr, "utf-8");
    } catch (sErr) {
      try {
        const tmpPath = `${SESSION_FILE_PATH}.tmp_${Date.now()}`;
        fs.writeFileSync(tmpPath, jsonStr, "utf-8");
        fs.renameSync(tmpPath, SESSION_FILE_PATH);
      } catch (rErr) {
        console.warn("Failed to write global session file:", rErr);
      }
    }

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
  const config = loadUserConfig();
  const effectiveKey = (customApiKey && customApiKey.trim()) || config.customGeminiKey || process.env.GEMINI_API_KEY;

  if (effectiveKey && effectiveKey.trim()) {
    const cleanedKey = effectiveKey.trim().replace(/^["']|["']$/g, "");
    if (cleanedKey) {
      return new GoogleGenAI({
        apiKey: cleanedKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
          timeout: 600000,
        },
      });
    }
  }

  throw new Error("A chave GEMINI_API_KEY está ausente no ambiente do servidor. Por favor, insira sua chave de API do Google Gemini (ex: AIzaSy...) no painel de Configurações.");
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

  // Support local relative paths (e.g. starting with '/projects/') by reading directly from the filesystem
  if (url.startsWith("/") || (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("data:"))) {
    try {
      const decodedUrl = decodeURIComponent(url);
      const relativePath = decodedUrl.startsWith("/") ? decodedUrl.substring(1) : decodedUrl;
      const localPath = path.join(process.cwd(), relativePath);
      
      if (fs.existsSync(localPath)) {
        const stats = await fs.promises.stat(localPath);
        if (stats.isFile()) {
          const buffer = await fs.promises.readFile(localPath);
          const ext = path.extname(localPath).toLowerCase();
          if (ext.includes("svg") || ext.includes("xml")) {
            return null;
          }
          const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
          return {
            mimeType,
            data: buffer.toString("base64")
          };
        }
      }
    } catch (err) {
      console.warn(`[Gemini API] Failed to read local filesystem path for inlineData: ${url}`, err);
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

// Helper to map fictional or deprecated model names to real, current Gemini model names
function mapModelName(name: string): string {
  if (!name) return "gemini-flash-latest";
  const lower = name.toLowerCase();
  if (lower === "gemini-3.1-pro-preview" || lower === "gemini-3.1-pro") {
    return "gemini-2.5-pro";
  }
  return name;
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
  
  // Strict single-model execution (no auto-fallback to unwanted models)
  let modelsToTry = [preferredModel];
  
  for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
    const currentModel = modelsToTry[attempt];
    const actualModel = mapModelName(currentModel);
    
    try {
      console.log(`[Gemini API] Routing call: ${currentModel} -> ${actualModel}`);
      const res = await apiCall(actualModel);
      // Clear failure record upon successful call
      if (modelStabilityMap[currentModel]) {
        modelStabilityMap[currentModel].failureCount = 0;
      }
      return { response: res, modelUsed: currentModel };
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.code || 0;
      const message = String(err?.message || err).toLowerCase();
      
      const shouldFallback = 
        status === 404 || 
        status === 403 || 
        message.includes("not found") ||
        message.includes("not authorized") ||
        message.includes("does not exist") ||
        message.includes("permission");

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
         
      if (isTransient || shouldFallback) {
        // Update stability stats
        const errTime = Date.now();
        if (!modelStabilityMap[currentModel]) {
          modelStabilityMap[currentModel] = { lastFailureTime: errTime, failureCount: 1 };
        } else {
          modelStabilityMap[currentModel].lastFailureTime = errTime;
          modelStabilityMap[currentModel].failureCount++;
        }

        if (attempt < modelsToTry.length - 1) {
          const reason = shouldFallback ? "indisponível/não encontrado" : "instável ou sobrecarregado";
          console.warn(`[Gemini API] Modelo ${currentModel} ${reason} (tentativa ${attempt + 1}/${modelsToTry.length}): ${err?.message || err}. Tentando modelo fallback ${modelsToTry[attempt + 1]}...`);
          const activeDelay = shouldFallback ? 50 : delay;
          await new Promise((resolve) => setTimeout(resolve, activeDelay));
          if (!shouldFallback) {
            delay *= 1.5;
          }
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
async function callOpenAiImage(apiKey: string, model: string, prompt: string): Promise<string> {
  const url = "https://api.openai.com/v1/images/generations";
  const targetModel = (model && model.trim()) ? model.trim() : "gpt-image-2";
  const payload: any = {
    model: targetModel,
    prompt: prompt,
    n: 1,
  };
  
  if (targetModel === "dall-e-2") {
    payload.size = "1024x1024";
  } else {
    payload.size = "1792x1024";
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
  const rawUrl = data.data[0]?.url;
  const b64Json = data.data[0]?.b64_json;

  if (b64Json) {
    return `data:image/png;base64,${b64Json}`;
  }

  if (rawUrl && rawUrl.startsWith("http")) {
    try {
      const imgRes = await fetch(rawUrl);
      if (imgRes.ok) {
        const arrayBuf = await imgRes.arrayBuffer();
        const base64Str = Buffer.from(arrayBuf).toString("base64");
        const mime = imgRes.headers.get("content-type") || "image/png";
        return `data:${mime};base64,${base64Str}`;
      }
    } catch (fetchErr) {
      console.warn("[OpenAI API] Failed to convert image URL to Base64 server-side:", fetchErr);
    }
  }

  return rawUrl || "";
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
app.get("/api/storyboard/config", (req, res) => {
  try {
    const config = loadUserConfig();
    return res.json(config);
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load server configurations." });
  }
});

app.post("/api/storyboard/config", (req, res) => {
  try {
    const { customGeminiKey, customOpenAiKey, ...generalConfig } = req.body;
    
    // Save API secrets separately to api_secrets.json (git-ignored)
    if (customGeminiKey !== undefined || customOpenAiKey !== undefined) {
      const currentSecrets = loadApiSecrets();
      const updatedSecrets = {
        ...currentSecrets,
        ...(customGeminiKey !== undefined && { customGeminiKey }),
        ...(customOpenAiKey !== undefined && { customOpenAiKey })
      };
      fs.writeFileSync(API_SECRETS_PATH, JSON.stringify(updatedSecrets, null, 2), "utf-8");
    }

    // Save general non-sensitive preferences to user_config.json
    const currentConfig = loadUserConfig();
    delete currentConfig.customGeminiKey;
    delete currentConfig.customOpenAiKey;
    
    const newGeneralConfig = {
      ...currentConfig,
      ...generalConfig
    };
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(newGeneralConfig, null, 2), "utf-8");
    
    const fullMergedConfig = loadUserConfig();
    return res.json({ success: true, config: fullMergedConfig });
  } catch (err: any) {
    console.error("Error saving server configurations:", err);
    return res.status(500).json({ error: "Failed to save server configurations." });
  }
});

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

// Endpoint to list dynamically available Gemini and OpenAI models (both prompt/text and image/imagen)
app.get("/api/storyboard/available-models", async (req, res) => {
  const customApiKey = req.query.customApiKey as string || "";
  const openAiKey = req.query.openAiKey as string || "";
  
  const activeGeminiKey = (req.headers["x-gemini-key"] as string) || customApiKey || process.env.GEMINI_API_KEY || "";
  const activeOpenAiKey = (req.headers["x-openai-key"] as string) || openAiKey || process.env.OPENAI_API_KEY || "";

  const geminiTextModels: string[] = [];
  const geminiImageModels: string[] = [];
  const openAiTextModels: string[] = [];
  const openAiImageModels: string[] = [];

  if (activeGeminiKey && activeGeminiKey.trim()) {
    try {
      const ai = getGeminiClient(activeGeminiKey);
      const list = await ai.models.list();
      if (list && Array.isArray(list)) {
        list.forEach((m: any) => {
          if (m.name) {
            const name = m.name.replace(/^models\//, "");
            // Filter text generation models
            if (name.includes("gemini") && !name.includes("vision") && !name.includes("embed")) {
              geminiTextModels.push(name);
            }
            // Filter image models
            if (name.includes("imagen")) {
              geminiImageModels.push(name);
            }
          }
        });
      }
    } catch (err) {
      console.warn("[Gemini API] Failed to list models dynamically, using defaults:", err);
    }
  }

  // Fallback defaults for Gemini
  if (geminiTextModels.length === 0) {
    geminiTextModels.push(
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash-lite",
      "gemini-1.5-flash",
      "gemini-1.5-pro"
    );
  }
  if (geminiImageModels.length === 0) {
    geminiImageModels.push(
      "imagen-3.0-generate-002",
      "imagen-3.0-fast-001"
    );
  }

  if (activeOpenAiKey && activeOpenAiKey.trim()) {
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${activeOpenAiKey}` }
      });
      if (response.ok) {
        const data = await response.json();
        if (data && Array.isArray(data.data)) {
          data.data.forEach((m: any) => {
            const id = m.id || "";
            if (id.includes("image") || id.startsWith("dall-e")) {
              openAiImageModels.push(id);
            } else if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("chatgpt")) {
              openAiTextModels.push(id);
            }
          });
        }
      }
    } catch (err) {
      console.warn("[OpenAI API] Failed to list models dynamically, using defaults:", err);
    }
  }

  // Fallback defaults for OpenAI
  if (openAiTextModels.length === 0) {
    openAiTextModels.push(
      "gpt-4o-mini",
      "gpt-4o",
      "gpt-4.5-preview",
      "o1-mini",
      "o3-mini"
    );
  }
  if (openAiImageModels.length === 0) {
    openAiImageModels.push(
      "gpt-image-2",
      "gpt-image-1.5",
      "gpt-image-1",
      "gpt-image-1-mini",
      "dall-e-3",
      "dall-e-2"
    );
  }

  res.json({
    gemini: {
      text: [...new Set(geminiTextModels)].sort(),
      image: [...new Set(geminiImageModels)].sort()
    },
    openai: {
      text: [...new Set(openAiTextModels)].sort(),
      image: [...new Set(openAiImageModels)].sort()
    }
  });
});

function sanitizeProjectName(name?: string): string {
  if (!name || typeof name !== "string") return "meu-projeto";
  const clean = path.basename(name).replace(/[^a-zA-Z0-9_\-]/g, "_").trim();
  return clean || "meu-projeto";
}

// Audio Narration Transcription & Alignment Endpoint using Gemini Multimodal Audio API
app.post("/api/storyboard/transcribe-audio", upload.single("audio"), async (req: any, res: any) => {
  if (req.setTimeout) req.setTimeout(600000);
  if (res.setTimeout) res.setTimeout(600000);
  try {
    let audioBuffer: Buffer | null = null;
    let audioMimeType = "audio/mp3";
    let projectName = req.body?.projectName;

    if (req.file) {
      audioBuffer = req.file.buffer;
      audioMimeType = req.file.mimetype || "audio/mp3";
    } else if (req.body?.audioBase64) {
      const cleanBase64 = req.body.audioBase64.includes(";base64,") ? req.body.audioBase64.split(";base64,")[1] : req.body.audioBase64;
      audioBuffer = Buffer.from(cleanBase64, "base64");
      if (req.body.audioMimeType) audioMimeType = req.body.audioMimeType;
    } else if (projectName && typeof projectName === "string" && projectName.trim()) {
      const safeName = sanitizeProjectName(projectName);
      const projDir = path.join(PROJECTS_DIR, safeName);
      const possibleFiles = ["narration.wav", "narration.mp3", "narration.m4a", "narration.ogg"];
      for (const fname of possibleFiles) {
        const fpath = path.join(projDir, fname);
        if (fs.existsSync(fpath)) {
          audioBuffer = fs.readFileSync(fpath);
          audioMimeType = fname.endsWith(".wav") ? "audio/wav" : "audio/mp3";
          break;
        }
      }
    }

    if (!audioBuffer) {
      return res.status(400).json({ error: "Arquivo de áudio não encontrado no servidor para este projeto." });
    }

    // Normalize audio MIME type for Gemini API
    let cleanMime = audioMimeType.toLowerCase();
    if (req.file?.originalname) {
      const origName = req.file.originalname.toLowerCase();
      if (origName.endsWith(".wav")) cleanMime = "audio/wav";
      else if (origName.endsWith(".mp3")) cleanMime = "audio/mp3";
      else if (origName.endsWith(".m4a")) cleanMime = "audio/mp3";
      else if (origName.endsWith(".aac")) cleanMime = "audio/aac";
      else if (origName.endsWith(".ogg")) cleanMime = "audio/ogg";
    }
    if (cleanMime === "application/octet-stream" || cleanMime.includes("x-wav") || cleanMime.includes("wave")) {
      cleanMime = "audio/wav";
    }

    if (projectName && audioBuffer) {
      try {
        const safeName = sanitizeProjectName(projectName);
        const projDir = path.join(PROJECTS_DIR, safeName);
        if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
        const targetExt = cleanMime.includes("wav") ? ".wav" : ".mp3";
        fs.writeFileSync(path.join(projDir, `narration${targetExt}`), audioBuffer);
      } catch (saveErr) {
        console.warn("[Audio Engine] Non-fatal error saving narration file to project disk:", saveErr);
      }
    }

    const activeKey = (req.headers["x-gemini-key"] as string) || req.body?.customApiKey;
    const ai = getGeminiClient(activeKey);

    const base64Data = audioBuffer.toString("base64");
    const audioPart = {
      inlineData: {
        data: base64Data,
        mimeType: cleanMime
      }
    };

    const promptText = `Listen to this Portuguese narration audio carefully.
Perform the following tasks:
1. Transcribe the entire narration text accurately into Brazilian Portuguese (PT-BR).
2. Extract word-level or sentence-level timestamps in seconds.
3. Automatically divide the narration into natural storyboard scenes based on natural speech pauses (silence gaps > 0.5s) or sentence boundaries.

Return a JSON object containing:
- "fullScript": full text transcription (string)
- "timedWords": array of [{ "word": "palavra", "start": number, "end": number }]
- "scenes": array of [{ "sceneNumber": "1", "text": "trecho falado", "startTime": number, "endTime": number }]`;

    console.log("[Audio Engine] Transcribing narration audio using Gemini Multimodal Audio API...");
    const { response } = await callGeminiWithRetry((modelName) => ai.models.generateContent({
      model: modelName,
      contents: { parts: [{ text: promptText }, audioPart] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            fullScript: { type: Type.STRING },
            timedWords: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  word: { type: Type.STRING },
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER }
                },
                required: ["word", "start", "end"]
              }
            },
            scenes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sceneNumber: { type: Type.STRING },
                  text: { type: Type.STRING },
                  startTime: { type: Type.NUMBER },
                  endTime: { type: Type.NUMBER }
                },
                required: ["text", "startTime", "endTime"]
              }
            }
          },
          required: ["fullScript", "scenes"]
        }
      }
    }), "gemini-flash-latest", ["gemini-3.1-flash-lite", "gemini-3.5-flash"], 1000, req);

    const jsonText = response.text;
    if (!jsonText) throw new Error("A resposta da API de áudio retornou vazia.");

    const parsedData = JSON.parse(jsonText);

    // Save audio file locally if projectName provided
    let audioUrl = "";
    if (projectName && typeof projectName === "string" && projectName.trim()) {
      const safeName = sanitizeProjectName(projectName);
      const projDir = path.join(PROJECTS_DIR, safeName);
      if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });

      const ext = audioMimeType && audioMimeType.includes("wav") ? "wav" : "mp3";
      const audioPath = path.join(projDir, `narration.${ext}`);
      fs.writeFileSync(audioPath, audioBuffer);
      audioUrl = `/api/projects/${safeName}/narration.${ext}`;
    }

    res.json({
      ...parsedData,
      audioUrl
    });
  } catch (err: any) {
    logErrorToFile("Audio Transcription Endpoint", err);
    res.status(500).json({ error: `Erro na transcrição do áudio: ${err.message || err}` });
  }
});

// Serve audio narration file statically for project audio previews
app.get("/api/projects/:projectName/narration.:ext", (req, res) => {
  const { projectName, ext } = req.params;
  const safeName = sanitizeProjectName(projectName);
  const audioPath = path.join(PROJECTS_DIR, safeName, `narration.${ext}`);
  if (fs.existsSync(audioPath)) {
    res.sendFile(audioPath);
  } else {
    res.status(404).json({ error: "Arquivo de áudio não encontrado." });
  }
});

// System Log Viewer endpoint
app.get("/api/storyboard/logs", (req, res) => {
  if (fs.existsSync(SERVER_LOG_FILE)) {
    const logs = fs.readFileSync(SERVER_LOG_FILE, "utf-8");
    res.type("text/plain").send(logs);
  } else {
    res.type("text/plain").send("Nenhum erro registrado no servidor até o momento.");
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

  const modelToUse = promptAiModel || "gemini-3.6-flash";
  const openAiKey = req.headers["x-openai-key"] as string;
  const openAiModel = req.headers["x-openai-model"] as string || "gpt-4o-mini";
  const useOpenAi = (
    promptAiModel === "chatgpt" ||
    promptAiModel === "gpt-4o-mini" ||
    promptAiModel === "gpt-4o" ||
    promptAiModel?.startsWith("gpt-") ||
    promptAiModel?.includes("openai") ||
    req.headers["x-use-openai"] === "true"
  ) && !!openAiKey;

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
      console.error(`[OpenAI API] Scene regeneration failed for model ${openAiModel}:`, gptErr);
      return res.status(500).json({
        error: `Falha ao gerar prompt no modelo OpenAI (${openAiModel}): ${gptErr.message || gptErr}`
      });
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
    }), modelToUse, [], 1000, req);

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
    console.error(`[Gemini API] Scene regeneration failed on requested model ${modelToUse}:`, error);
    if (openAiKey) {
      console.log("[Gemini API] Scene regeneration Gemini failed. Auto-falling back to OpenAI...");
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
      } catch (gptFallbackErr: any) {
        console.error("[OpenAI API] Fallback after Gemini error failed:", gptFallbackErr);
      }
    }
    res.status(500).json({
      error: `Falha ao gerar prompt no modelo Gemini (${modelToUse}): ${formatGeminiError(error)}`
    });
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
    if (openAiKey) {
      console.log("[Gemini API] Chat-edit Gemini failed. Auto-falling back to OpenAI...");
      try {
        const gptOutput = await callOpenAiChat(
          openAiKey,
          openAiModel || "gpt-4o-mini",
          systemPrompt,
          `Processe a solicitação do usuário: "${userMessage}"`,
          true
        );
        const result = JSON.parse(gptOutput || "{}");
        return res.json({
          ...result,
          promptAiModelUsed: `openai:${openAiModel || "gpt-4o-mini"}`,
          isCustomKeyUsed: true
        });
      } catch (gptFallbackErr: any) {
        console.error("[OpenAI API] Fallback after Gemini error failed:", gptFallbackErr);
      }
    }
    res.status(500).json({
      error: formatGeminiError(error)
    });
  }
});

// Procedural generator for elegant cinematic visuals to completely avoid library/stock images (Unsplash) as requested by the user
function getCinematicFallbackImage(prompt: string, searchQuery: string, model: string, errorReason?: string): string {
  let gradientStart = "#241812";
  let gradientEnd = "#0f0a07";
  let styleName = "Nano Banana 2 Lite";
  
  if (model === "nano_banana_pro") {
    gradientStart = "#2e1610";
    gradientEnd = "#0c0503";
    styleName = "Nano Banana Pro";
  } else if (model === "nano_banana_2") {
    gradientStart = "#142526";
    gradientEnd = "#050d0e";
    styleName = "Nano Banana 2";
  }

  const cleanPrompt = (prompt || "Visual").trim();

  // Determine error message title and detailed reason
  let friendlyTitle = "FALHA NA RENDERIZAÇÃO DA IMAGEM";
  let friendlyReason = "Não foi possível gerar a imagem com o modelo solicitado.";

  if (errorReason) {
    const errLower = errorReason.toLowerCase();
    if (errLower.includes("limit: 0") || errLower.includes("quota") || errLower.includes("limit") || errLower.includes("429")) {
      friendlyTitle = "ERRO: COTA DE USO ATINGIDA (429)";
      friendlyReason = "A cota gratuita da chave de API expirou ou o modelo não está liberado nesta conta. Adicione saldo de faturamento ou use sua chave pessoal nas configurações.";
    } else if (errLower.includes("api key") || errLower.includes("invalid") || errLower.includes("unauthorized") || errLower.includes("key") || errLower.includes("403")) {
      friendlyTitle = "ERRO: CHAVE DE API INVÁLIDA OU SEM PERMISSÃO (403)";
      friendlyReason = "A chave de API informada não possui permissão para gerar imagens com o Imagen-3 / Nano Banana. Verifique a chave nas Configurações.";
    } else if (errLower.includes("not found") || errLower.includes("404")) {
      friendlyTitle = "ERRO: MODELO INDISPONÍVEL NA SUA CHAVE (404)";
      friendlyReason = `O modelo ${styleName} não foi encontrado ou não está liberado para sua chave de API atual.`;
    } else if (errLower.includes("timeout") || errLower.includes("abort") || errLower.includes("fetch")) {
      friendlyTitle = "ERRO: TEMPO LIMITE EXCEDIDO (504)";
      friendlyReason = "O servidor da API demorou para responder e a conexão expirou. Tente gerar novamente.";
    } else {
      friendlyTitle = "FALHA NA RENDERIZAÇÃO REAL VIA IA";
      friendlyReason = errorReason.substring(0, 140);
    }
  }

  const escapeXml = (str: string) => str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const escapedTitle = escapeXml(friendlyTitle);
  const escapedReason = escapeXml(friendlyReason);
  const escapedPrompt = escapeXml(cleanPrompt.length > 85 ? cleanPrompt.substring(0, 85) + "..." : cleanPrompt);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" width="100%" height="100%">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${gradientStart}" />
        <stop offset="100%" stop-color="${gradientEnd}" />
      </linearGradient>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(212,175,55,0.05)" stroke-width="1"/>
      </pattern>
    </defs>

    <!-- Background -->
    <rect width="1200" height="675" fill="url(#bgGrad)" />
    <rect width="1200" height="675" fill="url(#grid)" />
    
    <!-- Cinematic frame borders -->
    <rect x="25" y="25" width="1150" height="625" fill="none" stroke="rgba(225, 29, 72, 0.4)" stroke-width="2" rx="4" />
    <rect x="35" y="35" width="1130" height="605" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1" rx="2" />

    <!-- Top Badge -->
    <rect x="60" y="60" width="450" height="32" rx="4" fill="rgba(225, 29, 72, 0.15)" stroke="rgba(225, 29, 72, 0.4)" stroke-width="1"/>
    <text x="75" y="81" fill="#FCA5A5" font-family="monospace, sans-serif" font-size="13" font-weight="bold" letter-spacing="2">MODELO REQUISITADO: ${styleName.toUpperCase()}</text>

    <!-- Center Error Box & Large Highlighted Error Message -->
    <g transform="translate(60, 140)">
      <!-- Error Warning Icon & Large Title -->
      <text x="0" y="60" fill="#F87171" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="900" font-size="32" letter-spacing="1">⚠️ ${escapedTitle}</text>
      
      <!-- Highlighted Detailed Reason in Large Readable Font -->
      <rect x="0" y="95" width="1080" height="130" rx="8" fill="rgba(0, 0, 0, 0.5)" stroke="rgba(248, 113, 113, 0.4)" stroke-width="1.5"/>
      <text x="30" y="145" fill="#F1F5F9" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="20" font-weight="600">${escapedReason}</text>
    </g>

    <!-- Context Info at Bottom -->
    <g transform="translate(60, 470)">
      <text x="0" y="30" fill="rgba(212,175,55,0.8)" font-family="monospace, sans-serif" font-size="12" font-weight="bold" letter-spacing="2">CONTEXTO DA CENA:</text>
      <text x="0" y="60" fill="rgba(255,255,255,0.6)" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="16" font-style="italic">"${escapedPrompt}"</text>
    </g>

    <!-- Footer Status -->
    <line x1="60" y1="590" x2="1140" y2="590" stroke="rgba(255,255,255,0.1)" stroke-width="1" />
    <text x="60" y="612" fill="rgba(255,255,255,0.4)" font-family="monospace, sans-serif" font-size="11">VERIFIQUE AS CONFIGURAÇÕES DA CHAVE DE API PARA LIBERAR A GERAÇÃO REAL DE IMAGEM.</text>
    <text x="950" y="612" fill="#D4AF37" font-family="monospace, sans-serif" font-size="11" font-weight="bold">PROPORÇÃO 16:9</text>
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
    const requestedDalleModel = (model === "gpt-image-2" || model === "dall-e-3" || model === "dall-e-2") ? model : (req.headers["x-openai-dalle-model"] as string || "gpt-image-2");
    const useOpenAi = (
      model === "chatgpt_dalle3" ||
      model === "gpt-image-2" ||
      model === "dall-e-3" ||
      model === "dall-e-2" ||
      model?.startsWith("gpt-") ||
      model?.startsWith("dall") ||
      model?.includes("openai")
    ) && !!openAiKey;

    let searchQuery = "atmospheric,scenery";
    const promptLower = prompt.toLowerCase();

    if (useOpenAi) {
      console.log(`[OpenAI API] Image Generation using model: ${requestedDalleModel}`);
      try {
        const dalleUrl = await callOpenAiImage(openAiKey, requestedDalleModel, prompt);
        return res.json({
          imageUrl: dalleUrl,
          keywords: searchQuery,
          metadata: {
            engineName: `OpenAI (${requestedDalleModel})`,
            resolution: requestedDalleModel === "dall-e-3" ? "1792x1024 (Widescreen)" : "1024x1024 (Quadrado)",
            renderTimeSeconds: 4.5,
            creativeShader: "Geração de imagem fotorrealista premium via rede neural artificial do OpenAI."
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

      const cleanedSubjectPrompt = prompt
        .replace(/aspect ratio[:=]?\s*\d+[:/]\d+/gi, "")
        .replace(/16:9/gi, "")
        .replace(/widescreen/gi, "")
        .trim();

      const generationPrompt = `${cleanedSubjectPrompt}. Style: ${styleTag}. High quality, clear focus.`;

      const targetModel = model === "nano_banana" ? "imagen-3.0-fast-001" : "imagen-3.0-generate-002";

      try {
        console.log(`[Nano Banana] Attempting Imagen 3 image generation with requested model: "${targetModel}" for prompt: "${prompt.substring(0, 40)}..."`);
        const imageResult: any = await (ai.models as any).generateImages({
          model: targetModel,
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
          console.log(`[Nano Banana] Native Imagen 3 (${targetModel}) generation successful!`);
        } else {
          generationError = `O modelo ${targetModel} não retornou dados de imagem válidos.`;
        }
      } catch (mErr: any) {
        generationError = mErr?.message || String(mErr);
        console.warn(`[Nano Banana] Direct generation on requested model ${targetModel} failed:`, generationError);
      }

      if (!resolvedUrl) {
        generationError = "Cota de API do Gemini atingida ou modelo não suportou resposta de bytes inline.";
      }
    } catch (aiErr: any) {
      generationError = aiErr?.message || String(aiErr);
      console.warn("[Nano Banana] Native AI image generation failed:", generationError);
    }

    // 2. Procedural SVG Error/Standby Card if native generation fails
    if (!resolvedUrl) {
      console.warn("[Nano Banana] Native AI image generation failed. Showing detailed error card with reason:", generationError);
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
  const isPackaged = typeof (process as any).pkg !== 'undefined';
  if (process.env.NODE_ENV !== "production" && !isPackaged) {
    // Vite in development middleware mode
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve production build files
    const distPath = isPackaged
      ? __dirname
      : path.join(process.cwd(), "dist");
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
