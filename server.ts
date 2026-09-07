import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import multer from "multer";
import { execSync, execFile } from "child_process";
import { generateOpenAiImage, generateGoogleImage, resolveImageModel, ImageRequestError, openAiImageSize } from "./server/imageGeneration";
import { projectRoutes, projectRepository } from "./server/projectRoutes";
import { confinedFile } from "./server/projectRepository";

dotenv.config();

export const app = express();
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

export function validateProjectFolder(folder: any): string {
  if (!folder || typeof folder !== "string" || !folder.trim()) {
    throw new Error("Nome da pasta do projeto é obrigatório.");
  }
  const clean = folder.trim();
  if (
    clean === "." ||
    clean === ".." ||
    clean.includes("..") ||
    clean.includes("/") ||
    clean.includes("\\") ||
    clean.includes("\0")
  ) {
    throw new Error("Nome de pasta inválido: não são permitidos caminhos relativos ou caracteres especiais.");
  }
  return clean;
}

export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, data, typeof data === "string" ? "utf-8" : undefined);
  fs.renameSync(tmpPath, filePath);
}

function sanitizeErrorMessage(msg: any): string {
  if (!msg) return "";
  let str = typeof msg === "string" ? msg : (msg?.message || String(msg));
  str = str.replace(/sk-proj-[a-zA-Z0-9_-]{10,}/gi, "sk-proj-***");
  str = str.replace(/sk-[a-zA-Z0-9_-]{10,}/gi, "sk-***");
  str = str.replace(/AIzaSy[a-zA-Z0-9_-]{10,}/gi, "AIzaSy***");
  str = str.replace(/AQ\.[a-zA-Z0-9_-]{10,}/gi, "AQ.***");
  return str;
}

// Helper to strip all API key properties from objects before saving to disk
function stripApiKeys(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => stripApiKeys(item));
  }
  const cleaned: any = {};
  for (const key of Object.keys(obj)) {
    if (
      key === "customGeminiKey" ||
      key === "customOpenAiKey" ||
      key === "openAiKey" ||
      key === "customApiKey" ||
      key === "apiKey" ||
      key === "geminiApiKey" ||
      key === "openaiApiKey" ||
      key === "elevenLabsKey" ||
      key === "secret" ||
      key === "secrets"
    ) {
      continue;
    }
    cleaned[key] = stripApiKeys(obj[key]);
  }
  return cleaned;
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
      config = stripApiKeys(JSON.parse(data));
    }
  } catch (err) {
    console.warn("Failed to load user_config.json:", err);
  }
  const secrets = loadApiSecrets();
  return { ...config, ...secrets };
}

function getCanonicalKey(item: any): string {
  if (!item) return "";
  if (typeof item === "object") {
    if (item.sceneId && item.letter) {
      return `scene:${item.sceneId}_${item.letter}`;
    }
    return getCanonicalKey(item.url);
  }
  const url = String(item);
  if (url.includes("/imagens/")) {
    const fn = url.split("/imagens/").pop()?.split("?")[0];
    if (fn) return `file:${fn}`;
  }
  if (url.startsWith("idb://")) {
    return `idb:${url.replace("idb://", "")}`;
  }
  if (url.startsWith("data:")) {
    const payload = url.split(",")[1] || url;
    return `b64:${payload.length}_${payload.slice(0, 32)}_${payload.slice(-32)}`;
  }
  return url;
}

function sanitizeArchive(archive: any[]): any[] {
  if (!Array.isArray(archive)) return [];
  const keyMap = new Map<string, any>();
  archive.forEach((item: any) => {
    if (!item || !item.url) return;
    const key = getCanonicalKey(item);
    const existing = keyMap.get(key);
    if (!existing) {
      keyMap.set(key, item);
    } else if (item.url.startsWith("/projects/") && !existing.url.startsWith("/projects/")) {
      keyMap.set(key, item);
    }
  });
  return Array.from(keyMap.values());
}

// Helper to sanitize scenes and ensure "Midjourney" is replaced with "Nano Banana"
function sanitizeScenes(scenes: any[]): any[] {
  if (!Array.isArray(scenes)) return [];
  return scenes.map((scene: any) => {
    if (!scene) return scene;
    if (scene.promptTargetTool) {
      const tool = String(scene.promptTargetTool).trim().toLowerCase();
      if (tool === "midjourney" || tool.includes("midjourney")) {
        scene.promptTargetTool = "Nano Banana";
      }
    }
    if (scene.renderError) {
      scene.renderError = sanitizeErrorMessage(scene.renderError);
    }
    if (scene.text) {
      scene.text = sanitizeErrorMessage(scene.text);
    }
    if (Array.isArray(scene.chatHistory)) {
      scene.chatHistory = scene.chatHistory.map((msg: any) => {
        if (!msg) return msg;
        if (msg.text) msg.text = sanitizeErrorMessage(msg.text);
        if (msg.reasoning) msg.reasoning = sanitizeErrorMessage(msg.reasoning);
        return msg;
      });
    }
    if (Array.isArray(scene.imageVersions) && scene.imageVersions.length > 0) {
      scene.imageVersions = sanitizeArchive(scene.imageVersions);
    }
    return scene;
  });
}

// Enable JSON body parser with generous 500mb limit for projects with heavy Base64 image caches
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));
app.use(projectRoutes());

// Server-side robust session API
app.get("/api/storyboard/session", (req, res) => {
  try {
    if (fs.existsSync(SESSION_FILE_PATH)) {
      const rawData = fs.readFileSync(SESSION_FILE_PATH, "utf-8");
      const parsed = JSON.parse(rawData);
      if (parsed && Array.isArray(parsed.scenes)) {
        parsed.scenes = sanitizeScenes(parsed.scenes);
        if (Array.isArray(parsed.sessionImageArchive)) {
          parsed.sessionImageArchive = sanitizeArchive(parsed.sessionImageArchive);
        }
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
      consecutiveNumbering,
      enabledPromptModels,
      enabledImageModels,
      openAiModel,
      openAiDalleModel,
      batchSelectedPromptModel,
      batchSelectedImageModel
    } = req.body;
    
    const sessionData = stripApiKeys({
      scenes: Array.isArray(scenes) ? sanitizeScenes(scenes) : [],
      stylePreference: stylePreference || "auto",
      projectName: projectName || "Meu Storyboard",
      scriptText: scriptText || "",
      scriptReferenceImage: scriptReferenceImage || null,
      connectionGroups: Array.isArray(connectionGroups) ? connectionGroups : [],
      selectedStyle: selectedStyle || "auto",
      consecutiveNumbering: consecutiveNumbering !== undefined ? consecutiveNumbering : true,
      enabledPromptModels: Array.isArray(enabledPromptModels) ? enabledPromptModels : undefined,
      enabledImageModels: Array.isArray(enabledImageModels) ? enabledImageModels : undefined,
      openAiModel: openAiModel || undefined,
      openAiDalleModel: openAiDalleModel || undefined,
      batchSelectedPromptModel: batchSelectedPromptModel || undefined,
      batchSelectedImageModel: batchSelectedImageModel || undefined,
      updatedAt: new Date().toISOString(),
      isAutosave: true
    });
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
      saveVersion,
      enabledPromptModels,
      enabledImageModels,
      openAiModel,
      openAiDalleModel,
      batchSelectedPromptModel,
      batchSelectedImageModel
    } = req.body;
    
    const sessionData = stripApiKeys({
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
      enabledPromptModels: Array.isArray(enabledPromptModels) ? enabledPromptModels : undefined,
      enabledImageModels: Array.isArray(enabledImageModels) ? enabledImageModels : undefined,
      openAiModel: openAiModel || undefined,
      openAiDalleModel: openAiDalleModel || undefined,
      batchSelectedPromptModel: batchSelectedPromptModel || undefined,
      batchSelectedImageModel: batchSelectedImageModel || undefined,
      updatedAt: new Date().toISOString()
    });
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
      enabledPromptModels,
      enabledImageModels,
      openAiModel,
      openAiDalleModel,
      batchSelectedPromptModel,
      batchSelectedImageModel,
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

    const sessionData = stripApiKeys({
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
      enabledPromptModels: Array.isArray(enabledPromptModels) ? enabledPromptModels : undefined,
      enabledImageModels: Array.isArray(enabledImageModels) ? enabledImageModels : undefined,
      openAiModel: openAiModel || undefined,
      openAiDalleModel: openAiDalleModel || undefined,
      batchSelectedPromptModel: batchSelectedPromptModel || undefined,
      batchSelectedImageModel: batchSelectedImageModel || undefined,
      updatedAt: updatedAt || new Date().toISOString(),
      isAutosave: false
    });

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
  const documentAsset = /^\/api\/project-documents\/([^/]+)\/assets\/([^/?]+)$/.exec(url);
  const documentFile = /^\/api\/project-documents\/([^/]+)\/files\?path=(.+)$/.exec(url);
  if (documentAsset || documentFile) {
    const file = documentAsset
      ? (await projectRepository.asset(documentAsset[1], decodeURIComponent(documentAsset[2]))).file
      : await confinedFile(await projectRepository.root(documentFile![1]), decodeURIComponent(documentFile![2]));
    const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[path.extname(file).toLowerCase()];
    return mimeType ? { mimeType, data: fs.readFileSync(file).toString("base64") } : null;
  }
  
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
    errStr.toLowerCase().includes("prepayment credits are depleted") ||
    error?.status === 429
  ) {
    return "Seus créditos de pré-pagamento na conta do Google AI Studio foram esgotados (Erro 429 - RESOURCE_EXHAUSTED).\n\n💡 Sugestão: Acesse https://ai.studio/projects para gerenciar os créditos da sua chave API no Google AI Studio, insira uma chave pessoal no painel Conexões / Configurações do DiarioMaker, ou alterne manualmente o Motor de IA para OpenAI (ChatGPT/Whisper) ou Ollama Local.";
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
  if (!name) return "gemini-2.5-flash";
  const lower = name.toLowerCase();
  if (
    lower.includes("gemini-1.5-flash") ||
    lower.includes("gemini-2.0-flash-lite") ||
    lower.includes("gemini-3.1-flash-lite") ||
    lower.includes("gemini-flash-latest")
  ) {
    return "gemini-2.5-flash";
  }
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
  let cleanMsg = errText;
  try {
    const parsed = JSON.parse(errText);
    if (parsed && parsed.error && typeof parsed.error.message === "string") {
      cleanMsg = parsed.error.message;
    }
  } catch (e) {
    // Fallback if not valid JSON
  }
  return sanitizeErrorMessage(`${prefix} (Status ${status}): ${cleanMsg}`);
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

const OPENAI_MASTER_CATALOG = [
  { id: "gpt-image-2", category: "image", name: "GPT Image 2", description: "Modelo recomendado de imagem direta (Image API)" },
  { id: "gpt-image-2-2026-04-21", category: "image", name: "GPT Image 2 Snapshot", description: "Snapshot recomendado de imagem" },
  { id: "gpt-image-1.5", category: "image", name: "GPT Image 1.5", description: "Geração de imagens alta resolução" },
  { id: "gpt-image-1", category: "image", name: "GPT Image 1", description: "Modelo de imagem padrão" },
  { id: "gpt-image-1-mini", category: "image", name: "GPT Image 1 Mini", description: "Modelo rápido e econômico" },
  { id: "chatgpt-image-latest", category: "image", name: "ChatGPT Image Latest", description: "Modelo de imagem conversacional" },
  { id: "gpt-4o", category: "conversation", name: "GPT-4o", description: "Multimodal conversacional avançado" },
  { id: "gpt-4o-mini", category: "conversation", name: "GPT-4o Mini", description: "Conversacional rápido e ultraleve" },
  { id: "gpt-5", category: "conversation", name: "GPT-5", description: "Modelo flagship de nova geração" },
  { id: "gpt-5-pro", category: "conversation", name: "GPT-5 Pro", description: "Modelo de raciocínio profundo" },
  { id: "gpt-5-mini", category: "conversation", name: "GPT-5 Mini", description: "Modelo compacto de alta performance" },
  { id: "gpt-5.6-luna", category: "conversation", name: "GPT-5.6 Luna", description: "Variante especializada de alta precisão" },
  { id: "gpt-5.6-terra", category: "conversation", name: "GPT-5.6 Terra", description: "Variante recomendada para roteiros" },
  { id: "gpt-5.6-sol", category: "conversation", name: "GPT-5.6 Sol", description: "Variante de síntese criativa" },
  { id: "o1", category: "conversation", name: "o1", description: "Raciocínio lógico avançado" },
  { id: "o3-mini", category: "conversation", name: "o3-mini", description: "Raciocínio ultrarrápido" }
];

app.post("/api/storyboard/test-key", async (req, res) => {
  const { customApiKey, openAiKey, provider } = req.body;

  if (provider === "openai" || openAiKey || req.headers["x-openai-key"]) {
    const keyToTest = openAiKey || (req.headers["x-openai-key"] as string) || customApiKey;
    if (!keyToTest || !keyToTest.trim()) {
      return res.status(400).json({ error: "Nenhuma chave de API OpenAI fornecida para teste." });
    }
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${keyToTest.trim()}` }
      });
      if (response.ok) {
        const data = await response.json();
        const rawModels: any[] = Array.isArray(data?.data) ? data.data : [];
        const allowedModelIds = rawModels.map(m => m.id || "").filter(Boolean);

        const allowedImageModels = allowedModelIds.filter(id => id.includes("image") || id.startsWith("dall-e"));
        const allowedTextModels = allowedModelIds.filter(id => id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("chatgpt"));

        const missingCatalogModels = OPENAI_MASTER_CATALOG.filter(item => !allowedModelIds.includes(item.id));

        return res.json({ 
          success: true, 
          message: "Sua chave de API do OpenAI foi verificada e está ativa!",
          totalAllowed: allowedModelIds.length,
          allowedModelIds,
          allowedImageModels,
          allowedTextModels,
          missingCatalogModels
        });
      } else {
        const errData = await response.json().catch(() => ({}));
        return res.status(400).json({ 
          success: false, 
          error: errData?.error?.message || `Erro ao autenticar com a API OpenAI (${response.status}).` 
        });
      }
    } catch (err: any) {
      return res.status(400).json({ 
        success: false, 
        error: err.message || "Erro ao conectar com a API OpenAI." 
      });
    }
  }

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
    }), "gemini-2.5-flash", ["gemini-3.5-flash", "gemini-2.5-pro"], 1000, req);

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
  const geminiAudioModels: string[] = [];
  const openAiTextModels: string[] = [];
  const openAiImageModels: string[] = [];
  const openAiAudioModels: string[] = [];

  if (activeGeminiKey && activeGeminiKey.trim()) {
    try {
      const ai = getGeminiClient(activeGeminiKey);
      const list = await ai.models.list();
      if (list && Array.isArray(list)) {
        list.forEach((m: any) => {
          if (m.name) {
            const name = m.name.replace(/^models\//, "");
            // Filter text generation models (and audio for Gemini since they are multimodal)
            if (name.includes("gemini") && !name.includes("vision") && !name.includes("embed")) {
              geminiTextModels.push(name);
              geminiAudioModels.push(name); // Gemini uses its text models for multimodal audio
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
            if (id.includes("whisper") || id.includes("transcribe")) {
              openAiAudioModels.push(id);
            } else if (id.includes("image") || id.startsWith("dall-e")) {
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
      "gpt-5",
      "gpt-5-pro",
      "gpt-5-mini",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "o1",
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

  if (openAiAudioModels.length === 0) {
    openAiAudioModels.push("whisper-1");
  }

  res.json({
    gemini: {
      text: [...new Set(geminiTextModels)].sort(),
      image: [...new Set(geminiImageModels)].sort(),
      audio: [...new Set(geminiAudioModels)].sort()
    },
    openai: {
      text: [...new Set(openAiTextModels)].sort(),
      image: [...new Set(openAiImageModels)].sort(),
      audio: [...new Set(openAiAudioModels)].sort()
    }
  });
});

function sanitizeProjectName(name?: string): string {
  if (!name || typeof name !== "string") return "meu-projeto";
  const clean = path.basename(name).replace(/[^a-zA-Z0-9_\-]/g, "_").trim();
  return clean || "meu-projeto";
}

function clampAudioBufferForOpenAi(buffer: Buffer, maxBytes: number = 22 * 1024 * 1024): Buffer {
  if (!buffer || buffer.length <= maxBytes) return buffer;

  const isWav = buffer.length > 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
  if (!isWav) return buffer;

  try {
    const numChannels = buffer.readUInt16LE(22);
    let sampleRate = buffer.readUInt32LE(24);
    let bitsPerSample = buffer.readUInt16LE(34);

    let pcmData = buffer.subarray(44);
    let totalSamples = Math.floor(pcmData.length / (numChannels * (bitsPerSample / 8)));

    // 1. Convert to Mono if Stereo
    if (numChannels > 1) {
      const monoBuffer = Buffer.alloc(totalSamples * (bitsPerSample / 8));
      for (let i = 0; i < totalSamples; i++) {
        let sum = 0;
        for (let c = 0; c < numChannels; c++) {
          if (bitsPerSample === 16) sum += pcmData.readInt16LE((i * numChannels + c) * 2);
          else if (bitsPerSample === 8) sum += pcmData.readUInt8(i * numChannels + c) - 128;
        }
        const avg = sum / numChannels;
        if (bitsPerSample === 16) monoBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(avg))), i * 2);
        else monoBuffer.writeUInt8(Math.max(0, Math.min(255, Math.round(avg) + 128)), i);
      }
      pcmData = monoBuffer;
    }

    // 2. Convert 16-bit to 8-bit if it helps reduce size (halves the size without touching sample rate)
    if (bitsPerSample === 16 && pcmData.length > maxBytes) {
      const buffer8bit = Buffer.alloc(totalSamples);
      for (let i = 0; i < totalSamples; i++) {
        const val16 = pcmData.readInt16LE(i * 2);
        buffer8bit.writeUInt8(Math.max(0, Math.min(255, Math.floor((val16 + 32768) / 256))), i);
      }
      pcmData = buffer8bit;
      bitsPerSample = 8;
    }

    // 3. Decimate sample rate accurately to preserve exact duration
    let decimateRatio = 1;
    if (pcmData.length > maxBytes) {
      decimateRatio = Math.ceil(pcmData.length / maxBytes);
    }

    let newSampleRate = Math.floor(sampleRate / decimateRatio);
    let newTotalSamples = Math.floor(totalSamples / decimateRatio);
    
    if (decimateRatio > 1) {
      const newPcmBuffer = Buffer.alloc(newTotalSamples * (bitsPerSample / 8));
      for (let i = 0; i < newTotalSamples; i++) {
        const origIdx = i * decimateRatio;
        if (bitsPerSample === 16) newPcmBuffer.writeInt16LE(pcmData.readInt16LE(origIdx * 2), i * 2);
        else newPcmBuffer.writeUInt8(pcmData.readUInt8(origIdx), i);
      }
      pcmData = newPcmBuffer;
      sampleRate = newSampleRate;
    }

    // Write header
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // Mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * (bitsPerSample / 8), 28); // Byte rate
    header.writeUInt16LE(bitsPerSample / 8, 32); // Block align
    header.writeUInt16LE(bitsPerSample, 34); // Bits per sample
    header.write("data", 36);
    header.writeUInt32LE(pcmData.length, 40);

    const result = Buffer.concat([header, pcmData]);
    console.log(`[Audio Transcoder Server] Downsampled oversized WAV buffer from ${(buffer.length / 1024 / 1024).toFixed(2)}MB down to ${(result.length / 1024 / 1024).toFixed(2)}MB (New SampleRate: ${sampleRate}Hz)`);
    return result;
  } catch (err) {
    console.warn("[Audio Transcoder Server] WAV downsampling failed, keeping original:", err);
    return buffer;
  }
}

function consolidateRawSegments(rawSegments: Array<{ text: string; startTime: number; endTime: number }>) {
  if (!rawSegments || rawSegments.length === 0) return [];

  const consolidated: Array<{ sceneNumber: string; text: string; startTime: number; endTime: number }> = [];

  let currentText = "";
  let currentStart = rawSegments[0].startTime;
  let currentEnd = rawSegments[0].endTime;

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const segText = String(seg.text || "").trim();
    if (!segText) continue;

    const gap = seg.startTime - currentEnd;
    const currentDuration = currentEnd - currentStart;
    const textHasPunctuation = /[.!?]$/.test(currentText.trim());

    // Consolidate into 35-60 scenes target (8-16s per scene)
    const shouldSplit = (gap >= 2.8) || (textHasPunctuation && currentDuration >= 8.0) || (currentDuration >= 18.0);

    if (currentText.length > 0 && shouldSplit) {
      consolidated.push({
        sceneNumber: String(consolidated.length + 1),
        text: currentText.trim(),
        startTime: Number(currentStart.toFixed(2)),
        endTime: Number(currentEnd.toFixed(2))
      });
      currentText = segText;
      currentStart = seg.startTime;
      currentEnd = seg.endTime;
    } else {
      currentText = currentText ? `${currentText} ${segText}` : segText;
      currentEnd = seg.endTime;
    }
  }

  if (currentText.trim().length > 0) {
    consolidated.push({
      sceneNumber: String(consolidated.length + 1),
      text: currentText.trim(),
      startTime: Number(currentStart.toFixed(2)),
      endTime: Number(currentEnd.toFixed(2))
    });
  }

  return consolidated;
}

// Helper to transcribe audio using OpenAI Whisper API
async function transcribeAudioOpenAi(apiKey: string, rawAudioBuffer: Buffer, filename: string, audioModel: string = "whisper-1"): Promise<any> {
  const audioBuffer = clampAudioBufferForOpenAi(rawAudioBuffer);
  const fileBlob = new Blob([audioBuffer], { type: filename.endsWith(".wav") ? "audio/wav" : "audio/mp3" });
  const formData = new FormData();
  formData.append("file", fileBlob, filename || "narration.mp3");
  formData.append("model", audioModel);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "word");
  formData.append("timestamp_granularities[]", "segment");
  formData.append("language", "pt");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey.trim()}`
    },
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    let exactMsg = errText;
    let suggestion = "";
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) {
        exactMsg = parsed.error.message;
        if (exactMsg.includes("does not have access to model") || exactMsg.includes("whisper-1") || response.status === 403) {
          suggestion = "\n\n💡 Sugestão: O seu projeto de API da OpenAI não possui permissão para usar o modelo 'whisper-1'. Habilite o modelo nas configurações do seu projeto na OpenAI ou alterne manualmente para o Gemini nas opções de transcrição.";
        } else if (exactMsg.includes("credits are depleted") || exactMsg.includes("billing") || response.status === 429) {
          suggestion = "\n\n💡 Sugestão: Seus créditos de pré-pagamento na OpenAI foram esgotados. Verifique seu saldo no painel da OpenAI ou alterne manualmente para o Gemini.";
        } else if (exactMsg.includes("413") || exactMsg.includes("Maximum content size limit") || response.status === 413) {
          suggestion = "\n\n💡 Sugestão: O tamanho do áudio excedeu o limite máximo de 25 MB imposto pela API da OpenAI. O DiarioMaker irá otimizar a amostragem na próxima tentativa.";
        }
      }
    } catch (_) {}
    throw new Error(`[OpenAI Whisper API Status ${response.status}] ${exactMsg}${suggestion}`);
  }

  const data: any = await response.json();
  const fullScript = String(data.text || "").trim();
  const segments = Array.isArray(data.segments) ? data.segments : [];

  const rawScenes = segments.map((seg: any) => ({
    text: String(seg.text || "").trim(),
    startTime: typeof seg.start === "number" ? Math.round(seg.start * 100) / 100 : 0,
    endTime: typeof seg.end === "number" ? Math.round(seg.end * 100) / 100 : 0
  })).filter((s: any) => s.text.length > 0);

  const scenes = consolidateRawSegments(rawScenes);

  const timedWords: any[] = [];
  if (Array.isArray(data.words)) {
    data.words.forEach((w: any) => {
      timedWords.push({
        word: String(w.word || "").trim(),
        start: typeof w.start === "number" ? Math.round(w.start * 100) / 100 : 0,
        end: typeof w.end === "number" ? Math.round(w.end * 100) / 100 : 0
      });
    });
  }

  return {
    fullScript,
    timedWords,
    scenes: scenes.length > 0 ? scenes : [{ sceneNumber: "1", text: fullScript, startTime: 0, endTime: 10 }]
  };
}

// Native Windows Folder Browser Dialog Endpoint
app.post("/api/storyboard/browse-folder", (req, res) => {
  try {
    if (process.platform === "win32") {
      const psScriptPath = path.join(process.cwd(), "browse_folder.ps1");
      let command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}"`;
      if (!fs.existsSync(psScriptPath)) {
        const fallbackScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Selecione a pasta do projeto DiarioMaker'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }`;
        const encoded = Buffer.from(fallbackScript, "utf16le").toString("base64");
        command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
      }
      const output = execSync(command, { encoding: "utf-8", timeout: 60000 }).trim();

      if (output) {
        const folderPath = output;
        const folderName = path.basename(folderPath);
        return res.json({ success: true, folderPath, folderName });
      } else {
        return res.json({ success: false, cancelled: true });
      }
    } else {
      return res.status(400).json({ error: "O seletor nativo do Explorer é exclusivo para Windows." });
    }
  } catch (err: any) {
    if (err.killed || err.code === "ETIMEDOUT") {
      return res.json({ success: false, cancelled: true });
    }
    console.error("Error opening Windows folder picker:", err);
    return res.status(500).json({ error: "Não foi possível abrir a janela do Explorer." });
  }
});

// Native Windows Explorer Reveal Folder Endpoint
app.post("/api/storyboard/reveal-folder", (req, res) => {
  try {
    if (process.platform === "win32") {
      const folderParam = req.body.folder || "default";
      const targetPath = path.isAbsolute(folderParam)
        ? folderParam
        : path.join(process.cwd(), "projects", folderParam);
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
      }
      execFile("explorer.exe", [targetPath], () => {});
      return res.json({ success: true, folderPath: targetPath });
    } else {
      return res.status(400).json({ error: "O Explorer é exclusivo para Windows." });
    }
  } catch (err: any) {
    console.error("Error revealing folder in Explorer:", err);
    return res.status(500).json({ error: "Não foi possível abrir a pasta no Explorer." });
  }
});

// Native Windows File Browser Dialog for Audio (NLE Mode)
app.post("/api/storyboard/browse-audio-file", (req, res) => {
  try {
    if (process.platform === "win32") {
      const fallbackScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Arquivos de Áudio (*.wav, *.mp3, *.m4a)|*.wav;*.mp3;*.m4a|Todos os Arquivos (*.*)|*.*'; $f.Title = 'Selecione a narração (Modo NLE)'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }`;
      const encoded = Buffer.from(fallbackScript, "utf16le").toString("base64");
      const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
      
      const output = execSync(command, { encoding: "utf-8", timeout: 60000 }).trim();

      if (output) {
        const filePath = output;
        const fileName = path.basename(filePath);
        return res.json({ success: true, filePath, fileName });
      } else {
        return res.json({ success: false, cancelled: true });
      }
    } else {
      return res.status(400).json({ error: "O seletor nativo é exclusivo para Windows." });
    }
  } catch (err: any) {
    console.error("Error opening Windows file picker:", err);
    return res.status(500).json({ error: "Falha ao abrir janela do Windows.", details: err.message });
  }
});

// Stream Local Audio File (NLE Mode)
app.get("/api/storyboard/stream-local-audio", (req, res) => {
  try {
    const audioPath = req.query.path as string;
    console.log(`[Stream Local Audio] Solicitado: ${audioPath}`);
    if (!audioPath || !fs.existsSync(audioPath)) {
      console.warn(`[Stream Local Audio] ERRO: Arquivo não encontrado: ${audioPath}`);
      return res.status(404).send("Arquivo não encontrado no caminho original.");
    }
    
    const stat = fs.statSync(audioPath);
    const total = stat.size;
    const range = req.headers.range;

    let contentType = "audio/wav";
    const ext = audioPath.toLowerCase();
    if (ext.endsWith(".mp3")) contentType = "audio/mpeg";
    else if (ext.endsWith(".m4a")) contentType = "audio/mp4";
    else if (ext.endsWith(".aac")) contentType = "audio/aac";

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const partialstart = parts[0];
      const partialend = parts[1];

      const start = parseInt(partialstart, 10);
      const end = partialend ? parseInt(partialend, 10) : total - 1;
      const chunksize = (end - start) + 1;
      
      const file = fs.createReadStream(audioPath, {start, end});
      res.writeHead(206, {
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": total,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes"
      });
      fs.createReadStream(audioPath).pipe(res);
    }
  } catch (err: any) {
    console.error("Erro no stream local audio:", err);
    res.status(500).send("Erro interno ao ler arquivo.");
  }
});

// Audio Narration Transcription & Alignment Endpoint supporting Gemini & OpenAI Whisper APIs
app.post("/api/storyboard/transcribe-audio", upload.single("audio"), async (req: any, res: any) => {
  if (req.setTimeout) req.setTimeout(600000);
  if (res.setTimeout) res.setTimeout(600000);
  try {
    let audioBuffer: Buffer | null = null;
    let audioMimeType = "audio/mp3";
    let projectName = req.body?.projectName;
    const documentId = req.body?.documentId;
    const documentRoot = documentId ? await projectRepository.root(documentId) : undefined;

    if (req.file) {
      audioBuffer = req.file.buffer;
      audioMimeType = req.file.mimetype || "audio/mp3";
    }

    if (!audioBuffer && req.body?.audioBase64) {
      const cleanBase64 = req.body.audioBase64.includes(";base64,") ? req.body.audioBase64.split(";base64,")[1] : req.body.audioBase64;
      audioBuffer = Buffer.from(cleanBase64, "base64");
      if (req.body.audioMimeType) audioMimeType = req.body.audioMimeType;
    } else if (!audioBuffer && req.body?.audioPath && fs.existsSync(req.body.audioPath)) {
      audioBuffer = fs.readFileSync(req.body.audioPath);
      const ext = req.body.audioPath.toLowerCase();
      if (ext.endsWith(".wav")) audioMimeType = "audio/wav";
      else if (ext.endsWith(".mp3")) audioMimeType = "audio/mp3";
      else if (ext.endsWith(".m4a")) audioMimeType = "audio/mp4";
    } else if (!audioBuffer && projectName && typeof projectName === "string" && projectName.trim()) {
      const safeName = sanitizeProjectName(projectName);
      const projDir = documentRoot || path.join(PROJECTS_DIR, safeName);
      const possibleFiles = ["narration_hd.wav", "narration_hd.mp3", "narration.wav", "narration.mp3", "narration.m4a"];
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

    // Normalize audio MIME type
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

    const openAiKeyHeader = req.headers["x-openai-key"] as string;
    const requestedEngine = req.body?.engine || req.body?.selectedEngine || (req.headers["x-use-openai"] === "true" ? "openai" : "gemini");
    const isUsingOpenAi = requestedEngine === "openai" || !!openAiKeyHeader;

    if (isUsingOpenAi) {
      const activeOpenAiKey = openAiKeyHeader || req.body?.openAiKey || (loadApiSecrets().customOpenAiKey) || process.env.OPENAI_API_KEY;
      const audioModel = req.headers["x-openai-audio-model"] as string || req.body?.openAiAudioModel || "whisper-1";

      if (!activeOpenAiKey || !activeOpenAiKey.trim()) {
        throw new Error("Chave de API OpenAI não encontrada. Por favor, insira sua OpenAI Key no painel Conexões para usar a transcrição via ChatGPT/Whisper.");
      }
      console.log(`[Audio Engine] Transcribing audio via OpenAI (${audioModel})...`);
      const whisperResult = await transcribeAudioOpenAi(activeOpenAiKey, audioBuffer, req.file?.originalname || "narration.mp3", audioModel);

      let audioUrl = "";
      if (projectName && typeof projectName === "string" && projectName.trim()) {
        const safeName = sanitizeProjectName(projectName);
        const projDir = documentRoot || path.join(PROJECTS_DIR, safeName);
        if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
        const ext = cleanMime.includes("wav") ? "wav" : "mp3";
        const audioPath = path.join(projDir, `narration.${ext}`);
        fs.writeFileSync(audioPath, audioBuffer);
        audioUrl = documentId ? `/api/project-documents/${documentId}/files?path=narration.${ext}` : `/api/projects/${safeName}/narration.${ext}`;
      }

      return res.json({
        ...whisperResult,
        audioUrl
      });
    }

    if (projectName && audioBuffer) {
      try {
        const safeName = sanitizeProjectName(projectName);
        const projDir = documentRoot || path.join(PROJECTS_DIR, safeName);
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
    }), "gemini-2.5-flash", ["gemini-3.5-flash", "gemini-2.5-pro"], 1000, req);

    const jsonText = response.text;
    if (!jsonText) throw new Error("A resposta da API de áudio retornou vazia.");

    const parsedData = JSON.parse(jsonText);

    // Save audio file locally if projectName provided
    let audioUrl = "";
    if (projectName && typeof projectName === "string" && projectName.trim()) {
      const safeName = sanitizeProjectName(projectName);
      const projDir = documentRoot || path.join(PROJECTS_DIR, safeName);
      if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });

      const ext = audioMimeType && audioMimeType.includes("wav") ? "wav" : "mp3";
      const audioPath = path.join(projDir, `narration.${ext}`);
      fs.writeFileSync(audioPath, audioBuffer);
      audioUrl = documentId ? `/api/project-documents/${documentId}/files?path=narration.${ext}` : `/api/projects/${safeName}/narration.${ext}`;
    }

    res.json({
      ...parsedData,
      audioUrl
    });
  } catch (err: any) {
    logErrorToFile("Audio Transcription Endpoint", err);
    res.status(500).json({ error: `Erro na transcrição do áudio: ${formatGeminiError(err)}` });
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

  const userPromptText = `Generate a fresh, high-quality visual description (written in Brazilian Portuguese (PT-BR) ONLY) and a detailed English image prompt for this storyboard segment narration.

Narration Segment: "${text}"
${generationGuidelines ? `\nCRITICAL USER INSTRUCTIONS & CORRECTIONS (MUST OVERRIDE & PRIORITIZE):\n"${generationGuidelines.trim()}"\n` : ""}

IMPORTANT INSTRUCTION:
Build a clean, renewed prompt focused on the narration segment and the CRITICAL USER INSTRUCTIONS above. Do NOT carry over unwanted or incorrect elements from previous generations.

Provide your output strictly as a JSON object with two keys:
1. "description": A concise visual scene description in Portuguese (PT-BR).
2. "prompt": A detailed, highly descriptive image generation prompt written in English.

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
  const requestedTextModel = (req.body?.model || req.headers["x-openai-model"] || "gpt-4o-mini") as string;
  const openAiModel = requestedTextModel.replace(/^openai:/, "");
  const useOpenAi = (
    req.headers["x-use-openai"] === "true" ||
    openAiModel.startsWith("gpt-") ||
    openAiModel.startsWith("o1") ||
    openAiModel.startsWith("o3") ||
    openAiModel.includes("openai")
  ) && !!openAiKey;

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
    if (!prompt || typeof prompt !== "string") throw new ImageRequestError("O prompt de imagem é obrigatório.");
    const selected = resolveImageModel(model, req.get("x-openai-dalle-model") || undefined);
    const reference = visualInstructionImage ? await imageUrlToInlineData(visualInstructionImage) : null;
    if (visualInstructionImage && !reference) throw new ImageRequestError("Não foi possível ler a imagem de referência.");
    let imageUrl: string;
    if (selected.provider === "openai") {
      const key = req.get("x-openai-key") || loadUserConfig()?.customOpenAiKey || process.env.OPENAI_API_KEY;
      if (!key) throw new ImageRequestError("Insira uma chave OpenAI válida nas configurações.");
      imageUrl = await generateOpenAiImage(key, selected.model, prompt, reference);
    } else {
      imageUrl = await generateGoogleImage(getGeminiClient(req.get("x-gemini-key") || customApiKey), selected.model, prompt, reference);
    }
    res.json({ imageUrl, isAiGenerated: true, generationError: "", metadata: {
      engineName: selected.model, resolution: selected.provider === "openai" ? openAiImageSize(selected.model) : "16:9"
    } });
  } catch (err: any) {
    res.status(err instanceof ImageRequestError ? err.status : 502).json({ error: sanitizeErrorMessage(err.message || String(err)) });
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

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Express custom server running on http://localhost:${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}
