import React, { useState, useEffect, useRef } from "react";
import JSZip from "jszip";
import { StoryboardScene, StylePreference, ArchivedImage, ConnectionGroup, ArtisticStyle } from "./types";
import ScriptInputArea from "./components/ScriptInputArea";
import StoryboardCard from "./components/StoryboardCard";
import { SAMPLE_SCRIPTS } from "./data/samples";
import { generateFCPXML, generateEDL, alignAudioToExistingScenes } from "./lib/timecodeUtils";
import { Sparkles, Film, Compass, Download, HelpCircle, RefreshCw, AlertCircle, Plus, Info, Key, Eye, EyeOff, Lock, Check, Loader2, FileText, Save, Upload, Undo, Redo, Settings, History, X, Trash2, Image, Copy, Link as LinkIcon, Unlink, HardDrive, Cpu, Mic, Edit3 } from "lucide-react";
import { getCachedImage, setCachedImage, getCacheSizeMB, clearCache } from "./lib/cacheStore";
import { prepareImageBlobForDownload } from "./lib/imageUtils";
import { motion, AnimatePresence } from "motion/react";

function setLocalStorageItemSafely(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e: any) {
    const isQuotaError = 
      e.name === "QuotaExceededError" || 
      e.name === "NS_ERROR_DOM_QUOTA_REACHED" || 
      String(e).toLowerCase().includes("quota") ||
      String(e).toLowerCase().includes("exceeded");
      
    if (isQuotaError) {
      try {
        if (key === "ethos_storyboard_scenes") {
          const scenes = JSON.parse(value);
          if (Array.isArray(scenes)) {
            // Remove massive Base64 strings to preserve user session flow text and guidelines without crashing
            const cleaned = scenes.map((s) => {
              const copy = { ...s };
              if (copy.generatedImageUrl?.startsWith("data:")) {
                copy.generatedImageUrl = undefined;
              }
              if (copy.visualInstructionImage?.startsWith("data:")) {
                copy.visualInstructionImage = undefined;
              }
              if (Array.isArray(copy.imageVersions)) {
                copy.imageVersions = copy.imageVersions.map((v: any) => {
                  if (v.url?.startsWith("data:")) {
                    return { ...v, url: undefined };
                  }
                  return v;
                });
              }
              return copy;
            });
            localStorage.setItem(key, JSON.stringify(cleaned));
            return;
          }
        } else if (key === "ethos_storyboard_image_archive") {
          const archive = JSON.parse(value);
          if (Array.isArray(archive)) {
            // Filter out base64 images from the local cache archive to keep it extremely slim
            const cleaned = archive.filter((item: any) => !item.url?.startsWith("data:"));
            localStorage.setItem(key, JSON.stringify(cleaned));
            return;
          }
        }
      } catch (innerErr) {
        // Silent fallback
      }
    }
    console.info(`[Storage Helper] Silently managed localStorage save fallback for key: ${key}`);
  }
}

export const getLetterFromIndex = (index: number): string => {
  let letter = "";
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode(65 + (temp % 26)) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
};

const DEFAULT_ARTISTIC_STYLES: ArtisticStyle[] = [
  {
    id: "caravaggio",
    name: "Caravaggio",
    prompt: "Style: Caravaggio (Medieval Baroque Chiaroscuro). High contrast chiaroscuro, deep shadows, dramatic golden direct lighting, earthy tones (ochres, deep reds, sienna), realistic human faces with raw emotion, historical religious/biblical setting, emotional weight, dramatic light rays.",
    autoDetectKeywords: "caravaggio, chiaroscuro, barroco, medieval, religioso, bíblico, cristo, santo, igreja"
  },
  {
    id: "urban_realism",
    name: "Urbano BR",
    prompt: "Style: Brazilian Street Realism (Cotidiano Brasileiro). Vibrant real color palette, raw authentic street photography style, brazilian urban elements (favelas, paved alleyways, colorful humble houses, street vendors, graffiti, dogs), soft sunset backlight, rich documentary style textures.",
    autoDetectKeywords: "brasil, brasileiro, favela, rua, sampa, copacabana, cotidiano, urbano, samba, periferia, boteco"
  }
];

export default function App() {
  const [scenes, setScenes] = useState<StoryboardScene[]>(() => {
    try {
      const saved = localStorage.getItem("ethos_storyboard_scenes");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          // Reset any transient queued/rendering statuses to prevent unexpected auto-generations on reload
          return parsed.map((s: StoryboardScene) => {
            if (s.renderStatus === "queued" || s.renderStatus === "rendering") {
              return {
                ...s,
                renderStatus: s.generatedImageUrl ? "completed" : "idle"
              };
            }
            return s;
          });
        }
      }
      return [];
    } catch {
      return [];
    }
  });
  const [artisticStyles, setArtisticStyles] = useState<ArtisticStyle[]>(() => {
    try {
      const saved = localStorage.getItem("ethos_artistic_styles");
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (err) {
      console.error("Error loading artistic styles:", err);
    }
    return DEFAULT_ARTISTIC_STYLES;
  });

  useEffect(() => {
    try {
      localStorage.setItem("ethos_artistic_styles", JSON.stringify(artisticStyles));
    } catch (err) {
      console.error("Error saving artistic styles:", err);
    }
  }, [artisticStyles]);

  const [localCacheEnabled, setLocalCacheEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("ethos_local_cache_enabled");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  const [exportModeOption, setExportModeOption] = useState<"complete" | "lightweight">(() => {
    try {
      const saved = localStorage.getItem("ethos_export_mode_option");
      return (saved as "complete" | "lightweight") || "complete";
    } catch {
      return "complete";
    }
  });

  const [cacheSizeMB, setCacheSizeMB] = useState<number>(0);
  const [isHydrating, setIsHydrating] = useState<boolean>(true);

  const [history, setHistory] = useState<StoryboardScene[][]>([]);
  const [redoStack, setRedoStack] = useState<StoryboardScene[][]>([]);

  // Push current scenes to undo history stack right before modifications
  const pushToHistory = (customScenes?: StoryboardScene[]) => {
    setHistory((prevHistory) => [...prevHistory, customScenes || [...scenes]]);
    setRedoStack([]); // Clear redo stack on new action
  };

  // Revert the last modification on storyboard scenes
  const handleUndo = () => {
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    setRedoStack((prevRedo) => [...prevRedo, [...scenes]]);
    setScenes(previous);
    setHistory((prevHistory) => prevHistory.slice(0, -1));
    setNotification("✓ Última alteração desfeita com sucesso!");
  };

  // Re-apply the last undone modification
  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const nextState = redoStack[redoStack.length - 1];
    setHistory((prevHistory) => [...prevHistory, [...scenes]]);
    setScenes(nextState);
    setRedoStack((prevRedo) => prevRedo.slice(0, -1));
    setNotification("✓ Última alteração refeita com sucesso!");
  };
  const [isGenerating, setIsGenerating] = useState(false);
  const [regeneratingCardIndex, setRegeneratingCardIndex] = useState<number | null>(null);
  
  // Interactive Art Studio active scene tracker and floating notifications
  const [activeStudioSceneId, setActiveStudioSceneId] = useState<string | null>(null);
  const activeStudioSceneIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeStudioSceneIdRef.current = activeStudioSceneId;
  }, [activeStudioSceneId]);

  // Global Keyboard Shortcuts Active Focused Scene Tracker
  const [focusedSceneId, setFocusedSceneId] = useState<string | null>(null);
  const prevViewRef = useRef<string>("storyboard");

  // References and states for the Super Scroll zone and visible scene tracker
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const superScrollPadRef = useRef<HTMLDivElement | null>(null);
  const [visibleSceneIndex, setVisibleSceneIndex] = useState<number>(0);

  // Set up mouse wheel super-scrolling on the special pad
  useEffect(() => {
    const pad = superScrollPadRef.current;
    if (!pad) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scrollAmount = e.deltaY * 7;
      const container = mainScrollRef.current;
      
      // Scroll container internally if it's scrollable and not visible-overflow
      if (container && container.scrollHeight > container.clientHeight && window.getComputedStyle(container).overflowY !== 'visible') {
        container.scrollTop += scrollAmount;
      } else {
        // Fallback: Scroll the main window/document
        window.scrollBy({ top: scrollAmount, behavior: 'auto' });
      }
    };

    pad.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      pad.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Track the currently visible scene index dynamically based on scroll position
  useEffect(() => {
    const handleScroll = () => {
      const cards = document.querySelectorAll('[data-scene-card="true"]');
      if (cards.length === 0) return;

      let closestIndex = 0;
      let minDistance = Infinity;

      // Measure distance from the viewport's top with offset for the sticky header (approx 180px)
      cards.forEach((card) => {
        const rect = card.getBoundingClientRect();
        const distance = Math.abs(rect.top - 180);
        if (distance < minDistance) {
          minDistance = distance;
          const indexAttr = card.getAttribute('data-scene-index');
          if (indexAttr !== null) {
            closestIndex = parseInt(indexAttr, 10);
          }
        }
      });

      setVisibleSceneIndex(closestIndex);
    };

    // Listen to both window and container scroll events
    window.addEventListener('scroll', handleScroll, { passive: true });
    
    const container = mainScrollRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll, { passive: true });
    }

    handleScroll();

    const observer = new MutationObserver(handleScroll);
    if (container) {
      observer.observe(container, { childList: true, subtree: true });
    } else {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (container) {
        container.removeEventListener('scroll', handleScroll);
      }
      observer.disconnect();
    };
  }, [scenes]);

  interface FloatingNotification {
    id: string;
    sceneId: string;
    sceneNumber: string;
    type: "image" | "text";
    imageUrl?: string;
    message: string;
  }
  const [floatingNotifications, setFloatingNotifications] = useState<FloatingNotification[]>([]);

  const addFloatingNotification = (notification: Omit<FloatingNotification, "id">) => {
    const randomSuffix = Math.random().toString(36).substring(2, 9);
    const id = `${notification.type}-${notification.sceneId}-${Date.now()}-${randomSuffix}`;
    const newNotif = { ...notification, id };
    
    setFloatingNotifications((prev) => [newNotif, ...prev]);
    
    // Automatically remove after 8 seconds
    setTimeout(() => {
      setFloatingNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 8000);
  };

  const [stylePreference, setStylePreference] = useState<StylePreference>(() => {
    try {
      const saved = localStorage.getItem("ethos_storyboard_style");
      return (saved as StylePreference) || "auto";
    } catch {
      return "auto";
    }
  });
  const [scriptText, setScriptText] = useState(() => {
    try {
      const saved = localStorage.getItem("ethos_storyboard_script_text");
      return saved || "";
    } catch {
      return "";
    }
  });
  const [selectedStyle, setSelectedStyle] = useState<StylePreference>(() => {
    try {
      const saved = localStorage.getItem("ethos_storyboard_selected_style");
      return (saved as StylePreference) || "auto";
    } catch {
      return "auto";
    }
  });
   const [activeView, setActiveView] = useState<"storyboard" | "config">("storyboard");
  const [activeApiTab, setActiveApiTab] = useState<"gemini" | "chatgpt" | "ollama">("gemini");
  const [showScriptModal, setShowScriptModal] = useState(false);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);

  // Custom Confirmation States to avoid browser alert/confirm iframe blockage
  const [showClearCacheModal, setShowClearCacheModal] = useState(false);
  const [showConfirmClearCache, setShowConfirmClearCache] = useState(false);
  const [confirmRestoreBackup, setConfirmRestoreBackup] = useState<"main" | "autosave" | null>(null);
  const [showConfirmPurgeDiscarded, setShowConfirmPurgeDiscarded] = useState(false);
  const [newProjectModalError, setNewProjectModalError] = useState<string | null>(null);

  const [ollamaUrl, setOllamaUrl] = useState(() => {
    try {
      return localStorage.getItem("ethos_ollama_url") || "http://localhost:11434";
    } catch {
      return "http://localhost:11434";
    }
  });

  const [ollamaModel, setOllamaModel] = useState(() => {
    try {
      return localStorage.getItem("ethos_ollama_model") || "llama3";
    } catch {
      return "llama3";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("ethos_ollama_url", ollamaUrl);
    } catch (e) {}
  }, [ollamaUrl]);

  useEffect(() => {
    try {
      localStorage.setItem("ethos_ollama_model", ollamaModel);
    } catch (e) {}
  }, [ollamaModel]);

  const [customApiKey, setCustomApiKey] = useState(() => {
    try {
      return localStorage.getItem("custom_gemini_key") || "";
    } catch {
      return "";
    }
  });
  const [showApiKey, setShowApiKey] = useState(false);

  // OpenAI Integration States
  const [openAiKey, setOpenAiKey] = useState(() => {
    try {
      return localStorage.getItem("custom_openai_key") || "";
    } catch {
      return "";
    }
  });
  const [useOpenAiForPrompts, setUseOpenAiForPrompts] = useState(() => {
    try {
      return localStorage.getItem("use_openai_for_prompts") === "true";
    } catch {
      return false;
    }
  });
  const [openAiModel, setOpenAiModel] = useState(() => {
    try {
      return localStorage.getItem("openai_model") || "gpt-4o-mini";
    } catch {
      return "gpt-4o-mini";
    }
  });
  const [openAiDalleModel, setOpenAiDalleModel] = useState(() => {
    try {
      return localStorage.getItem("openai_dalle_model") || "dall-e-3";
    } catch {
      return "dall-e-3";
    }
  });
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [resetTrigger, setResetTrigger] = useState(0);
  const [isTestingKey, setIsTestingKey] = useState(false);
  const [keyTestResult, setKeyTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);

  // Safety Backup and 1-minute Auto-save states
  interface BackupItem {
    type: "main" | "autosave";
    name: string;
    updatedAt: string;
    size: number;
  }
  const [availableBackups, setAvailableBackups] = useState<BackupItem[]>([]);
  const [lastAutosaveTime, setLastAutosaveTime] = useState<string | null>(() => {
    try {
      return localStorage.getItem("ethos_last_autosave_time") || null;
    } catch {
      return null;
    }
  });
  const [availableModels, setAvailableModels] = useState<{
    gemini: { text: string[]; image: string[] };
    openai: { text: string[]; image: string[] };
  }>({
    gemini: {
      text: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-pro", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash-lite", "gemini-1.5-flash", "gemini-1.5-pro"],
      image: ["imagen-3.0-generate-002", "imagen-3.0-fast-001"]
    },
    openai: {
      text: ["gpt-4o-mini", "gpt-4o", "gpt-4.5-preview", "o1-mini", "o3-mini"],
      image: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini", "dall-e-3", "dall-e-2"]
    }
  });

  const [geminiSearchStatus, setGeminiSearchStatus] = useState<"idle" | "searching" | "success" | "error">("idle");
  const [openaiSearchStatus, setOpenaiSearchStatus] = useState<"idle" | "searching" | "success" | "error">("idle");

  const fetchAvailableModels = async (provider: "gemini" | "openai" | "all" = "all") => {
    const isGemini = provider === "gemini" || provider === "all";
    const isOpenai = provider === "openai" || provider === "all";

    if (isGemini) setGeminiSearchStatus("searching");
    if (isOpenai) setOpenaiSearchStatus("searching");

    try {
      const queryParams = new URLSearchParams();
      if (customApiKey) queryParams.append("customApiKey", customApiKey);
      if (openAiKey) queryParams.append("openAiKey", openAiKey);
      const res = await fetch(`/api/storyboard/available-models?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data && (data.gemini || data.openai)) {
          const rawOpenAiText = data.openai?.text || [];
          const rawOpenAiImage = data.openai?.image || [];
          const allOpenAi = Array.from(new Set([...rawOpenAiText, ...rawOpenAiImage]));

          const cleanOpenAiText = allOpenAi.filter(m => !m.includes("image") && !m.startsWith("dall-e"));
          const cleanOpenAiImage = allOpenAi.filter(m => m.includes("image") || m.startsWith("dall-e"));

          setAvailableModels({
            gemini: {
              text: data.gemini?.text || [],
              image: data.gemini?.image || []
            },
            openai: {
              text: cleanOpenAiText.length > 0 ? cleanOpenAiText : ["gpt-4o-mini", "gpt-4o", "gpt-4.5-preview", "o1-mini", "o3-mini"],
              image: cleanOpenAiImage.length > 0 ? cleanOpenAiImage : ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini", "dall-e-3", "dall-e-2"]
            }
          });
          if (isGemini) {
            setGeminiSearchStatus("success");
            setTimeout(() => setGeminiSearchStatus("idle"), 3000);
          }
          if (isOpenai) {
            setOpenaiSearchStatus("success");
            setTimeout(() => setOpenaiSearchStatus("idle"), 3000);
          }
        }
      } else {
        if (isGemini) {
          setGeminiSearchStatus("error");
          setTimeout(() => setGeminiSearchStatus("idle"), 3000);
        }
        if (isOpenai) {
          setOpenaiSearchStatus("error");
          setTimeout(() => setOpenaiSearchStatus("idle"), 3000);
        }
      }
    } catch (err: any) {
      console.warn("Failed to fetch available models:", err);
      if (isGemini) {
        setGeminiSearchStatus("error");
        setTimeout(() => setGeminiSearchStatus("idle"), 3000);
      }
      if (isOpenai) {
        setOpenaiSearchStatus("error");
        setTimeout(() => setOpenaiSearchStatus("idle"), 3000);
      }
    }
  };

  useEffect(() => {
    fetchAvailableModels("all");
  }, [customApiKey, openAiKey]);

  // Ollama local models integration
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isFetchingOllamaModels, setIsFetchingOllamaModels] = useState(false);

  const fetchOllamaModels = async () => {
    setIsFetchingOllamaModels(true);
    try {
      const activeUrl = ollamaUrl.trim().replace(/\/$/, "");
      const res = await fetch(`${activeUrl}/api/tags`);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.models)) {
          const names = data.models.map((m: any) => m.name);
          setOllamaModels(names);
          if (names.length > 0 && !names.includes(ollamaModel)) {
            setOllamaModel(names[0]);
          }
          setNotification(`✓ Conexão com Ollama bem-sucedida! ${names.length} modelos locais encontrados.`);
        } else {
          throw new Error("Formato de resposta inesperado do Ollama.");
        }
      } else {
        throw new Error(`Erro HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.warn("Failed to fetch Ollama models:", err);
      setError(`Não foi possível conectar ao Ollama: ${err.message || err}. Verifique se o Ollama está rodando e configurado com OLLAMA_ORIGINS="*"`);
    } finally {
      setIsFetchingOllamaModels(false);
    }
  };

  useEffect(() => {
    if (ollamaUrl) {
      fetchOllamaModels().catch(() => {});
    }
  }, []);

  const [isAutosaving, setIsAutosaving] = useState(false);

  const fetchAvailableBackups = async () => {
    try {
      const response = await fetch("/api/storyboard/backups/list");
      if (response.ok) {
        const data = await response.json();
        setAvailableBackups(data);
      }
    } catch (err) {
      console.warn("Failed to fetch available backups:", err);
    }
  };

  const handleRestoreBackup = async (type: "main" | "autosave") => {
    try {
      pushToHistory();
      const response = await fetch("/api/storyboard/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type })
      });
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data && Array.isArray(result.data.scenes)) {
          const hydrated = await hydrateScenes(result.data.scenes);
          setScenes(hydrated);
          if (result.data.stylePreference) {
            setStylePreference(result.data.stylePreference);
          }
          if (result.data.projectName) {
            setProjectName(result.data.projectName);
          }
          if (result.data.scriptText) {
            setScriptText(result.data.scriptText);
          }
          if (result.data.scriptReferenceImage !== undefined) {
            setScriptReferenceImage(result.data.scriptReferenceImage || undefined);
          }
          if (result.data.connectionGroups) {
            setConnectionGroups(result.data.connectionGroups);
          }
          if (result.data.selectedStyle) {
            setSelectedStyle(result.data.selectedStyle);
          }
          if (result.data.consecutiveNumbering !== undefined) {
            setConsecutiveNumbering(result.data.consecutiveNumbering);
          }
          setNotification(`✓ Backup "${type === "main" ? "Sessão Principal" : "Auto-Save de Segurança"}" restaurado com sucesso!`);
          setActiveView("storyboard");
        } else {
          setError("Falha ao ler os dados do backup.");
        }
      } else {
        const errData = await response.json();
        setError(`Erro ao restaurar backup: ${errData.error || "Erro desconhecido"}`);
      }
    } catch (err: any) {
      setError(`Erro de rede ao restaurar backup: ${err.message}`);
    }
  };

  // Trigger Lightweight Safety Backup to server
  const triggerAutosave = async (customScenes?: StoryboardScene[]) => {
    const scenesToSave = customScenes || scenes;
    if (scenesToSave.length === 0) return;
    try {
      setIsAutosaving(true);
      const response = await fetch("/api/storyboard/autosave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          scenes: scenesToSave, 
          stylePreference,
          projectName,
          scriptText,
          scriptReferenceImage,
          connectionGroups,
          selectedStyle,
          consecutiveNumbering
        }),
      });
      if (response.ok) {
        const now = new Date();
        const timeString = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        setLastAutosaveTime(timeString);
        try {
          localStorage.setItem("ethos_last_autosave_time", timeString);
        } catch {}
        console.log(`[Auto-Save Event] Backup leve efetuado com sucesso às ${timeString}`);
        fetchAvailableBackups();
      }
    } catch (err) {
      console.warn("[Auto-Save Event] Falha ao realizar auto-salvamento no servidor:", err);
    } finally {
      setIsAutosaving(false);
    }
  };

  // Fetch backups on config view entrance
  useEffect(() => {
    if (activeView === "config") {
      fetchAvailableBackups();
    }
  }, [activeView, lastAutosaveTime]);

  const [connectionGroups, setConnectionGroups] = useState<ConnectionGroup[]>(() => {
    try {
      const saved = localStorage.getItem("ethos_connection_groups");
      if (saved) return JSON.parse(saved);
    } catch {}
    // Default initial groups if empty, with beautiful colors
    return [
      { id: "group-1", name: "Grupo Alfa", color: "#D4AF37", description: "Consistência de personagens e estilo" },
      { id: "group-2", name: "Grupo Beta", color: "#3B82F6", description: "Continuidade de cenários secundários" },
      { id: "group-3", name: "Grupo Gama", color: "#10B981", description: "Esquema cromático complementar" },
    ];
  });

  useEffect(() => {
    try {
      localStorage.setItem("ethos_connection_groups", JSON.stringify(connectionGroups));
    } catch (e) {
      console.warn("Failed to persist connection groups", e);
    }
  }, [connectionGroups]);

  const [audioNarrationUrl, setAudioNarrationUrl] = useState<string | undefined>();
  const midProjectAudioInputRef = useRef<HTMLInputElement>(null);



  const [isConnectionMode, setIsConnectionMode] = useState(false);
  const [selectedSceneIdsForConnection, setSelectedSceneIdsForConnection] = useState<string[]>([]);
  const [selectedConnectionGroupId, setSelectedConnectionGroupId] = useState("group-1");
  const [selectedStyleTab, setSelectedStyleTab] = useState<string>("caravaggio");
  const [showEmptyScenesSubMenu, setShowEmptyScenesSubMenu] = useState(false);
  const [showImageModelSubMenu, setShowImageModelSubMenu] = useState(false);

  const handleConfirmConnection = () => {
    if (selectedSceneIdsForConnection.length < 2) return;
    pushToHistory();
    setScenes((prev) =>
      prev.map((s) => {
        if (selectedSceneIdsForConnection.includes(s.id)) {
          return {
            ...s,
            connectionGroupId: selectedConnectionGroupId,
          };
        }
        return s;
      })
    );
    const activeGroup = connectionGroups.find((g) => g.id === selectedConnectionGroupId);
    setNotification(
      `✓ ${selectedSceneIdsForConnection.length} cenas conectadas com sucesso ao "${activeGroup?.name || "Grupo"}"!`
    );
    setIsConnectionMode(false);
    setSelectedSceneIdsForConnection([]);
  };

  const handleRemoveConnection = () => {
    if (selectedSceneIdsForConnection.length === 0) return;
    pushToHistory();
    setScenes((prev) =>
      prev.map((s) => {
        if (selectedSceneIdsForConnection.includes(s.id)) {
          return {
            ...s,
            connectionGroupId: undefined,
          };
        }
        return s;
      })
    );
    setNotification(`✓ Conexão removida das cenas selecionadas.`);
    setIsConnectionMode(false);
    setSelectedSceneIdsForConnection([]);
  };

  const handleToggleSceneSelection = (sceneId: string) => {
    setSelectedSceneIdsForConnection((prev) =>
      prev.includes(sceneId) ? prev.filter((id) => id !== sceneId) : [...prev, sceneId]
    );
  };
  
  const [projectName, setProjectName] = useState<string>(() => {
    try {
      return localStorage.getItem("ethos_storyboard_project_name") || "Meu Storyboard";
    } catch {
      return "Meu Storyboard";
    }
  });

  const [diaryDate, setDiaryDate] = useState<string>(() => {
    try {
      return localStorage.getItem("ethos_storyboard_diary_date") || "";
    } catch {
      return "";
    }
  });

  const [saveVersion, setSaveVersion] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("ethos_storyboard_save_version");
      return saved ? parseInt(saved, 10) : 1;
    } catch {
      return 1;
    }
  });

  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectDate, setNewProjectDate] = useState("");
  const [newProjectScript, setNewProjectScript] = useState("");
  const [newProjectAudioFile, setNewProjectAudioFile] = useState<File | null>(null);
  const [newProjectAudioFileName, setNewProjectAudioFileName] = useState<string | undefined>();
  const newProjectAudioInputRef = useRef<HTMLInputElement>(null);
  const [newProjectStyle, setNewProjectStyle] = useState<StylePreference>("auto");
  const [newProjectStyleRefImage, setNewProjectStyleRefImage] = useState<string | undefined>(undefined);
  const [newProjectEngine, setNewProjectEngine] = useState<"gemini" | "openai">("gemini");

  const [showLogsModal, setShowLogsModal] = useState(false);
  const [logsText, setLogsText] = useState("");

  const handleFetchLogs = async () => {
    try {
      const res = await fetch("/api/storyboard/logs");
      const txt = await res.text();
      setLogsText(txt);
      setShowLogsModal(true);
    } catch (e: any) {
      setLogsText(`Erro ao buscar logs do servidor: ${e.message || e}`);
      setShowLogsModal(true);
    }
  };

  const [projectFolder, setProjectFolder] = useState<string>(() => {
    try {
      return localStorage.getItem("ethos_project_folder") || "meu-projeto";
    } catch {
      return "meu-projeto";
    }
  });

  const [serverProjectsList, setServerProjectsList] = useState<any[]>([]);
  const [isSavingToDisk, setIsSavingToDisk] = useState(false);
  const [lastDiskSaveTime, setLastDiskSaveTime] = useState<string | null>(null);

  const fetchServerProjectsList = async () => {
    try {
      const response = await fetch("/api/storyboard/projects/list");
      if (response.ok) {
        const data = await response.json();
        setServerProjectsList(data);
      }
    } catch (err) {
      console.warn("Erro ao listar diretórios de projeto no servidor:", err);
    }
  };

  useEffect(() => {
    fetchServerProjectsList();
  }, [projectFolder]);

  useEffect(() => {
    if (isHydrating) return;
    try {
      localStorage.setItem("ethos_project_folder", projectFolder);
      fetch("/api/storyboard/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectFolder })
      }).catch(() => {});
    } catch (e) {
      console.warn("Failed to persist project folder to local storage", e);
    }
  }, [projectFolder, isHydrating]);

  const [scriptReferenceImage, setScriptReferenceImage] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem("ethos_storyboard_script_reference_image") || undefined;
    } catch {
      return undefined;
    }
  });

  useEffect(() => {
    try {
      if (scriptReferenceImage) {
        localStorage.setItem("ethos_storyboard_script_reference_image", scriptReferenceImage);
      } else {
        localStorage.removeItem("ethos_storyboard_script_reference_image");
      }
    } catch (e) {
      console.warn("Failed to persist script reference image to local storage", e);
    }
  }, [scriptReferenceImage]);

  useEffect(() => {
    try {
      localStorage.setItem("ethos_storyboard_project_name", projectName);
    } catch (e) {
      console.warn("Failed to persist project name to local storage", e);
    }
  }, [projectName]);

  // Hydrate & persist audio narration URL on project reload / F5 refresh
  useEffect(() => {
    if (projectName) {
      const savedUrl = localStorage.getItem(`ethos_storyboard_audio_url_${projectName}`) || localStorage.getItem("ethos_storyboard_audio_url");
      if (savedUrl) {
        setAudioNarrationUrl(savedUrl);
      } else {
        const url = `/api/projects/${projectName}/narration.wav`;
        fetch(url, { method: "HEAD" })
          .then((res) => {
            if (res.ok) {
              setAudioNarrationUrl(url);
              localStorage.setItem(`ethos_storyboard_audio_url_${projectName}`, url);
            }
          })
          .catch(() => {});
      }
    }
  }, [projectName]);

  // Sync audioNarrationUrl to localStorage whenever it changes
  useEffect(() => {
    if (audioNarrationUrl && projectName) {
      localStorage.setItem(`ethos_storyboard_audio_url_${projectName}`, audioNarrationUrl);
      localStorage.setItem("ethos_storyboard_audio_url", audioNarrationUrl);
    }
  }, [audioNarrationUrl, projectName]);

  useEffect(() => {
    try {
      localStorage.setItem("ethos_storyboard_diary_date", diaryDate);
    } catch (e) {
      console.warn("Failed to persist diary date to local storage", e);
    }
  }, [diaryDate]);

  useEffect(() => {
    try {
      localStorage.setItem("ethos_storyboard_save_version", String(saveVersion));
    } catch (e) {
      console.warn("Failed to persist save version to local storage", e);
    }
  }, [saveVersion]);

  const [consecutiveNumbering, setConsecutiveNumbering] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("ethos_storyboard_consecutive_numbering");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("ethos_storyboard_consecutive_numbering", String(consecutiveNumbering));
    } catch (e) {
      console.warn("Failed to persist consecutive numbering to local storage", e);
    }
  }, [consecutiveNumbering]);

  useEffect(() => {
    try {
      localStorage.setItem("ethos_local_cache_enabled", String(localCacheEnabled));
    } catch (e) {
      console.warn("Failed to persist local cache setting", e);
    }
  }, [localCacheEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem("ethos_export_mode_option", exportModeOption);
    } catch (e) {
      console.warn("Failed to persist export mode setting", e);
    }
  }, [exportModeOption]);

  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // Immersive session image archive states
  const [sessionImageArchive, setSessionImageArchive] = useState<ArchivedImage[]>(() => {
    try {
      const saved = localStorage.getItem("ethos_storyboard_image_archive");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isGalleryOpen, setIsGalleryOpen] = useState(false);

  // Update cached size tracker whenever scenes or archive changes
  useEffect(() => {
    const updateCacheSize = async () => {
      try {
        const size = await getCacheSizeMB();
        setCacheSizeMB(size);
      } catch (err) {
        console.warn("Failed to estimate cache size:", err);
      }
    };
    updateCacheSize();
  }, [scenes, sessionImageArchive]);

  // Scroll locking mechanism when the Gallery or Script modal is open + ESC key close listener
  useEffect(() => {
    const isAnyModalOpen = isGalleryOpen || showScriptModal;
    if (isAnyModalOpen) {
      document.body.style.overflow = "hidden";
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          if (isGalleryOpen) setIsGalleryOpen(false);
          if (showScriptModal) setShowScriptModal(false);
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        document.body.style.overflow = "";
        window.removeEventListener("keydown", handleKeyDown);
      };
    } else {
      document.body.style.overflow = "";
    }
  }, [isGalleryOpen, showScriptModal]);

  useEffect(() => {
    const persistArchive = async () => {
      try {
        if (localCacheEnabled) {
          const dehydratedArchive = await Promise.all(sessionImageArchive.map(async (item) => {
            const cloned = { ...item };
            if (cloned.url && cloned.url.startsWith("data:")) {
              const key = `img_archive_${item.id}`;
              await setCachedImage(key, cloned.url);
              cloned.url = `idb://${key}`;
            }
            return cloned;
          }));
          setLocalStorageItemSafely("ethos_storyboard_image_archive", JSON.stringify(dehydratedArchive));
        } else {
          setLocalStorageItemSafely("ethos_storyboard_image_archive", JSON.stringify(sessionImageArchive));
        }
      } catch (err) {
        console.warn("Error during archive dehydration:", err);
      }
    };

    persistArchive();
  }, [sessionImageArchive, localCacheEnabled]);

  const hydrateScenes = async (dehydrated: StoryboardScene[]): Promise<StoryboardScene[]> => {
    try {
      return await Promise.all(dehydrated.map(async (s) => {
        const cloned = { ...s };
        
        // Reset transient queue states to avoid infinite spinners or double triggers on restore
        if (cloned.renderStatus === "queued" || cloned.renderStatus === "rendering") {
          cloned.renderStatus = cloned.generatedImageUrl ? "completed" : "idle";
        }
        if (cloned.promptQueueStatus === "queued" || cloned.promptQueueStatus === "generating") {
          cloned.promptQueueStatus = undefined;
        }

        // Deep cleanse and eliminate "Midjourney" persistence as requested by the user
        if (cloned.promptTargetTool && (cloned.promptTargetTool === "Midjourney" || cloned.promptTargetTool === "midjourney" || cloned.promptTargetTool.toLowerCase() === "midjourney" || cloned.promptTargetTool.includes("midjourney"))) {
          cloned.promptTargetTool = "Nano Banana";
        }

        if (cloned.generatedImageUrl && cloned.generatedImageUrl.startsWith("idb://")) {
          const key = cloned.generatedImageUrl.replace("idb://", "");
          const realData = await getCachedImage(key);
          if (realData) {
            cloned.generatedImageUrl = realData;
          } else {
            cloned.generatedImageUrl = undefined;
          }
        }
        
        if (cloned.imageVersions && cloned.imageVersions.length > 0) {
          cloned.imageVersions = await Promise.all(cloned.imageVersions.map(async (v) => {
            const clonedV = { ...v };
            if (clonedV.url && clonedV.url.startsWith("idb://")) {
              const key = clonedV.url.replace("idb://", "");
              const realData = await getCachedImage(key);
              if (realData) {
                clonedV.url = realData;
              } else {
                clonedV.url = undefined;
              }
            }
            return clonedV;
          }));
        }
        return cloned;
      }));
    } catch (e) {
      console.warn("Hydration failed for scenes:", e);
      return dehydrated;
    }
  };

  const hydrateArchive = async (dehydrated: ArchivedImage[]): Promise<ArchivedImage[]> => {
    try {
      return await Promise.all(dehydrated.map(async (item) => {
        const cloned = { ...item };
        if (cloned.url && cloned.url.startsWith("idb://")) {
          const key = cloned.url.replace("idb://", "");
          const realData = await getCachedImage(key);
          if (realData) {
            cloned.url = realData;
          } else {
            cloned.url = undefined;
          }
        }
        return cloned;
      }));
    } catch (e) {
      console.warn("Hydration failed for archive:", e);
      return dehydrated;
    }
  };

  // Helper robusto para converter imagens base64 ou URLs externas via proxy do backend em Blobs binários para o Zip
  const fetchImageAsBlob = async (url: string): Promise<Blob | null> => {
    if (!url) return null;
    if (url.startsWith("data:")) {
      try {
        const parts = url.split(",");
        const byteString = atob(parts[1]);
        const mimeString = parts[0].split(":")[1].split(";")[0];
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
          ia[i] = byteString.charCodeAt(i);
        }
        return new Blob([ab], { type: mimeString });
      } catch (err) {
        console.warn("Failed to parse inline base64 image data", err);
        return null;
      }
    } else {
      // É uma URL externa (como Unsplash), baixamos via proxy para burlar CORS no cliente
      try {
        const proxyUrl = `/api/storyboard/proxy-image?url=${encodeURIComponent(url)}`;
        const res = await fetch(proxyUrl);
        if (res.ok) {
          return await res.blob();
        }
      } catch (e) {
        console.warn("Failed to fetch proxy image:", e);
      }
      // Fallback: Tentativa direta
      try {
        const res = await fetch(url);
        if (res.ok) {
          return await res.blob();
        }
      } catch (e) {
        console.error("Direct fetch failed too:", e);
      }
    }
    return null;
  };

  // Synchronize state with LocalStorage and Server database for automatic session recovery
  useEffect(() => {
    try {
      localStorage.setItem("ethos_storyboard_script_text", scriptText);
    } catch (err) {
      console.warn("Could not save scriptText to localStorage:", err);
    }
  }, [scriptText]);

  useEffect(() => {
    try {
      localStorage.setItem("ethos_storyboard_selected_style", selectedStyle);
    } catch (err) {
      console.warn("Could not save selectedStyle to localStorage:", err);
    }
  }, [selectedStyle]);

  // Helper robusto para ler e fazer parse de respostas HTTP com segurança anti-falha de HTML/JSON
  const safeParseResponse = async (response: Response, defaultErrorContext: string): Promise<any> => {
    const text = await response.text();
    let data: any = null;
    let isJson = false;
    try {
      data = JSON.parse(text);
      isJson = true;
    } catch (_) {
      isJson = false;
    }

    if (!response.ok) {
      if (isJson && data && (data.error || data.message)) {
        throw new Error(data.error || data.message);
      }
      let htmlTitle = "";
      if (text.includes("<title>")) {
        const match = text.match(/<title>([\s\S]*?)<\/title>/i);
        if (match && match[1]) {
          htmlTitle = `: ${match[1].trim()}`;
        }
      }
      throw new Error(`${defaultErrorContext} (Status do Servidor: ${response.status}${htmlTitle})`);
    }

    if (!isJson) {
      throw new Error(`Resposta do servidor malformada: Não é um JSON válido`);
    }

    return data;
  };

  // Synchronize state with Server config file for automatic session recovery
  useEffect(() => {
    if (isHydrating) return;
    try {
      localStorage.setItem("custom_gemini_key", customApiKey);
      fetch("/api/storyboard/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customGeminiKey: customApiKey })
      }).catch(() => {});
    } catch (err) {
      console.warn("Could not save customApiKey to localStorage:", err);
    }
  }, [customApiKey, isHydrating]);

  useEffect(() => {
    if (isHydrating) return;
    try {
      localStorage.setItem("custom_openai_key", openAiKey);
      localStorage.setItem("use_openai_for_prompts", String(useOpenAiForPrompts));
      localStorage.setItem("openai_model", openAiModel);
      localStorage.setItem("openai_dalle_model", openAiDalleModel);
      fetch("/api/storyboard/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customOpenAiKey: openAiKey,
          useOpenAiForPrompts,
          openAiModel,
          openAiDalleModel
        })
      }).catch(() => {});
    } catch (err) {
      console.warn("Could not save OpenAI config to localStorage:", err);
    }
  }, [openAiKey, useOpenAiForPrompts, openAiModel, openAiDalleModel, isHydrating]);
  useEffect(() => {
    if (isHydrating) return;
    if (scenes.length === 0) return;

    const persistScenes = async () => {
      try {
        const nowStr = new Date().toISOString();
        localStorage.setItem("ethos_storyboard_updated_at", nowStr);

        if (localCacheEnabled) {
          const dehydratedScenes = await Promise.all(scenes.map(async (s) => {
            const cloned = { ...s };
            
            // Active image
            if (cloned.generatedImageUrl && cloned.generatedImageUrl.startsWith("data:")) {
              const key = `img_scene_${s.id}_active`;
              await setCachedImage(key, cloned.generatedImageUrl);
              cloned.generatedImageUrl = `idb://${key}`;
            }
            
            // Versions
            if (cloned.imageVersions && cloned.imageVersions.length > 0) {
              cloned.imageVersions = await Promise.all(cloned.imageVersions.map(async (v) => {
                const clonedV = { ...v };
                if (clonedV.url && clonedV.url.startsWith("data:")) {
                  const key = `img_version_${v.id}`;
                  await setCachedImage(key, clonedV.url);
                  clonedV.url = `idb://${key}`;
                }
                return clonedV;
              }));
            }
            return cloned;
          }));
          
          setLocalStorageItemSafely("ethos_storyboard_scenes", JSON.stringify(dehydratedScenes));
        } else {
          setLocalStorageItemSafely("ethos_storyboard_scenes", JSON.stringify(scenes));
        }
      } catch (err) {
        console.warn("Error during scenes dehydration:", err);
      }
    };

    persistScenes();

    // Sync to server storage asynchronously
    const nowStr = new Date().toISOString();
    const payload = {
      folder: projectFolder,
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
      updatedAt: nowStr
    };

    // 1. Salva no diretório do projeto físico
    fetch("/api/storyboard/projects/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    .then((res) => {
      if (res.ok) {
        setLastDiskSaveTime(new Date().toLocaleTimeString());
      }
    })
    .catch((err) => console.info("Failed to save project physically:", err));

    // 2. Salva na sessão global para compatibilidade
    fetch("/api/storyboard/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => console.info("Failed to sync session to legacy server storage:", err));
  }, [scenes, stylePreference, localCacheEnabled, projectName, scriptText, scriptReferenceImage, connectionGroups, selectedStyle, consecutiveNumbering, projectFolder, diaryDate, saveVersion, isHydrating]);

  // Robust Session Retrieval on mount from both server and local storage with IndexedDB hydration support
  useEffect(() => {
    const loadSavedSession = async () => {
      setIsHydrating(true);
      
      // Load configurations from server-side user_config.json
      let currentFolder = projectFolder;
      try {
        const configRes = await fetch("/api/storyboard/config");
        if (configRes.ok) {
          const configData = await configRes.json();
          if (configData.customGeminiKey !== undefined) setCustomApiKey(configData.customGeminiKey);
          if (configData.customOpenAiKey !== undefined) setOpenAiKey(configData.customOpenAiKey);
          if (configData.useOpenAiForPrompts !== undefined) setUseOpenAiForPrompts(configData.useOpenAiForPrompts);
          if (configData.openAiModel !== undefined) setOpenAiModel(configData.openAiModel);
          if (configData.openAiDalleModel !== undefined) setOpenAiDalleModel(configData.openAiDalleModel);
          if (configData.ollamaUrl !== undefined) setOllamaUrl(configData.ollamaUrl);
          if (configData.ollamaModel !== undefined) setOllamaModel(configData.ollamaModel);
          if (configData.projectFolder !== undefined) {
            setProjectFolder(configData.projectFolder);
            currentFolder = configData.projectFolder;
          }
        }
      } catch (err) {
        console.warn("Failed to load server configuration file:", err);
      }

      let loadedData: any = null;
      let loadedSource: "disk" | "legacy" | "none" = "none";

      // 1. Tenta carregar o projeto ativo do servidor
      try {
        const response = await fetch(`/api/storyboard/projects/load?folder=${encodeURIComponent(currentFolder)}`);
        if (response.ok) {
          const resJson = await response.json();
          if (resJson.success && resJson.data && resJson.data.scenes && resJson.data.scenes.length > 0) {
            loadedData = resJson.data;
            loadedSource = "disk";
          }
        }
      } catch (err) {
        console.warn("Física do projeto não pôde ser carregada do disco:", err);
      }

      // 2. Se não encontrou projeto físico, tenta a sessão legada para retrocompatibilidade
      if (!loadedData) {
        try {
          const response = await fetch("/api/storyboard/session");
          if (response.ok) {
            const data = await response.json();
            if (data && data.scenes && data.scenes.length > 0) {
              loadedData = data;
              loadedSource = "legacy";
            }
          }
        } catch (err) {
          console.warn("Sessão legada do servidor não disponível:", err);
        }
      }

      // 3. Verifica se o localStorage tem uma versão mais recente para evitar perdas pós-reload
      let finalData = loadedData;
      let usedLocalOverServer = false;

      try {
        const localSavedScenes = localStorage.getItem("ethos_storyboard_scenes");
        const localUpdatedAtStr = localStorage.getItem("ethos_storyboard_updated_at");

        if (localSavedScenes) {
          const parsedLocalScenes = JSON.parse(localSavedScenes);
          if (Array.isArray(parsedLocalScenes) && parsedLocalScenes.length > 0) {
            // LocalStorage fallback comparison is skipped unless server file has no scenes or fails.
            // This ensures browser caching does not corrupt correct physical server assets.
            if (!loadedData) {
              // Se não há dados no servidor, restaura local diretamente
              finalData = {
                scenes: parsedLocalScenes,
                stylePreference: localStorage.getItem("ethos_storyboard_style") || "auto",
                projectName: localStorage.getItem("ethos_storyboard_project_name") || "Meu Storyboard",
                scriptText: localStorage.getItem("ethos_storyboard_script_text") || "",
                selectedStyle: localStorage.getItem("ethos_storyboard_selected_style") || "auto",
                connectionGroups: JSON.parse(localStorage.getItem("ethos_storyboard_connection_groups") || "[]"),
                consecutiveNumbering: localStorage.getItem("ethos_storyboard_consecutive_numbering") !== "false",
                diaryDate: localStorage.getItem("ethos_storyboard_diary_date") || "",
                saveVersion: localStorage.getItem("ethos_storyboard_save_version") ? Number(localStorage.getItem("ethos_storyboard_save_version")) : 1,
                updatedAt: localUpdatedAtStr || new Date().toISOString()
              };
            }
          }
        }
      } catch (localErr) {
        console.warn("Erro ao comparar com cache do localStorage:", localErr);
      }

      // 4. Aplica os dados hidratados
      if (finalData && finalData.scenes && finalData.scenes.length > 0) {
        try {
          const cleaned = finalData.scenes.map((s: any) => {
            if (s.renderStatus === "queued" || s.renderStatus === "rendering") {
              return {
                ...s,
                renderStatus: s.generatedImageUrl ? "completed" : "idle"
              };
            }
            return s;
          });
          const hydrated = await hydrateScenes(cleaned);
          setScenes(hydrated);

          if (finalData.stylePreference) setStylePreference(finalData.stylePreference);
          if (finalData.projectName) setProjectName(finalData.projectName);
          if (finalData.scriptText) setScriptText(finalData.scriptText);
          if (finalData.scriptReferenceImage !== undefined) setScriptReferenceImage(finalData.scriptReferenceImage || undefined);
          if (finalData.connectionGroups) setConnectionGroups(finalData.connectionGroups);
          if (finalData.selectedStyle) setSelectedStyle(finalData.selectedStyle);
          if (finalData.consecutiveNumbering !== undefined) setConsecutiveNumbering(finalData.consecutiveNumbering);
          
          if (finalData.diaryDate) {
            setDiaryDate(finalData.diaryDate);
          } else {
            const localDiaryDate = localStorage.getItem("ethos_storyboard_diary_date");
            if (localDiaryDate) setDiaryDate(localDiaryDate);
          }
          if (finalData.saveVersion !== undefined) {
            setSaveVersion(Number(finalData.saveVersion));
          } else {
            const localSaveVersion = localStorage.getItem("ethos_storyboard_save_version");
            if (localSaveVersion) setSaveVersion(Number(localSaveVersion));
          }

          if (usedLocalOverServer) {
            setNotification("Restauração Inteligente: Recuperamos suas edições em tempo real mais recentes do navegador!");
          } else if (loadedSource === "disk") {
            setNotification(`✓ Projeto carregado do diretório do servidor: "projects/${projectFolder}"`);
          } else if (loadedSource === "legacy") {
            setNotification("Sessão legada restaurada do servidor com sucesso!");
          }
        } catch (hydrationErr) {
          console.error("Hydration failed during load:", hydrationErr);
        }
      }

      // Restaura acervo do localStorage
      try {
        const localSavedArchive = localStorage.getItem("ethos_storyboard_image_archive");
        if (localSavedArchive) {
          const parsedArchive = JSON.parse(localSavedArchive);
          if (Array.isArray(parsedArchive) && parsedArchive.length > 0) {
            const hydratedArc = await hydrateArchive(parsedArchive);
            setSessionImageArchive(hydratedArc);
          }
        }
      } catch (archiveErr) {
        console.warn("Falha ao restaurar acervo de imagens local:", archiveErr);
      }

      setIsHydrating(false);
    };

    loadSavedSession();
  }, []);

  // Synchronize all scene images (active or versioned) into the session image archive to ensure they are always present in the "Acervo Imagens"
  useEffect(() => {
    if (scenes.length === 0) return;
    
    setSessionImageArchive((prevArchive) => {
      let updatedArchive = [...prevArchive];
      let changed = false;
      
      scenes.forEach((scene) => {
        // 1. Sync active image
        if (scene.generatedImageUrl) {
          if (!updatedArchive.some(item => item.url === scene.generatedImageUrl)) {
            updatedArchive.push({
              id: `sync-act-${scene.id}-${Math.random().toString(36).substring(2, 6)}`,
              url: scene.generatedImageUrl,
              timestamp: new Date().toLocaleTimeString(),
              sceneId: scene.id,
              originalSceneNumber: scene.sceneNumber || "",
              prompt: scene.prompt || "",
              text: scene.text || "",
              model: scene.selectedModel,
              engineName: scene.engineName,
              renderTimeSeconds: scene.renderTimeSeconds
            });
            changed = true;
          }
        }
        
        // 2. Sync versioned images
        if (scene.imageVersions && scene.imageVersions.length > 0) {
          scene.imageVersions.forEach((v) => {
            if (v.url && !updatedArchive.some(item => item.url === v.url)) {
              updatedArchive.push({
                id: v.id || `sync-v-${scene.id}-${Math.random().toString(36).substring(2, 6)}`,
                url: v.url,
                timestamp: v.timestamp || new Date().toLocaleTimeString(),
                sceneId: scene.id,
                originalSceneNumber: scene.sceneNumber || "",
                prompt: v.prompt || scene.prompt || "",
                text: v.description || scene.text || "",
                model: v.model,
                engineName: v.engineName,
                renderTimeSeconds: v.renderTimeSeconds
              });
              changed = true;
            }
          });
        }
      });
      
      return changed ? updatedArchive : prevArchive;
    });
  }, [scenes]);

  // Dynamically renumber scenes to be consecutive if consecutiveNumbering option is enabled
  useEffect(() => {
    if (consecutiveNumbering && scenes.length > 0) {
      const needsRenumbering = scenes.some((s, idx) => s.sceneNumber !== String(idx + 1));
      if (needsRenumbering) {
        setScenes(prev => prev.map((s, idx) => ({ ...s, sceneNumber: String(idx + 1) })));
      }
    }
  }, [consecutiveNumbering, scenes]);

  // Download all generated storyboard images as a single ZIP, cleanly numbered
  const handleDownloadAllImages = async () => {
    const scenesWithImages = scenes.filter(s => s.generatedImageUrl);
    if (scenesWithImages.length === 0) {
      setNotification("Nenhum quadro possui imagem gerada ainda. Gere algumas imagens primeiro!");
      return;
    }

    setIsDownloadingZip(true);
    setNotification("Preparando compilação do arquivo ZIP...");

    try {
      const zip = new JSZip();

      const downloadImage = async (url: string, baseFilename: string) => {
        if (!url) return;
        try {
          const { blob, ext } = await prepareImageBlobForDownload(url);
          const buffer = await blob.arrayBuffer();
          zip.file(`${baseFilename}.${ext}`, buffer);
        } catch (err: any) {
          console.warn(`Erro ao baixar imagem (${baseFilename}):`, err);
          zip.file(
            `ERRO-${baseFilename}-imagem-indisponivel.txt`,
            `Não foi possível baixar a imagem.\nErro: ${err.message || err}\nURL: ${url}`
          );
        }
      };

      const downloadPromises = scenes.flatMap((scene, index) => {
        const sceneNum = consecutiveNumbering 
          ? String(index + 1).padStart(2, "0") 
          : (scene.sceneNumber || String(index + 1));

        // Extract a short, clean slug from the description/text for the filename
        const cleanTitle = (scene.text || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "") // remove portuguese accents
          .replace(/[^a-z0-9]/g, "-")      // replace non-alphanumeric with hyphens
          .replace(/-+/g, "-")             // collapse duplicate hyphens
          .substring(0, 24)                // keep it concise
          .replace(/^-|-$/g, "");          // trim starting or ending hyphens

        if (scene.imageVersions && scene.imageVersions.length > 0) {
          return scene.imageVersions.map((v, vIdx) => {
            const letter = v.letter || getLetterFromIndex(vIdx);
            const baseFilename = `cena-${sceneNum}_${letter}${cleanTitle ? `-${cleanTitle}` : ""}`;
            return downloadImage(v.url, baseFilename);
          });
        } else if (scene.generatedImageUrl) {
          const baseFilename = `cena-${sceneNum}_A${cleanTitle ? `-${cleanTitle}` : ""}`;
          return [downloadImage(scene.generatedImageUrl, baseFilename)];
        }
        return [];
      });

      await Promise.all(downloadPromises);

      const zipContent = await zip.generateAsync({ type: "blob" });
      const downloadUrl = URL.createObjectURL(zipContent);
      
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `storyboard-cenas-audio-art.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);

      setNotification("Arquivo ZIP com todas as imagens baixado com sucesso!");
    } catch (err: any) {
      console.error("Erro ao gerar arquivo compactado:", err);
      setError(`Não foi possível compilar o arquivo ZIP: ${err.message || err}`);
    } finally {
      setIsDownloadingZip(false);
    }
  };

  // Clear session to start fresh
  const handleClearSession = async () => {
    pushToHistory();
    setScenes([]);
    setSessionImageArchive([]);
    setStylePreference("auto");
    setScriptText("");
    setScriptReferenceImage(undefined);
    setSelectedStyle("auto");
    setDiaryDate("");
    setSaveVersion(1);
    setProjectName("Meu Storyboard");
    setError(null);
    setResetTrigger(prev => prev + 1);
    
    try {
      await clearCache();
      setCacheSizeMB(0);
    } catch (err) {
      console.warn("Failed to clear IndexedDB cache during session reset:", err);
    }

    try {
      localStorage.removeItem("ethos_storyboard_scenes");
      localStorage.removeItem("ethos_storyboard_style");
      localStorage.removeItem("ethos_storyboard_image_archive");
      localStorage.removeItem("ethos_storyboard_script_reference_image");
      localStorage.removeItem("ethos_storyboard_script_text");
      localStorage.removeItem("ethos_storyboard_selected_style");
      localStorage.removeItem("ethos_storyboard_project_name");
      localStorage.removeItem("ethos_storyboard_diary_date");
      localStorage.removeItem("ethos_storyboard_save_version");
    } catch (_) {}
    
    fetch("/api/storyboard/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        scenes: [], 
        stylePreference: "auto",
        projectName: "Meu Storyboard",
        scriptText: "",
        diaryDate: "",
        saveVersion: 1
      }),
    }).catch((err) => console.warn("Failed to clear server session:", err));
    
    setNotification("Sessão e cache de imagens limpos. Pronto para iniciar um novo roteiro.");
    setShowConfirmClear(false);
  };

  // Test custom API Key connectivity and validity
  const handleTestApiKey = async () => {
    if (!customApiKey || !customApiKey.trim()) {
      setKeyTestResult({ success: false, message: "Insira uma chave válida no campo antes de testar." });
      return;
    }
    setIsTestingKey(true);
    setKeyTestResult(null);
    try {
      const response = await fetch("/api/storyboard/test-key", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-key": customApiKey
        },
        body: JSON.stringify({ customApiKey })
      });
      const data = await safeParseResponse(response, "Chave de API inválida ou erro na validação.");
      setKeyTestResult({ success: true, message: data.message });
      setNotification("Chave de API validada com sucesso!");
    } catch (err: any) {
      setKeyTestResult({ success: false, message: err.message || "Erro ao validar chave de API." });
    } finally {
      setIsTestingKey(false);
    }
  };

  // Explicitly retrieve previous session from persistent server storage and localStorage
  const handleManualRestoreSession = async () => {
    try {
      const response = await fetch("/api/storyboard/session");
      if (response.ok) {
        const data = await safeParseResponse(response, "Erro ao recuperar sessão.");
        if (data.scenes && Array.isArray(data.scenes) && data.scenes.length > 0) {
          setScenes(data.scenes);
          if (data.stylePreference) {
            setStylePreference(data.stylePreference);
          }
          setNotification("A sua última sessão de filmagem foi restaurada com sucesso do servidor!");
        } else {
          setNotification("Nenhuma sessão de filmagem anterior foi encontrada no servidor.");
        }
      } else {
        setNotification("Não foi possível alcançar o servidor de rascunhos.");
      }
    } catch (err) {
      console.error(err);
      setError("Dificuldade técnica ao tentar ler a sessão salva.");
    }
  };

  // Auto-clear notifications
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const detectStylePreference = (text: string): string => {
    const textLower = text.toLowerCase();
    let bestStyleId = "auto";
    let maxMatches = 0;
    
    artisticStyles.forEach((style) => {
      if (!style.autoDetectKeywords) return;
      const keywords = style.autoDetectKeywords
        .split(",")
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length > 0);
        
      let matchCount = 0;
      keywords.forEach((kw) => {
        if (textLower.includes(kw)) {
          matchCount++;
        }
      });
      
      if (matchCount > maxMatches) {
        maxMatches = matchCount;
        bestStyleId = style.id;
      }
    });
    
    return bestStyleId;
  };

  // Generate initial storyboard from Raw Text
  const handleGenerateStoryboard = async (
    rawText: string, 
    preference: StylePreference, 
    referenceImage?: string,
    selectedEngine?: "gemini" | "openai" | "ollama"
  ) => {
    pushToHistory([]);
    setIsGenerating(true);
    setError(null);
    setStylePreference(preference);
    setActiveView("storyboard");

    // If an engine is explicitly specified, respect it. Otherwise fallback to the general toggle.
    const useOpenAi = selectedEngine 
      ? (selectedEngine === "openai" && !!openAiKey)
      : (useOpenAiForPrompts && !!openAiKey);

    const resolvedStyleId = preference === "auto" ? detectStylePreference(rawText) : preference;
    const matchedStyle = artisticStyles.find(s => s.id === resolvedStyleId);
    const stylePrompt = matchedStyle ? matchedStyle.prompt : "";

    try {
      if (selectedEngine === "ollama") {
        try {
          const activeOllamaUrl = ollamaUrl.trim().replace(/\/$/, "");
          const systemInstruction = `You are an expert film director and AI storyboard prompt engineer. Your task is to analyze the narrative script and segment it into logical, pacing-appropriate sequential scenes. You MUST map 100% of the input text into sequential scenes verbatim in the "text" field.
Output MUST be valid JSON only, matching this schema exactly:
{
  "scenes": [
    {
      "text": "verbatim narration segment from the script",
      "description": "visual scene description in Brazilian Portuguese",
      "prompt": "detailed image prompt in English ending with 16:9 aspect ratio"
    }
  ]
}`;
          const userPromptText = `Script:\n"""\n${rawText}\n"""\n\nStyle guidelines:\n${stylePrompt || resolvedStyleId}`;
          
          const ollamaResponse = await fetch(`${activeOllamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: `${systemInstruction}\n\n${userPromptText}`,
              stream: false,
              options: { temperature: 0.3 }
            })
          });
          
          if (!ollamaResponse.ok) {
            throw new Error(`Ollama returned HTTP error ${ollamaResponse.status}`);
          }
          
          const ollamaData = await ollamaResponse.json();
          const responseText = ollamaData.response;
          
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
          
          if (parsed && Array.isArray(parsed.scenes)) {
            const initializedScenes = parsed.scenes.map((s: any, idx: number) => ({
              id: `scene-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 7)}`,
              text: s.text || "",
              description: s.description || "",
              prompt: s.prompt || "",
              sceneNumber: String(idx + 1),
              generationGuidelines: s.generationGuidelines || "",
              sceneStylePreference: s.sceneStylePreference || "auto",
              promptAiModel: "ollama",
              promptAiModelUsed: "ollama",
              promptTargetTool: "Nano Banana",
            }));
            setScenes(initializedScenes);
            setNotification("✓ Storyboard gerado com sucesso localmente via Ollama!");
          } else {
            throw new Error("Ollama returned invalid format.");
          }
          
        } catch (ollamaErr: any) {
          console.error("Ollama segmentation failed, using deterministic local segmenter:", ollamaErr);
          const segments = rawText.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
          const initializedScenes = segments.map((text, idx) => ({
            id: `scene-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 7)}`,
            text: text,
            description: "Cena de meditação contemplativa.",
            prompt: `Scenic landscape cinematography: ${text}, 16:9 aspect ratio`,
            sceneNumber: String(idx + 1),
            generationGuidelines: "",
            sceneStylePreference: "auto",
            promptAiModel: "ollama",
            promptTargetTool: "Nano Banana",
          }));
          setScenes(initializedScenes);
          setError(`⚠️ Conexão com Ollama falhou (${ollamaErr.message || "Erro de rede"}). O roteiro foi segmentado usando o algoritmo local inteligente.`);
        } finally {
          setIsGenerating(false);
        }
        return;
      }

      const response = await fetch("/api/storyboard/generate", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(customApiKey ? { "x-gemini-key": customApiKey } : {}),
          ...(useOpenAi ? {
            "x-use-openai": "true",
            "x-openai-key": openAiKey,
            "x-openai-model": openAiModel
          } : {})
        },
        body: JSON.stringify({ rawText, stylePreference: preference, customApiKey, scriptReferenceImage: referenceImage, stylePrompt }),
      });

      const data = await safeParseResponse(response, "Algo deu errado durante a geração do storyboard.");
      if (data.scenes && Array.isArray(data.scenes)) {
        const initializedScenes = data.scenes.map((s: any, idx: number) => ({
          id: `scene-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 7)}`,
          text: s.text || "",
          description: s.description || "",
          prompt: s.prompt || "",
          sceneNumber: String(idx + 1),
          generationGuidelines: s.generationGuidelines || "",
          sceneStylePreference: s.sceneStylePreference || "auto",
          promptAiModel: s.promptAiModel || "gemini-3.5-flash",
          promptAiModelUsed: s.promptAiModelUsed,
          promptTargetTool: s.promptTargetTool || "Nano Banana",
        }));
        setScenes(initializedScenes);
        if (data.isFallbackActive) {
          setError(`⚠️ Aviso do Diretor: ${data.fallbackReason || "Devido à alta demanda ou cota saturada nos servidores públicos do Gemini, o seu roteiro foi estruturado perfeitamente pelo Diretor de Arte local offline. O estúdio continua 100% operacional!"}`);
        } else {
          setNotification("Storyboard gerado com sucesso pelo Art Director AI!");
        }
        return initializedScenes;
      } else {
        throw new Error("Formato de resposta inválido recebido da IA.");
      }
    } catch (err: any) {
      setError(err.message || "Erro de conexão com o servidor.");
      return [];
    } finally {
      setIsGenerating(false);
    }
  };

  // Regenerate prompts and description for a single Scene row (queued)
  const handleRegenerateScene = (index: number, andGenerateImage?: boolean) => {
    if (index < 0 || index >= scenes.length) return;
    const targetScene = scenes[index];

    handleUpdateScene(targetScene.id, {
      promptQueueStatus: "queued",
      generateImageAfterPrompt: !!andGenerateImage
    });
    setShowQueuePanel(true);
  };

  // Update specific fields of a scene, dynamically tracking prompt modifications and image version histories
  const handleUpdateScene = (id: string, fields: Partial<StoryboardScene>, isEventAutosaveTrigger = false) => {
    // Only push to history if a user-edited text field, guideline, or image URL is changing
    const isUserEdit = fields.text !== undefined || fields.prompt !== undefined || fields.description !== undefined || fields.generatedImageUrl !== undefined || fields.generationGuidelines !== undefined;
    if (isUserEdit) {
      pushToHistory();
    }

    const scene = scenes.find(s => s.id === id);
    if (!scene) return;

    // Calculate updated image versions and letters
    let currentCount = scene.imageCount !== undefined ? scene.imageCount : 0;
    let updatedVersions = fields.imageVersions !== undefined ? fields.imageVersions : (scene.imageVersions || []);

    // Ensure existing versions have letters
    updatedVersions = updatedVersions.map((v, vIdx) => {
      if (!v.letter) {
        const letter = getLetterFromIndex(vIdx);
        if (vIdx + 1 > currentCount) {
          currentCount = vIdx + 1;
        }
        return { ...v, letter };
      }
      return v;
    });

    let oldLetter = "A";
    let newLetter = "A";

    const matchedOld = updatedVersions.find(v => v.url === scene.generatedImageUrl);
    if (matchedOld?.letter) {
      oldLetter = matchedOld.letter;
    }

    // If there is an old active generated image that isn't in versions yet, we will push it first
    if (scene.generatedImageUrl && fields.generatedImageUrl && fields.generatedImageUrl !== scene.generatedImageUrl) {
      if (!updatedVersions.some(v => v.url === scene.generatedImageUrl)) {
        const letter = getLetterFromIndex(currentCount);
        oldLetter = letter;
        currentCount += 1;
        const oldVersion = {
          id: Math.random().toString(36).substring(2, 9),
          url: scene.generatedImageUrl,
          timestamp: new Date().toLocaleTimeString(),
          prompt: scene.prompt,
          model: scene.selectedModel || "Desconhecido",
          engineName: scene.engineName || "Geração",
          renderTimeSeconds: scene.renderTimeSeconds,
          description: scene.description,
          letter: letter
        };
        updatedVersions = [oldVersion, ...updatedVersions];
      }
    }

    // If the new active image is set and is not yet in versions
    if (fields.generatedImageUrl && !updatedVersions.some(v => v.url === fields.generatedImageUrl)) {
      const letter = getLetterFromIndex(currentCount);
      newLetter = letter;
      currentCount += 1;
      const newVersion = {
        id: Math.random().toString(36).substring(2, 9),
        url: fields.generatedImageUrl,
        timestamp: new Date().toLocaleTimeString(),
        prompt: fields.prompt || scene.prompt,
        model: fields.selectedModel || scene.selectedModel || "Desconhecido",
        engineName: fields.engineName || scene.engineName || "Geração",
        renderTimeSeconds: fields.renderTimeSeconds || scene.renderTimeSeconds,
        description: fields.description || scene.description,
        letter: letter
      };
      updatedVersions = [newVersion, ...updatedVersions];
    } else if (fields.generatedImageUrl) {
      const matchedNew = updatedVersions.find(v => v.url === fields.generatedImageUrl);
      if (matchedNew?.letter) {
        newLetter = matchedNew.letter;
      }
    }

    // Update image archive
    if (fields.generatedImageUrl) {
      setSessionImageArchive((prevArchive) => {
        let updatedArchive = [...prevArchive];
        
        // Add old image with its oldLetter
        if (scene.generatedImageUrl && scene.generatedImageUrl !== fields.generatedImageUrl) {
          if (!updatedArchive.some(item => item.url === scene.generatedImageUrl)) {
            updatedArchive.push({
              id: Math.random().toString(36).substring(2, 9),
              url: scene.generatedImageUrl,
              timestamp: new Date().toLocaleTimeString(),
              sceneId: id,
              originalSceneNumber: scene.sceneNumber || "",
              prompt: scene.prompt || "",
              text: scene.text || "",
              model: scene.selectedModel,
              engineName: scene.engineName,
              renderTimeSeconds: scene.renderTimeSeconds,
              letter: oldLetter
            });
          }
        }
        
        // Add new image with its newLetter
        if (!updatedArchive.some(item => item.url === fields.generatedImageUrl)) {
          updatedArchive.push({
            id: Math.random().toString(36).substring(2, 9),
            url: fields.generatedImageUrl!,
            timestamp: new Date().toLocaleTimeString(),
            sceneId: id,
            originalSceneNumber: scene.sceneNumber || "",
            prompt: fields.prompt || scene.prompt || "",
            text: fields.text || scene.text || "",
            model: fields.selectedModel || scene.selectedModel,
            engineName: fields.engineName || scene.engineName,
            renderTimeSeconds: fields.renderTimeSeconds || scene.renderTimeSeconds,
            letter: newLetter
          });
        }
        return updatedArchive;
      });
    }

    // Trigger notifications based on changes from previous state (outside of the setScenes callback to prevent strict-mode double triggers)
    if (fields.renderStatus === "completed" && fields.generatedImageUrl && scene.renderStatus !== "completed") {
      const sceneIndex = scenes.findIndex((s) => s.id === id);
      const sceneNum = fields.sceneNumber || scene.sceneNumber || String(sceneIndex + 1).padStart(2, "0");
      if (activeStudioSceneIdRef.current !== id) {
        addFloatingNotification({
          sceneId: id,
          sceneNumber: sceneNum,
          type: "image",
          imageUrl: fields.generatedImageUrl,
          message: `O render da cena ${sceneNum} foi efetuado no Estúdio AI.`
        });
      }
    }

    if ((fields.promptQueueStatus === "completed" || (fields.promptQueueStatus === undefined && scene.promptQueueStatus === "generating")) && fields.prompt && scene.promptQueueStatus !== "completed") {
      const sceneIndex = scenes.findIndex((s) => s.id === id);
      const sceneNum = fields.sceneNumber || scene.sceneNumber || String(sceneIndex + 1).padStart(2, "0");
      addFloatingNotification({
        sceneId: id,
        sceneNumber: sceneNum,
        type: "text",
        message: `O prompt da cena ${sceneNum} foi refinado com sucesso.`
      });
    }

    // Now update scenes state
    setScenes((prev) => {
      const nextScenes = prev.map((s) => {
        if (s.id === id) {
          const isPromptChanging = fields.prompt !== undefined && fields.prompt !== s.prompt;
          return {
            ...s,
            ...fields,
            imageVersions: updatedVersions,
            imageCount: currentCount,
            isPromptModified: isPromptChanging ? true : (fields.isPromptModified !== undefined ? fields.isPromptModified : s.isPromptModified)
          };
        }
        return s;
      });
      if (isEventAutosaveTrigger || isUserEdit) {
        setTimeout(() => triggerAutosave(nextScenes), 0);
      }
      return nextScenes;
    });
  };

  // State and Ref for sequential image rendering queue
  const [activeRenderId, setActiveRenderId] = useState<string | null>(null);
  const activeRenderIdRef = React.useRef<string | null>(null);

  // State and Ref for sequential prompt generation queue
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const activePromptIdRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (activePromptIdRef.current) return;

    // Find first scene queued for prompt generation
    const nextToGenerate = scenes.find((s) => s.promptQueueStatus === "queued");
    
    if (!nextToGenerate) {
      // If we are not currently generating a prompt, but we have completed/failed ones,
      // let's transition them to image queue and reset promptQueueStatus
      const completedOrFailed = scenes.filter(s => s.promptQueueStatus === "completed" || s.promptQueueStatus === "failed");
      if (completedOrFailed.length > 0 && !activePromptId && !activePromptIdRef.current) {
        setScenes((prev) =>
          prev.map((s) => {
            if (s.promptQueueStatus === "completed" || s.promptQueueStatus === "failed") {
              const shouldQueueImage = s.promptQueueStatus === "completed" && !!s.generateImageAfterPrompt;
              return {
                ...s,
                promptQueueStatus: undefined,
                generateImageAfterPrompt: undefined,
                renderStatus: shouldQueueImage ? "queued" : s.renderStatus,
                renderError: shouldQueueImage ? undefined : s.renderError
              };
            }
            return s;
          })
        );
        
        const queuedCount = completedOrFailed.filter(s => s.promptQueueStatus === "completed" && s.generateImageAfterPrompt).length;
        if (queuedCount > 0) {
          setNotification(`Geração de prompts finalizada! Enfileirando ${queuedCount} imagens para renderização.`);
        } else {
          setNotification("Geração de prompts finalizada!");
        }
      }
      return;
    }

    activePromptIdRef.current = nextToGenerate.id;
    setActivePromptId(nextToGenerate.id);

    // Update status to "generating"
    handleUpdateScene(nextToGenerate.id, { promptQueueStatus: "generating" });

    const runGeneratePrompt = async () => {
      try {
        let data;
        const requestedModel = nextToGenerate.promptAiModel || "gemini-3.5-flash";
        const activeStyle = nextToGenerate.sceneStylePreference && nextToGenerate.sceneStylePreference !== "auto" 
          ? nextToGenerate.sceneStylePreference 
          : stylePreference;
        const resolvedStyleId = activeStyle === "auto" ? detectStylePreference(nextToGenerate.text) : activeStyle;
        const matchedStyle = artisticStyles.find(s => s.id === resolvedStyleId);
        const stylePrompt = matchedStyle ? matchedStyle.prompt : "";

        const isOllama = requestedModel === "ollama" || requestedModel.startsWith("ollama:");

        if (isOllama) {
          // Local browser Ollama fetch!
          const activeOllamaUrl = ollamaUrl.trim().replace(/\/$/, "");
          let resolvedOllamaModel = ollamaModel;
          if (requestedModel.startsWith("ollama:")) {
            resolvedOllamaModel = requestedModel.replace(/^ollama:/, "");
          }
          const systemInstruction = `You are an expert film director and AI storyboard prompt engineer. Your task is to generate:
1. A descriptive cinematic art direction segment in Brazilian Portuguese (PT-BR) under 150 words ("description").
2. A matching high-quality English image prompt for an AI image generator, which MUST end with '16:9 aspect ratio' ("prompt").

Output MUST be valid JSON only, with no other text, markdown formatting or explanations. Matching this schema exactly:
{
  "description": "visual scene description in Brazilian Portuguese",
  "prompt": "detailed image prompt in English ending with 16:9 aspect ratio"
}`;

          const userPromptText = `Narration Segment: "${nextToGenerate.text}"
Style preference/Vibe: ${matchedStyle ? matchedStyle.name : (resolvedStyleId || "auto")}
${stylePrompt ? `Style Guidelines:\n${stylePrompt}` : ""}
Guidelines/Critiques: ${nextToGenerate.generationGuidelines || ""}
Current Description: "${nextToGenerate.description || ""}"
Current Prompt: "${nextToGenerate.prompt || ""}"`;

          const ollamaResponse = await fetch(`${activeOllamaUrl}/api/generate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: resolvedOllamaModel,
              prompt: `${systemInstruction}\n\n${userPromptText}`,
              stream: false,
              options: {
                temperature: 0.7
              }
            })
          });

          if (!ollamaResponse.ok) {
            throw new Error(`Ollama retornou erro HTTP ${ollamaResponse.status}. Certifique-se de que o Ollama está rodando e configurado com OLLAMA_ORIGINS="*"`);
          }

          const ollamaData = await ollamaResponse.json();
          const responseText = ollamaData.response || "";

          // Attempt robust extraction
          let parsed;
          try {
            parsed = JSON.parse(responseText);
          } catch (e) {
            const match = responseText.match(/\{[\s\S]*\}/);
            if (match) {
              parsed = JSON.parse(match[0]);
            } else {
              throw new Error("Resposta do Ollama não pôde ser parseada como JSON estruturado: " + responseText);
            }
          }

          data = {
            description: parsed.description || parsed.visual_description || parsed.cena || "Cena gerada por Ollama",
            prompt: parsed.prompt || parsed.image_prompt || parsed.english_prompt || "Scenic cinematography 16:9 aspect ratio"
          };
        } else {
          const otherConnectedScenes = nextToGenerate.connectionGroupId
            ? scenes
                .filter((s) => s.connectionGroupId === nextToGenerate.connectionGroupId && s.id !== nextToGenerate.id)
                .map((s) => ({
                  sceneNumber: s.sceneNumber || String(scenes.indexOf(s) + 1).padStart(2, "0"),
                  text: s.text,
                  description: s.description,
                  prompt: s.prompt,
                  generatedImageUrl: s.generatedImageUrl,
                  visualInstructionImage: s.visualInstructionImage,
                }))
            : [];

          const response = await fetch("/api/storyboard/regenerate-scene", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(customApiKey ? { "x-gemini-key": customApiKey } : {}),
              ...((useOpenAiForPrompts || requestedModel === "chatgpt") && openAiKey ? {
                "x-use-openai": "true",
                "x-openai-key": openAiKey,
                "x-openai-model": openAiModel
              } : {})
            },
            body: JSON.stringify({
              text: nextToGenerate.text,
              stylePreference,
              currentDescription: nextToGenerate.description,
              currentPrompt: nextToGenerate.prompt,
              generationGuidelines: nextToGenerate.generationGuidelines || "",
              sceneStylePreference: nextToGenerate.sceneStylePreference || "auto",
              promptAiModel: requestedModel,
              promptTargetTool: nextToGenerate.promptTargetTool || "Nano Banana",
              customApiKey,
              connectedScenes: otherConnectedScenes,
              stylePrompt
            }),
          });

          data = await safeParseResponse(response, "Fracasso na geração automática do prompt da cena.");
        }

        const shouldQueueImage = !!nextToGenerate.generateImageAfterPrompt;
        handleUpdateScene(nextToGenerate.id, {
          description: data.description || nextToGenerate.description,
          prompt: data.prompt || nextToGenerate.prompt,
          promptQueueStatus: undefined,
          promptError: undefined,
          generateImageAfterPrompt: undefined,
          renderStatus: shouldQueueImage ? "queued" : nextToGenerate.renderStatus,
          renderError: shouldQueueImage ? undefined : nextToGenerate.renderError,
          promptAiModelUsed: isOllama ? requestedModel : data.promptAiModelUsed,
          isPromptModified: true, // Mark it so that "Gerar todos" transitions properly
        }, true);

        if (shouldQueueImage) {
          setNotification("✓ Prompt gerado com sucesso! Enfileirando imagem para criação.");
        } else {
          setNotification("✓ Prompt gerado com sucesso!");
        }
      } catch (err: any) {
        console.error(`Prompt queue generator fail for ${nextToGenerate.id}:`, err);
        const errMsg = err.message || String(err);
        handleUpdateScene(nextToGenerate.id, {
          promptQueueStatus: "failed",
          promptError: errMsg,
          generateImageAfterPrompt: undefined
        });
        const sceneIndex = scenes.findIndex((s) => s.id === nextToGenerate.id);
        setError(`Erro ao gerar prompt da cena #${sceneIndex !== -1 ? sceneIndex + 1 : "?"}: ${errMsg}`);
      } finally {
        activePromptIdRef.current = null;
        setActivePromptId(null);
      }
    };

    runGeneratePrompt();
  }, [scenes, customApiKey, stylePreference, openAiKey, openAiModel, useOpenAiForPrompts, activePromptId]);

  // Cancel prompt generation queue status of a specific scene
  const handleCancelPromptQueue = (sceneId: string) => {
    if (activePromptIdRef.current === sceneId || activePromptId === sceneId) {
      activePromptIdRef.current = null;
      setActivePromptId(null);
    }
    
    setScenes((prev) =>
      prev.map((s) => {
        if (s.id === sceneId) {
          return {
            ...s,
            promptQueueStatus: undefined
          };
        }
        return s;
      })
    );
    setNotification("✓ Fila de prompt cancelada para a cena.");
  };

  useEffect(() => {
    // If we're already rendering something according to our ref, do not start another one!
    if (activeRenderIdRef.current) return;

    // Find first scene queued
    const nextToRender = scenes.find((s) => s.renderStatus === "queued");
    if (!nextToRender) return;

    // Set as active in both ref and state immediately
    activeRenderIdRef.current = nextToRender.id;
    setActiveRenderId(nextToRender.id);

    // Update status to "rendering"
    handleUpdateScene(nextToRender.id, { renderStatus: "rendering", renderError: undefined });

    const runRender = async () => {
      try {
        const response = await fetch("/api/storyboard/generate-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(customApiKey ? { "x-gemini-key": customApiKey } : {}),
            ...(openAiKey ? {
              "x-openai-key": openAiKey,
              "x-openai-dalle-model": openAiDalleModel
            } : {})
          },
          body: JSON.stringify({
            prompt: nextToRender.prompt,
            model: nextToRender.selectedModel || "nano_banana",
            visualInstructionImage: nextToRender.visualInstructionImage,
            customApiKey
          })
        });

        const text = await response.text();
        let data: any;
        try {
          data = JSON.parse(text);
        } catch (err) {
          if (!response.ok) {
            let htmlTitle = "";
            if (text.includes("<title>")) {
              const match = text.match(/<title>([\s\S]*?)<\/title>/i);
              if (match && match[1]) htmlTitle = `: ${match[1].trim()}`;
            }
            throw new Error(`Erro de rede (Status: ${response.status}${htmlTitle})`);
          }
          throw new Error("Resposta de renderização inválida.");
        }

        if (!response.ok) {
          throw new Error(data.error || "Erro de processamento.");
        }

        // Salva a imagem fisicamente no diretório do projeto no servidor em segundo plano
        const base64ImageUrl = data.imageUrl;
        let serverDiskUrl = "";
        try {
          const imgSaveRes = await fetch("/api/storyboard/projects/save-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folder: projectFolder,
              sceneId: nextToRender.id,
              sceneNumber: nextToRender.sceneNumber || "",
              imageUrl: base64ImageUrl
            })
          });
          if (imgSaveRes.ok) {
            const imgSaveData = await imgSaveRes.json();
            if (imgSaveData.success && imgSaveData.url) {
              serverDiskUrl = imgSaveData.url;
            }
          }
        } catch (imgErr) {
          console.warn("Erro ao salvar imagem fisicamente:", imgErr);
        }

        // Apply completed image instantly using base64 URL for 0ms rendering and zero black frames
        handleUpdateScene(nextToRender.id, {
          generatedImageUrl: base64ImageUrl || serverDiskUrl,
          selectedModel: nextToRender.selectedModel || "nano_banana",
          engineName: data.metadata?.engineName || "Nano Banana",
          renderTimeSeconds: data.metadata?.renderTimeSeconds,
          renderStatus: "completed",
          renderError: !data.isAiGenerated ? (data.generationError || "Rascunho de Diretriz Visual") : undefined,
          isPromptModified: false
        }, true);
      } catch (err: any) {
        console.error(`Render fail for ${nextToRender.id}:`, err);
        handleUpdateScene(nextToRender.id, {
          renderStatus: "failed",
          renderError: err.message || "Erro de conexão ao servidor."
        });
      } finally {
        activeRenderIdRef.current = null;
        setActiveRenderId(null);
      }
    };

    runRender();
  }, [scenes, customApiKey, openAiKey, openAiDalleModel, projectFolder, activeRenderId]);

  // Self-healing effect for orphaned queue states ("generating" or "rendering" but no active process lock)
  useEffect(() => {
    const orphanedGenerating = scenes.filter(s => s.promptQueueStatus === "generating" && s.id !== activePromptIdRef.current);
    const orphanedRendering = scenes.filter(s => s.renderStatus === "rendering" && s.id !== activeRenderIdRef.current);

    if (orphanedGenerating.length > 0 || orphanedRendering.length > 0) {
      setScenes((prev) =>
        prev.map((s) => {
          let updated = { ...s };
          if (s.promptQueueStatus === "generating" && s.id !== activePromptIdRef.current) {
            // Reset to queued so the active queue can pick it up and process it properly
            updated.promptQueueStatus = "queued";
          }
          if (s.renderStatus === "rendering" && s.id !== activeRenderIdRef.current) {
            // Reset to queued so the active queue can pick it up and process it properly
            updated.renderStatus = "queued";
          }
          return updated;
        })
      );
    }
  }, [scenes, activePromptId, activeRenderId]);

  // Cancel the rendering or queued status of a specific scene, unlocking the slot instantly
  const handleCancelRender = (sceneId: string) => {
    // If it's the currently active render, clear the active lock so the next ones can run
    if (activeRenderIdRef.current === sceneId || activeRenderId === sceneId) {
      activeRenderIdRef.current = null;
      setActiveRenderId(null);
    }
    
    setScenes((prev) =>
      prev.map((s) => {
        if (s.id === sceneId) {
          return {
            ...s,
            renderStatus: "idle",
            renderError: "Cancelado pelo usuário"
          };
        }
        return s;
      })
    );
    
    setNotification("✓ Geração de imagem cancelada. A cena foi destravada!");
  };

  // Add all scenes without images to the render queue with optional explicit image model selection
  const handleQueueAllPendingImages = (selectedModel?: string) => {
    const pendingCount = scenes.filter(s => !s.generatedImageUrl).length;
    if (pendingCount === 0) {
      setNotification("Todas as cenas já possuem imagens geradas.");
      return;
    }
    pushToHistory();
    setScenes((prev) =>
      prev.map((s) => {
        if (!s.generatedImageUrl) {
          return { 
            ...s, 
            renderStatus: "queued", 
            renderError: undefined,
            ...(selectedModel ? { selectedModel: selectedModel, promptTargetTool: selectedModel } : {})
          };
        }
        return s;
      })
    );
    setNotification(`${pendingCount} cenas sem imagem foram adicionadas à fila de renderização${selectedModel ? ` (Modelo: ${selectedModel})` : ""}!`);
  };

  // Generate prompts for empty scenes AND auto-queue images once prompts complete
  const handleGenerateAllEmptyPromptsAndImages = () => {
    pushToHistory();
    setScenes((prev) =>
      prev.map((s) => {
        const needsPrompt = !s.prompt || s.prompt.trim() === "" || s.prompt.includes("Aguardando") || s.description.includes("Aguardando");
        const needsImage = !s.generatedImageUrl;

        if (needsPrompt) {
          return {
            ...s,
            promptQueueStatus: "queued",
            generateImageAfterPrompt: true,
            renderStatus: needsImage ? "queued" : s.renderStatus
          };
        } else if (needsImage) {
          return {
            ...s,
            renderStatus: "queued",
            renderError: undefined
          };
        }
        return s;
      })
    );
    setNotification("✓ Prompts + Imagens enfileirados para todas as cenas vazias!");
    setShowQueuePanel(true);
  };

  // Generate prompts ONLY for empty/placeholder scenes (without generating images)
  const handleGenerateAllEmptyPromptsOnly = () => {
    pushToHistory();
    let count = 0;
    setScenes((prev) =>
      prev.map((s) => {
        const isPlaceholderPrompt = !s.prompt || 
          s.prompt.trim() === "" || 
          s.prompt.includes("Aguardando") || 
          s.prompt.includes("Cinematic landscape or scenery:") ||
          s.description.includes("Aguardando") ||
          s.description.includes("Cena extraída da narração em áudio");

        if (isPlaceholderPrompt) {
          count++;
          return {
            ...s,
            promptQueueStatus: "queued",
            generateImageAfterPrompt: false
          };
        }
        return s;
      })
    );
    setNotification(`✓ Direção de Arte (Prompts) enfileirada para ${count} cenas!`);
    setShowQueuePanel(true);
  };

  // Add all modified scenes or scenes needing rerun to the render queue
  const handleQueueAllModifiedImages = () => {
    pushToHistory();

    // Check for ungenerated prompts (typically after a scene split or empty manual transition frames)
    const ungeneratedScenes = scenes.filter(s => 
      !s.prompt || 
      s.prompt.trim() === "" || 
      s.prompt.includes("Aguardando") || 
      s.description.includes("Aguardando")
    );

    if (ungeneratedScenes.length > 0) {
      setScenes((prev) =>
        prev.map((s) => {
          const isUngenerated = !s.prompt || 
            s.prompt.trim() === "" || 
            s.prompt.includes("Aguardando") || 
            s.description.includes("Aguardando");
          if (isUngenerated) {
            return { ...s, promptQueueStatus: "queued" };
          }
          return s;
        })
      );
      setNotification(`${ungeneratedScenes.length} prompts aguardando geração foram adicionados à fila!`);
      setShowQueuePanel(true);
      return;
    }

    const modifiedCount = scenes.filter(s => s.isPromptModified).length;
    if (modifiedCount === 0) {
      // Fallback: if none are marked modified but user clicked, ask to render everything or do all
      setScenes((prev) =>
        prev.map((s) => ({ ...s, renderStatus: "queued", renderError: undefined }))
      );
      setNotification(`Todos os ${scenes.length} quadros foram adicionados à fila para regeração total!`);
      setShowQueuePanel(true);
      return;
    }
    setScenes((prev) =>
      prev.map((s) => {
        if (s.isPromptModified) {
          return { ...s, renderStatus: "queued", renderError: undefined };
        }
        return s;
      })
    );
    setNotification(`${modifiedCount} cenas modificadas foram adicionadas à fila de renderização de imagem!`);
    setShowQueuePanel(true);
  };

  const getNextSceneNumber = (currentNum: string): string => {
    if (!currentNum) return "1";
    const match = currentNum.match(/^(.*?)(\d+)$/);
    if (match) {
      const prefix = match[1];
      const num = parseInt(match[2], 10);
      return `${prefix}${num + 1}`;
    }
    return currentNum + "-next";
  };

  // Split scene at index into two rows with the provided split text
  const handleSplitScene = (index: number, part1: string, part2: string) => {
    pushToHistory();
    const originalScene = scenes[index];
    const parentNum = originalScene.sceneNumber || String(index + 1);
    const isLastScene = index === scenes.length - 1;

    let scene1Num = "";
    let scene2Num = "";

    const naturalNext = getNextSceneNumber(parentNum);
    const subsequentScene = !isLastScene ? scenes[index + 1] : null;
    const hasConflict = subsequentScene && subsequentScene.sceneNumber === naturalNext;

    if (hasConflict) {
      scene1Num = `${parentNum}-1`;
      scene2Num = `${parentNum}-2`;
    } else {
      scene1Num = parentNum;
      scene2Num = naturalNext;
    }

    // Timecode split calculation
    const totalDuration = originalScene.duration || 3;
    const totalTextLength = (part1.length + part2.length) || 1;
    const ratio1 = Math.max(0.2, Math.min(0.8, part1.length / totalTextLength));
    
    let splitTime = originalScene.startTime !== undefined
      ? Number((originalScene.startTime + totalDuration * ratio1).toFixed(2))
      : undefined;

    if (originalScene.timedWords && originalScene.timedWords.length > 0) {
      const part1Words = part1.trim().split(/\s+/).filter(Boolean);
      if (part1Words.length > 0 && part1Words.length < originalScene.timedWords.length) {
        const lastWordOfPart1 = originalScene.timedWords[part1Words.length - 1];
        if (lastWordOfPart1) {
          splitTime = Number(lastWordOfPart1.end.toFixed(2));
        }
      }
    }

    const startWIdx = originalScene.wordStartIndex;
    const endWIdx = originalScene.wordEndIndex;
    let splitWIdx: number | undefined = undefined;

    if (startWIdx !== undefined && endWIdx !== undefined && endWIdx >= startWIdx) {
      const totalWords = endWIdx - startWIdx + 1;
      const part1WordCount = Math.max(1, Math.min(totalWords - 1, Math.round(totalWords * ratio1)));
      splitWIdx = startWIdx + part1WordCount - 1;
    }
    
    const newScene1: StoryboardScene = {
      id: `scene-split-${Date.now()}-1`,
      text: part1,
      description: originalScene.description ? `(Parte 1) ${originalScene.description}` : "Diretrizes visuais para a primeira parte do split.",
      prompt: originalScene.prompt || "",
      sceneNumber: scene1Num,
      generationGuidelines: originalScene.generationGuidelines || "",
      sceneStylePreference: originalScene.sceneStylePreference || "auto",
      promptAiModel: originalScene.promptAiModel || "gemini-3.5-flash",
      promptTargetTool: originalScene.promptTargetTool || "Nano Banana",
      generatedImageUrl: originalScene.generatedImageUrl,
      imageVersions: originalScene.imageVersions || [],
      renderStatus: originalScene.renderStatus || "idle",
      renderError: originalScene.renderError,
      selectedModel: originalScene.selectedModel,
      engineName: originalScene.engineName,
      renderTimeSeconds: originalScene.renderTimeSeconds,
      isPromptModified: originalScene.isPromptModified,
      chatHistory: originalScene.chatHistory || [],
      startTime: originalScene.startTime,
      endTime: splitTime,
      duration: (originalScene.startTime !== undefined && splitTime !== undefined)
        ? Math.max(0.5, Number((splitTime - originalScene.startTime).toFixed(2)))
        : undefined,
      wordStartIndex: startWIdx,
      wordEndIndex: splitWIdx ?? endWIdx,
      timedWords: originalScene.timedWords ? originalScene.timedWords.slice(0, Math.ceil(originalScene.timedWords.length * ratio1)) : undefined
    };

    const newScene2: StoryboardScene = {
      id: `scene-split-${Date.now()}-2`,
      text: part2,
      description: "Aguardando nova composição da segunda parte. Use 'Regerar' para acionar o diretor AI.",
      prompt: "Aguardando novo prompt de imagem para a cena dividida...",
      sceneNumber: scene2Num,
      generationGuidelines: originalScene.generationGuidelines || "",
      sceneStylePreference: originalScene.sceneStylePreference || "auto",
      promptAiModel: originalScene.promptAiModel || "gemini-3.5-flash",
      promptTargetTool: originalScene.promptTargetTool || "Nano Banana",
      startTime: splitTime,
      endTime: originalScene.endTime,
      duration: (splitTime !== undefined && originalScene.endTime !== undefined)
        ? Math.max(0.5, Number((originalScene.endTime - splitTime).toFixed(2)))
        : undefined,
      wordStartIndex: splitWIdx !== undefined ? splitWIdx + 1 : startWIdx,
      wordEndIndex: endWIdx,
      timedWords: originalScene.timedWords ? originalScene.timedWords.slice(Math.ceil(originalScene.timedWords.length * ratio1)) : undefined
    };

    const updated = [...scenes];
    updated.splice(index, 1, newScene1, newScene2);
    setScenes(updated);
    setFocusedSceneId(newScene2.id); // Preserve focus to newly split block
    setTimeout(() => triggerAutosave(updated), 0);
    setNotification(`Cena dividida com êxito em dois quadros (${scene1Num} e ${scene2Num}).`);
  };

  // Merge scene at index with the scene right below it (index + 1)
  const handleMergeScene = (index: number) => {
    if (index < 0 || index >= scenes.length - 1) return;
    pushToHistory();
    const current = scenes[index];
    const next = scenes[index + 1];

    const mergedText = `${current.text} ${next.text}`.trim();
    const mergedDescription = `Cena unificada. Comp: ${current.description} Seguido por: ${next.description}`;
    const mergedPrompt = current.prompt || next.prompt; // Keep current first as core directive

    const num1 = current.sceneNumber || String(index + 1);
    const num2 = next.sceneNumber || String(index + 2);

    const start = current.startTime;
    const end = next.endTime ?? (next.startTime !== undefined ? next.startTime + (next.duration || 3) : undefined);
    const duration = (start !== undefined && end !== undefined) ? Math.max(0.5, Number((end - start).toFixed(2))) : undefined;

    const mergedScene: StoryboardScene = {
      id: `scene-merge-${Date.now()}`,
      text: mergedText,
      description: mergedDescription,
      prompt: mergedPrompt,
      sceneNumber: num1,
      startTime: start,
      endTime: end,
      duration: duration,
      wordStartIndex: current.wordStartIndex ?? next.wordStartIndex,
      wordEndIndex: next.wordEndIndex ?? current.wordEndIndex,
      timedWords: [
        ...(current.timedWords || []),
        ...(next.timedWords || [])
      ]
    };

    const updated = [...scenes];
    updated.splice(index, 2, mergedScene);
    setScenes(updated);
    setFocusedSceneId(mergedScene.id); // Preserve focus to newly merged block
    setTimeout(() => triggerAutosave(updated), 0);
    setNotification(`Cenas #${num1} e #${num2} fundidas em um único quadro.`);
  };

  // Delete scene
  const handleDeleteScene = (index: number) => {
    pushToHistory();
    const updated = scenes.filter((_, idx) => idx !== index);
    setScenes(updated);
    const adjacentScene = updated[Math.min(index, updated.length - 1)];
    if (adjacentScene) {
      setFocusedSceneId(adjacentScene.id); // Preserve focus to adjacent block
    } else {
      setFocusedSceneId(null);
    }
    setTimeout(() => triggerAutosave(updated), 0);
    setNotification("Segmento de cena excluído do rascunho de gravação.");
  };

  // Move scene upward
  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    pushToHistory();
    const updated = [...scenes];
    const temp = updated[index];
    updated[index] = updated[index - 1];
    updated[index - 1] = temp;
    setScenes(updated);
    setTimeout(() => triggerAutosave(updated), 0);
  };

  // Move scene downward
  const handleMoveDown = (index: number) => {
    if (index === scenes.length - 1) return;
    pushToHistory();
    const updated = [...scenes];
    const temp = updated[index];
    updated[index] = updated[index + 1];
    updated[index + 1] = temp;
    setScenes(updated);
    setTimeout(() => triggerAutosave(updated), 0);
  };

  // Add a blank new scene manually at the bottom
  const handleAddBlankScene = () => {
    pushToHistory();
    const newScene: StoryboardScene = {
      id: `scene-manual-${Date.now()}`,
      text: "Novo segmento de narração ou reflexão para desenvolvimento.",
      description: "Nova sugestão de enquadramento de câmera e iluminação dramática.",
      prompt: "Dramatic cinematography setting, evocative mood, high contrast lighting --ar 16:9",
      sceneNumber: String(scenes.length + 1),
    };
    const updated = [...scenes, newScene];
    setScenes(updated);
    setFocusedSceneId(newScene.id); // Focus new scene
    setTimeout(() => triggerAutosave(updated), 0);
    setNotification("Quadro de cena adicional inserido temporariamente.");
  };

  // Export fully designed storyboard sequence to a pristine human-readable CSV formatted file
  const handleExportToCSV = () => {
    if (scenes.length === 0) return;

    const headers = ["Sequencia", "Narracao", "Direcao de Arte (Visual)", "Prompt de Imagem (English)", "Aspecto"];
    
    const rows = scenes.map((s, idx) => {
      // Escape inner quotes inside cells for perfect CSV compliance
      const cleanText = s.text.replace(/"/g, '""');
      const cleanDesc = s.description.replace(/"/g, '""');
      const cleanPrompt = s.prompt.replace(/"/g, '""');
      return [
        `Cena ${idx + 1}`,
        `"${cleanText}"`,
        `"${cleanDesc}"`,
        `"${cleanPrompt}"`,
        "16:9"
      ];
    });

    // Construct perfect CSV payload with UTF-8 byte order mark to display Portuguese characters flawlessly in Excel
    const csvContent = "\uFEFF" + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "storyboard-ethos-meditativo.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setNotification("CSV de filmagem exportado com sucesso!");
  };

  // Export only the prompts to a single plain text file, one prompt per line, consecutive
  const handleExportToTXT = () => {
    if (scenes.length === 0) return;

    const list = scenes
      .map((s) => s.prompt.trim())
      .filter(Boolean);

    if (list.length === 0) {
      setNotification("Nenhum prompt disponível para exportar no momento.");
      return;
    }

    const txtContent = list.join("\n");
    const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "storyboard_prompts.txt");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setNotification("Arquivo de texto dos prompts exportado com sucesso!");
  };

  // Handle project creation with audio narration
  const handleGenerateStoryboardWithAudio = async (params: {
    text: string;
    style: StylePreference;
    referenceImage?: string;
    selectedEngine?: "gemini" | "openai" | "ollama";
    audioFile?: File | null;
    audioBase64?: string;
    audioMimeType?: string;
    audioFileName?: string;
    explicitProjectName?: string;
  }) => {
    const { text, style, referenceImage, selectedEngine, audioFile, audioBase64, audioMimeType, explicitProjectName } = params;

    if (!audioFile && !audioBase64) {
      handleGenerateStoryboard(text, style, referenceImage, selectedEngine);
      return;
    }

    setIsGenerating(true);
    setNotification("🎙️ Enviando e transcrevendo áudio da narração via IA...");

    try {
      const activeProjectName = explicitProjectName || projectName || "meu-projeto";
      let response: Response;

      if (audioFile) {
        const formData = new FormData();
        formData.append("audio", audioFile);
        formData.append("projectName", activeProjectName);

        response = await fetch("/api/storyboard/transcribe-audio", {
          method: "POST",
          headers: {
            ...(customApiKey ? { "x-gemini-key": customApiKey } : {})
          },
          body: formData
        });
      } else {
        response = await fetch("/api/storyboard/transcribe-audio", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(customApiKey ? { "x-gemini-key": customApiKey } : {})
          },
          body: JSON.stringify({
            audioBase64,
            audioMimeType,
            projectName: activeProjectName
          })
        });
      }

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Falha ao processar o áudio.");
      }

      const audioData = await response.json();
      if (audioData.audioUrl) {
        setAudioNarrationUrl(audioData.audioUrl);
      }

      const scriptToUse = (text && text.trim()) || audioData.fullScript || (audioData.scenes || []).map((s: any) => s.text).join("\n\n") || "Narração em áudio importada.";
      setScriptText(scriptToUse);

      let createdScenes: StoryboardScene[] = [];

      // If text script was empty or if audio transcription produced scenes natively
      if (!text && audioData.scenes && Array.isArray(audioData.scenes) && audioData.scenes.length > 0) {
        createdScenes = audioData.scenes.map((s: any, idx: number) => ({
          id: `scene-audio-${Date.now()}-${idx}`,
          text: s.text || "",
          description: "Cena extraída da narração em áudio.",
          prompt: `Cinematic landscape or scenery: ${s.text || "narration"}, 16:9 aspect ratio`,
          sceneNumber: String(idx + 1),
          startTime: s.startTime,
          endTime: s.endTime,
          duration: s.endTime - s.startTime,
          promptQueueStatus: "idle"
        }));
      } else {
        // Generate scenes via text engine
        createdScenes = await handleGenerateStoryboard(scriptToUse, style, referenceImage, selectedEngine) || [];
      }

      // Robust fallback: if createdScenes is empty, split scriptToUse into scenes locally
      if (!createdScenes || createdScenes.length === 0) {
        const sentences = scriptToUse.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 0);
        const segments = sentences.length > 0 ? sentences : [scriptToUse];
        createdScenes = segments.map((segText, idx) => ({
          id: `scene-audio-${Date.now()}-${idx}`,
          text: segText,
          description: "Cena extraída da narração em áudio.",
          prompt: `Cinematic landscape or scenery: ${segText}, 16:9 aspect ratio`,
          sceneNumber: String(idx + 1),
          promptQueueStatus: "idle"
        }));
      }

      // Align timecodes safely in memory
      if (audioData.timedWords && Array.isArray(createdScenes) && createdScenes.length > 0) {
        const aligned = alignAudioToExistingScenes(createdScenes, audioData.timedWords);
        setScenes(aligned);
        setNotification("✓ Narração transcrevida e timecodes sincronizados com sucesso!");
      } else if (Array.isArray(createdScenes) && createdScenes.length > 0) {
        setScenes(createdScenes);
        setNotification("✓ Narração transcrevida com sucesso!");
      }
      setActiveView("storyboard");
    } catch (err: any) {
      console.error("Audio generation fail:", err);
      setError(`Erro na transcrição do áudio: ${err.message || err}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle mid-project audio upload & alignment
  const handleMidProjectAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];

    setNotification(`🎙️ Enviando áudio "${file.name}" para alinhamento de timecodes...`);

    try {
      const formData = new FormData();
      formData.append("audio", file);
      formData.append("projectName", projectName || "meu-projeto");

      const response = await fetch("/api/storyboard/transcribe-audio", {
        method: "POST",
        headers: {
          ...(customApiKey ? { "x-gemini-key": customApiKey } : {})
        },
        body: formData
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Falha ao processar áudio.");
      }

      const data = await response.json();
      if (data.audioUrl) setAudioNarrationUrl(data.audioUrl);

      if (data.timedWords && scenes.length > 0) {
        const alignedScenes = alignAudioToExistingScenes(scenes, data.timedWords);
        setScenes(alignedScenes);
        setNotification("✓ Narração em áudio alinhada com sucesso! Timecodes gerados para todas as cenas.");
      } else {
        setNotification("✓ Arquivo de áudio anexado ao projeto.");
      }
    } catch (err: any) {
      console.error("Mid-project audio fail:", err);
      setError(`Erro ao alinhar áudio: ${err.message || err}`);
    }
  };

  // Re-sync all current scene timecodes with audio narration using N-Gram matcher
  const handleResyncCurrentProjectAudio = async () => {
    if (!scenes || scenes.length === 0) {
      setNotification("Nenhuma cena disponível para re-sincronizar.");
      return;
    }
    setIsGenerating(true);
    setNotification("🎙️ Re-processando áudio do projeto e calculando timecodes N-Gram de 8 palavras...");

    try {
      const cleanedScenes = scenes.map(s => ({
        ...s,
        wordStartIndex: undefined,
        wordEndIndex: undefined,
        startTime: undefined,
        endTime: undefined
      }));

      const projName = projectName || "meu-projeto";
      const formData = new FormData();
      formData.append("projectName", projName);

      // 1. Check if audioNarrationUrl is available in memory or localStorage
      const currentAudioUrl = audioNarrationUrl || localStorage.getItem(`ethos_storyboard_audio_url_${projName}`) || localStorage.getItem("ethos_storyboard_audio_url");

      if (currentAudioUrl) {
        if (currentAudioUrl.startsWith("data:audio")) {
          try {
            const parts = currentAudioUrl.split(",");
            const mimeMatch = parts[0].match(/:(.*?);/);
            const mime = mimeMatch ? mimeMatch[1] : "audio/wav";
            const bstr = atob(parts[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) {
              u8arr[n] = bstr.charCodeAt(n);
            }
            const audioBlob = new Blob([u8arr], { type: mime });
            formData.append("audio", audioBlob, "narration.wav");
          } catch (e) {
            console.warn("Failed to parse data URL audio blob:", e);
          }
        } else if (currentAudioUrl.startsWith("blob:") || currentAudioUrl.startsWith("/api/projects")) {
          try {
            const blobRes = await fetch(currentAudioUrl);
            if (blobRes.ok) {
              const audioBlob = await blobRes.blob();
              formData.append("audio", audioBlob, "narration.wav");
            }
          } catch (blobErr) {
            console.warn("Failed to fetch audio blob for re-sync:", blobErr);
          }
        }
      }

      // 2. Stream FormData to transcribe-audio endpoint
      const response = await fetch(`/api/storyboard/transcribe-audio`, {
        method: "POST",
        headers: { ...(customApiKey ? { "x-gemini-key": customApiKey } : {}) },
        body: formData
      });

      if (response.ok) {
        const audioData = await response.json();
        if (audioData.audioUrl) {
          setAudioNarrationUrl(audioData.audioUrl);
          localStorage.setItem(`ethos_storyboard_audio_url_${projName}`, audioData.audioUrl);
        }
        if (audioData.timedWords && Array.isArray(audioData.timedWords) && audioData.timedWords.length > 0) {
          const aligned = alignAudioToExistingScenes(cleanedScenes, audioData.timedWords);
          setScenes(aligned);
          setTimeout(() => triggerAutosave(aligned), 0);
          setNotification("✓ Todos os timecodes do projeto foram re-sincronizados com 100% de precisão e salvos!");
          return;
        }
      }

      // Fallback: organize scenes sequentially if no audio transcription returned
      const fallbackAligned = alignAudioToExistingScenes(cleanedScenes, []);
      setScenes(fallbackAligned);
      setTimeout(() => triggerAutosave(fallbackAligned), 0);
      setNotification("✓ Timecodes organizados em sequência com sucesso!");
    } catch (err: any) {
      console.warn("Re-sync audio failed:", err);
      const cleanedScenes = scenes.map(s => ({
        ...s,
        wordStartIndex: undefined,
        wordEndIndex: undefined,
        startTime: undefined,
        endTime: undefined
      }));
      const fallbackAligned = alignAudioToExistingScenes(cleanedScenes, []);
      setScenes(fallbackAligned);
      setTimeout(() => triggerAutosave(fallbackAligned), 0);
      setNotification("✓ Timecodes re-organizados em sequência!");
    } finally {
      setIsGenerating(false);
    }
  };

  // Export FCPXML / Premiere XML
  const handleExportXML = () => {
    if (scenes.length === 0) return;
    const projName = projectName || "meu-projeto";
    const xmlStr = generateFCPXML(scenes, "narration.mp3", 24, projName);
    const blob = new Blob([xmlStr], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projName.replace(/\s+/g, "_")}_timeline.xml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setNotification("✓ Timeline XML (Premiere / DaVinci) exportada com sucesso!");
  };

  // Export CMX 3600 EDL
  const handleExportEDL = () => {
    if (scenes.length === 0) return;
    const projName = projectName || "meu-projeto";
    const edlStr = generateEDL(scenes, "narration.mp3", 24, projName);
    const blob = new Blob([edlStr], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projName.replace(/\s+/g, "_")}_timeline.edl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setNotification("✓ Timeline EDL exportada com sucesso!");
  };

  // Export full project file (.dmaker) containing all text, state, prompts, and generated base64/remote images in a zip package
  const handleSaveProject = async () => {
    if (scenes.length === 0) return;
    setIsExporting(true);
    
    if (exportModeOption === "lightweight") {
      setNotification("Empacotando metadados do projeto (Opção B - Ultraleve)...");
    } else {
      setNotification("Empacotando projeto e baixando imagens... Por favor, aguarde.");
    }
    
    try {
      const zip = new JSZip();
      let exportedScenes = [];
      let exportedArchive = [];

      if (exportModeOption === "lightweight") {
        // Opção B: Save only metadata. Keep base64 images as idb:// keys, or keep remote URLs as they are.
        exportedScenes = scenes.map((s) => {
          const clonedScene = { ...s };
          if (clonedScene.generatedImageUrl && clonedScene.generatedImageUrl.startsWith("data:")) {
            clonedScene.generatedImageUrl = `idb://img_scene_${s.id}_active`;
          }
          if (clonedScene.imageVersions && clonedScene.imageVersions.length > 0) {
            clonedScene.imageVersions = clonedScene.imageVersions.map((v) => {
              const clonedV = { ...v };
              if (clonedV.url && clonedV.url.startsWith("data:")) {
                clonedV.url = `idb://img_version_${v.id}`;
              }
              return clonedV;
            });
          }
          return clonedScene;
        });

        exportedArchive = sessionImageArchive.map((item) => {
          const clonedItem = { ...item };
          if (clonedItem.url && clonedItem.url.startsWith("data:")) {
            clonedItem.url = `idb://img_archive_${item.id}`;
          }
          return clonedItem;
        });

      } else {
        // Opção A: Full package containing all image binaries embedded in the Zip.
        exportedScenes = await Promise.all(scenes.map(async (s) => {
          const clonedScene = { ...s };
          
          // 1. Pack the active generated image if any
          if (s.generatedImageUrl) {
            const blob = await fetchImageAsBlob(s.generatedImageUrl);
            if (blob) {
              const fileName = `images/${s.id}_active.png`;
              zip.file(fileName, blob);
              clonedScene.generatedImageUrl = fileName;
            }
          }
          
          // 2. Pack the versions of the image
          if (s.imageVersions && s.imageVersions.length > 0) {
            clonedScene.imageVersions = await Promise.all(s.imageVersions.map(async (v) => {
              const clonedVersion = { ...v };
              if (v.url) {
                const blob = await fetchImageAsBlob(v.url);
                if (blob) {
                  const fileName = `images/${s.id}_version_${v.id}.png`;
                  zip.file(fileName, blob);
                  clonedVersion.url = fileName;
                }
              }
              return clonedVersion;
            }));
          }
          
          return clonedScene;
        }));

        // 3. Pack the archived session images
        exportedArchive = await Promise.all(sessionImageArchive.map(async (item) => {
          const clonedItem = { ...item };
          if (item.url) {
            const blob = await fetchImageAsBlob(item.url);
            if (blob) {
              const fileName = `images/archive_${item.id}.png`;
              zip.file(fileName, blob);
              clonedItem.url = fileName;
            }
          }
          return clonedItem;
        }));
      }

      const projectData = {
        version: "1.1",
        appName: "DiárioMaker",
        projectName,
        diaryDate,
        saveVersion,
        timestamp: new Date().toISOString(),
        scenes: exportedScenes,
        sessionImageArchive: exportedArchive,
        scriptText,
        selectedStyle,
        stylePreference,
        isLightweight: exportModeOption === "lightweight"
      };

      zip.file("project.json", JSON.stringify(projectData, null, 2));

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      
      const link = document.createElement("a");
      link.href = url;
      
      // Helper to format YYYY-MM-DD into AAMMDD
      const formatDiaryDate = (dateStr: string): string => {
        if (!dateStr) return "";
        const parts = dateStr.split("-");
        if (parts.length === 3) {
          const year = parts[0].slice(-2); // last 2 digits of YYYY
          const month = parts[1];
          const day = parts[2];
          return `${year}${month}${day}`;
        }
        return "";
      };

      // Compute download filename
      let downloadFilename = "";
      if (diaryDate) {
        const formattedDate = formatDiaryDate(diaryDate);
        const versionStr = String(saveVersion).padStart(2, "0");
        downloadFilename = `DEMB_${formattedDate}_V${versionStr}${exportModeOption === "lightweight" ? "-light" : ""}.dmaker`;
        
        // Auto increment save version for the NEXT save
        const nextVersion = saveVersion + 1;
        setSaveVersion(nextVersion);
        try {
          localStorage.setItem("ethos_storyboard_save_version", String(nextVersion));
        } catch (_) {}

        // Update the project name to reflect the next version
        const nextProjectName = `DEMB_${formattedDate}_V${String(nextVersion).padStart(2, "0")}`;
        setProjectName(nextProjectName);
        try {
          localStorage.setItem("ethos_storyboard_project_name", nextProjectName);
        } catch (_) {}
      } else {
        const safeProjectName = projectName.trim().toLowerCase().replace(/[^a-z0-9à-ú- ]/g, "").replace(/\s+/g, "-") || "meu-storyboard";
        downloadFilename = `${safeProjectName}${exportModeOption === "lightweight" ? "-light" : ""}.dmaker`;
      }
      
      link.download = downloadFilename;
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      if (exportModeOption === "lightweight") {
        setNotification(`✓ Metadados do projeto "${projectName}" salvos com sucesso (Ultraleve)!`);
      } else {
        setNotification(`✓ Projeto "${projectName}" exportado com sucesso (.dmaker completo)!`);
      }
    } catch (err: any) {
      console.error("Save project error:", err);
      setError(`Falha ao salvar o projeto: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Import full project file (.dmaker or older .json) and restore state instantly
  const handleLoadProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsImporting(true);
    setNotification("Carregando projeto... Por favor, aguarde.");
    
    try {
      const fileName = file.name;
      
      if (fileName.endsWith(".json")) {
        // Handle legacy raw json format
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const content = event.target?.result as string;
            const data = JSON.parse(content);
            
            if (!data || !Array.isArray(data.scenes)) {
              throw new Error("O arquivo não parece ser um projeto válido do DiárioMaker (campo 'scenes' ausente ou inválido).");
            }
            
            const rawScenes = data.scenes.map((scene: any) => {
              if (scene) {
                if (scene.generatedImageUrl && scene.generatedImageUrl.startsWith("images/")) {
                  scene.generatedImageUrl = `/projects/260802/imagens/${scene.generatedImageUrl.replace("images/", "")}`;
                }
                if (Array.isArray(scene.imageVersions)) {
                  scene.imageVersions = scene.imageVersions.map((v: any) => {
                    if (v && v.url && v.url.startsWith("images/")) {
                      v.url = `/projects/260802/imagens/${v.url.replace("images/", "")}`;
                    }
                    return v;
                  });
                }
              }
              return scene;
            });
            const rawArchive = (data.sessionImageArchive || []).map((item: any) => {
              if (item && item.url && item.url.startsWith("images/")) {
                item.url = `/projects/260802/imagens/${item.url.replace("images/", "")}`;
              }
              return item;
            });

            const hydratedScenes = await hydrateScenes(rawScenes);
            const hydratedArchive = await hydrateArchive(rawArchive);

            pushToHistory();
            setScenes(hydratedScenes);
            if (hydratedArchive.length > 0) {
              setSessionImageArchive(hydratedArchive);
            }
            if (data.projectName !== undefined) setProjectName(data.projectName);
            else {
              // Guess project name from file name
              const guessedName = fileName.replace(/\.json$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
              setProjectName(guessedName);
            }
            setProjectFolder("260802");
            if (data.scriptText !== undefined) setScriptText(data.scriptText);
            if (data.selectedStyle !== undefined) setSelectedStyle(data.selectedStyle);
            if (data.stylePreference !== undefined) setStylePreference(data.stylePreference);
            
            if (data.diaryDate !== undefined) {
              setDiaryDate(data.diaryDate);
              setLocalStorageItemSafely("ethos_storyboard_diary_date", data.diaryDate);
            } else {
              setDiaryDate("");
              localStorage.removeItem("ethos_storyboard_diary_date");
            }
            if (data.saveVersion !== undefined) {
              setSaveVersion(data.saveVersion);
              setLocalStorageItemSafely("ethos_storyboard_save_version", String(data.saveVersion));
            } else {
              setSaveVersion(1);
              setLocalStorageItemSafely("ethos_storyboard_save_version", "1");
            }
            
            // Sync with local storage immediately for auto-recovery safety
            setLocalStorageItemSafely("ethos_storyboard_scenes", JSON.stringify(hydratedScenes));
            if (hydratedArchive.length > 0) {
              setLocalStorageItemSafely("ethos_storyboard_image_archive", JSON.stringify(hydratedArchive));
            }
            if (data.scriptText !== undefined) setLocalStorageItemSafely("ethos_storyboard_script_text", data.scriptText);
            if (data.selectedStyle !== undefined) setLocalStorageItemSafely("ethos_storyboard_selected_style", data.selectedStyle);
            
            setNotification("✓ Projeto DiárioMaker legado carregado com sucesso!");
          } catch (err: any) {
            setError(`Erro ao carregar o arquivo do projeto legatário: ${err.message}`);
          } finally {
            setIsImporting(false);
          }
        };
        reader.readAsText(file);
      } else {
        // Load with JSZip for self-contained packages (.dmaker / .diariomaker / .zip)
        const zip = await JSZip.loadAsync(file);
        const jsonFile = zip.file("project.json");
        
        if (!jsonFile) {
          throw new Error("O pacote não contém o arquivo 'project.json' de definição do projeto.");
        }
        
        const jsonText = await jsonFile.async("text");
        const data = JSON.parse(jsonText);
        
        if (!data || !Array.isArray(data.scenes)) {
          throw new Error("O arquivo 'project.json' interno é inválido ou não possui o campo 'scenes'.");
        }
        
        // Unpack scenes and extract images back into Base64 URLs
        const unpackedScenes = await Promise.all(data.scenes.map(async (s: any) => {
          const clonedScene = { ...s };
          
          // Reset any transient queued/rendering statuses on import
          if (clonedScene.renderStatus === "queued" || clonedScene.renderStatus === "rendering") {
            clonedScene.renderStatus = clonedScene.generatedImageUrl ? "completed" : "idle";
          }
          
          // 1. Unpack active image
          if (clonedScene.generatedImageUrl && clonedScene.generatedImageUrl.startsWith("images/")) {
            const imgFile = zip.file(clonedScene.generatedImageUrl);
            if (imgFile) {
              const base64 = await imgFile.async("base64");
              clonedScene.generatedImageUrl = `data:image/png;base64,${base64}`;
            }
          }
          
          // 2. Unpack version list
          if (clonedScene.imageVersions && clonedScene.imageVersions.length > 0) {
            clonedScene.imageVersions = await Promise.all(clonedScene.imageVersions.map(async (v: any) => {
              const clonedVersion = { ...v };
              if (clonedVersion.url && clonedVersion.url.startsWith("images/")) {
                const imgFile = zip.file(clonedVersion.url);
                if (imgFile) {
                  const base64 = await imgFile.async("base64");
                  clonedVersion.url = `data:image/png;base64,${base64}`;
                }
              }
              return clonedVersion;
            }));
          }
          
          return clonedScene;
        }));

        // 3. Unpack archive images back into Base64 URLs
        let unpackedArchive: ArchivedImage[] = [];
        if (data.sessionImageArchive && Array.isArray(data.sessionImageArchive)) {
          unpackedArchive = await Promise.all(data.sessionImageArchive.map(async (item: any) => {
            const clonedItem = { ...item };
            if (clonedItem.url && clonedItem.url.startsWith("images/")) {
              const imgFile = zip.file(clonedItem.url);
              if (imgFile) {
                const base64 = await imgFile.async("base64");
                clonedItem.url = `data:image/png;base64,${base64}`;
              }
            }
            return clonedItem;
          }));
        } else {
          // Fallback: If no archive exists in the file (older version), build it from scenes
          unpackedScenes.forEach((s) => {
            if (s.generatedImageUrl) {
              unpackedArchive.push({
                id: `act-${s.id}`,
                url: s.generatedImageUrl,
                timestamp: new Date().toLocaleTimeString(),
                sceneId: s.id,
                originalSceneNumber: s.sceneNumber || "",
                prompt: s.prompt || "",
                text: s.text || "",
                model: s.selectedModel,
                engineName: s.engineName,
                renderTimeSeconds: s.renderTimeSeconds
              });
            }
            if (s.imageVersions) {
              s.imageVersions.forEach((v: any) => {
                if (v.url && !unpackedArchive.some(img => img.url === v.url)) {
                  unpackedArchive.push({
                    id: v.id,
                    url: v.url,
                    timestamp: v.timestamp || new Date().toLocaleTimeString(),
                    sceneId: s.id,
                    originalSceneNumber: s.sceneNumber || "",
                    prompt: v.prompt || s.prompt || "",
                    text: v.description || s.text || "",
                    model: v.model,
                    engineName: v.engineName,
                    renderTimeSeconds: v.renderTimeSeconds
                  });
                }
              });
            }
          });
        }
        
        const hydratedScenes = await hydrateScenes(unpackedScenes);
        const hydratedArchive = await hydrateArchive(unpackedArchive);

        pushToHistory();
        setScenes(hydratedScenes);
        setSessionImageArchive(hydratedArchive);
        if (data.projectName !== undefined) setProjectName(data.projectName);
        else {
          const guessedName = fileName.replace(/\.(dmaker|diariomaker|zip)$/i, "").replace(/[-_]+/g, " ");
          setProjectName(guessedName);
        }
        setProjectFolder("260802");
        if (data.scriptText !== undefined) setScriptText(data.scriptText);
        if (data.selectedStyle !== undefined) setSelectedStyle(data.selectedStyle);
        if (data.stylePreference !== undefined) setStylePreference(data.stylePreference);
        
        if (data.diaryDate !== undefined) {
          setDiaryDate(data.diaryDate);
          setLocalStorageItemSafely("ethos_storyboard_diary_date", data.diaryDate);
        } else {
          setDiaryDate("");
          localStorage.removeItem("ethos_storyboard_diary_date");
        }
        if (data.saveVersion !== undefined) {
          setSaveVersion(data.saveVersion);
          setLocalStorageItemSafely("ethos_storyboard_save_version", String(data.saveVersion));
        } else {
          setSaveVersion(1);
          setLocalStorageItemSafely("ethos_storyboard_save_version", "1");
        }
        
        // Sync with local storage immediately for auto-recovery safety
        setLocalStorageItemSafely("ethos_storyboard_scenes", JSON.stringify(hydratedScenes));
        setLocalStorageItemSafely("ethos_storyboard_image_archive", JSON.stringify(hydratedArchive));
        if (data.scriptText !== undefined) setLocalStorageItemSafely("ethos_storyboard_script_text", data.scriptText);
        if (data.selectedStyle !== undefined) setLocalStorageItemSafely("ethos_storyboard_selected_style", data.selectedStyle);
        
        setNotification(`✓ Projeto "${data.projectName || "Carregado"}" importado com sucesso com todas as fotos salvas!`);
        setIsImporting(false);
      }
    } catch (err: any) {
      console.error("Load project error:", err);
      setError(`Erro ao abrir o arquivo do projeto: ${err.message}`);
      setIsImporting(false);
    } finally {
      e.target.value = "";
    }
  };

  // Helper function to query all images (active, versioned, or archived) for a specific scene ID
  const getImagesForScene = (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return [];
    
    const archiveImages = sessionImageArchive.filter(item => item.sceneId === sceneId);
    
    // De-duplicate URLs
    const allUrls = new Set(archiveImages.map(item => item.url));
    const combined = [...archiveImages];
    
    if (scene.generatedImageUrl && !allUrls.has(scene.generatedImageUrl)) {
      const activeVersion = (scene.imageVersions || []).find(v => v.url === scene.generatedImageUrl);
      const activeLetter = activeVersion?.letter || "A";
      combined.unshift({
        id: `active-${sceneId}`,
        url: scene.generatedImageUrl,
        timestamp: new Date().toLocaleTimeString(),
        sceneId: sceneId,
        originalSceneNumber: scene.sceneNumber || "",
        prompt: scene.prompt || "",
        text: scene.text || "",
        model: scene.selectedModel,
        engineName: scene.engineName,
        renderTimeSeconds: scene.renderTimeSeconds,
        letter: activeLetter
      });
      allUrls.add(scene.generatedImageUrl);
    }
    
    if (scene.imageVersions) {
      scene.imageVersions.forEach((v) => {
        if (v.url && !allUrls.has(v.url)) {
          combined.push({
            id: v.id,
            url: v.url,
            timestamp: v.timestamp || new Date().toLocaleTimeString(),
            sceneId: sceneId,
            originalSceneNumber: scene.sceneNumber || "",
            prompt: v.prompt || scene.prompt || "",
            text: v.description || scene.text || "",
            model: v.model,
            engineName: v.engineName,
            renderTimeSeconds: v.renderTimeSeconds,
            letter: v.letter || "A"
          });
          allUrls.add(v.url);
        }
      });
    }
    
    return combined;
  };

  // Helper to query all discarded/orphan images that belong to deleted or merged scene IDs
  const getDiscardedImages = () => {
    const activeSceneIds = new Set(scenes.map(s => s.id));
    return sessionImageArchive.filter(item => !activeSceneIds.has(item.sceneId));
  };

  // Action: Set archived image as active generatedImageUrl in a scene
  const handleActivateArchiveImage = (sceneId: string, imageUrl: string, archivedItem: ArchivedImage) => {
    handleUpdateScene(sceneId, {
      generatedImageUrl: imageUrl,
      prompt: archivedItem.prompt,
      description: archivedItem.text,
      selectedModel: archivedItem.model as any,
      engineName: archivedItem.engineName,
      renderTimeSeconds: archivedItem.renderTimeSeconds
    });
    setNotification("✓ Imagem reativada com êxito como atual desta cena!");
  };

  // Action: Restore a discarded image and its narration text as a new scene
  const handleRestoreAsNewScene = (item: ArchivedImage) => {
    pushToHistory();
    const newScene: StoryboardScene = {
      id: `scene-restored-${Date.now()}`,
      text: item.text || "Segmento de narração recuperado do acervo.",
      description: "Cena restaurada da lixeira / galeria de descartadas.",
      prompt: item.prompt || "Cinematographic image of restored scene",
      sceneNumber: String(scenes.length + 1),
      generatedImageUrl: item.url,
      selectedModel: item.model as any,
      engineName: item.engineName || "Acervo",
      renderTimeSeconds: item.renderTimeSeconds,
      renderStatus: "completed"
    };
    setScenes((prev) => [...prev, newScene]);
    setNotification("✓ Cena e imagem descartadas foram restauradas com sucesso no fim do storyboard!");
  };

  // Action: Download single image from archive
  const handleDownloadArchiveImage = async (url: string, filename: string) => {
    try {
      const response = await fetch(url, { referrerPolicy: "no-referrer" });
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      // Fallback if fetch is blocked or CORS issue
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // Action: Permanently delete an image from the session archive and versions lists
  const handleDeleteArchiveImage = (url: string) => {
    pushToHistory();
    
    // 1. Remove from archive state
    setSessionImageArchive((prev) => prev.filter((item) => item.url !== url));
    
    // 2. Remove from scene imageVersions and reset generatedImageUrl if currently selected
    setScenes((prevScenes) =>
      prevScenes.map((s) => {
        let updatedVersions = (s.imageVersions || []).filter((v) => v.url !== url);
        let updatedUrl = s.generatedImageUrl;
        if (s.generatedImageUrl === url) {
          updatedUrl = updatedVersions.length > 0 ? updatedVersions[0].url : undefined;
        }
        return {
          ...s,
          generatedImageUrl: updatedUrl,
          imageVersions: updatedVersions
        };
      })
    );
    setNotification("✓ Imagem removida permanentemente do acervo.");
  };

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      // Detect if user is active in an input/textarea
      const activeEl = document.activeElement;
      const isInputActive = activeEl && (
        activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        (activeEl as HTMLElement).isContentEditable
      );

      // 1. Ctrl+Z (Undo) - Skip if typing in an input
      if (isCmdOrCtrl && e.key.toLowerCase() === "z" && !isShift) {
        if (isInputActive) return; // let browser handle input undo
        e.preventDefault();
        handleUndo();
      }

      // 2. Ctrl+Y (Redo) - Skip if typing in an input
      if (isCmdOrCtrl && e.key.toLowerCase() === "y") {
        if (isInputActive) return; // let browser handle input redo
        e.preventDefault();
        handleRedo();
      }

      // 3. Ctrl+Shift+Enter (Render active scene)
      if (isCmdOrCtrl && isShift && e.key === "Enter") {
        e.preventDefault();
        const activeId = activeStudioSceneId || focusedSceneId || (scenes.length > 0 ? scenes[0].id : null);
        if (activeId) {
          const activeScene = scenes.find(s => s.id === activeId);
          if (activeScene) {
            if (activeScene.renderStatus !== "queued" && activeScene.renderStatus !== "rendering") {
              handleUpdateScene(activeId, { renderStatus: "queued", renderError: undefined });
              const sceneIndex = scenes.findIndex(s => s.id === activeId);
              const displayNum = consecutiveNumbering 
                ? String(sceneIndex + 1).padStart(2, "0") 
                : (activeScene.sceneNumber || String(sceneIndex + 1));
              setNotification(`✓ Cena #${displayNum} adicionada à fila para renderização!`);
              setShowQueuePanel(true);
            } else {
              setNotification(`⚠ Cena já está na fila ou sendo renderizada.`);
            }
          }
        } else {
          setNotification("⚠ Nenhuma cena ativa ou selecionada para renderizar.");
        }
      }

      // 4. Ctrl+Shift+S (Save project)
      if (isCmdOrCtrl && isShift && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveProject();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [scenes, history, redoStack, activeStudioSceneId, focusedSceneId, consecutiveNumbering, exportModeOption, sessionImageArchive, projectName, stylePreference, customApiKey]);

  // Restores scroll and focus position when returning from Config to Storyboard
  useEffect(() => {
    if (activeView === "storyboard" && prevViewRef.current === "config" && focusedSceneId) {
      const timer = setTimeout(() => {
        const el = document.getElementById(`scene-card-${focusedSceneId}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          
          // Flash-highlight effect: trigger temporary border glow
          el.classList.remove("ring-2", "ring-[#D4AF37]/50");
          el.classList.add("ring-2", "ring-[#D4AF37]", "shadow-[0_0_25px_rgba(212,175,55,0.3)]");
          setTimeout(() => {
            el.classList.remove("ring-[#D4AF37]", "shadow-[0_0_25px_rgba(212,175,55,0.3)]");
            el.classList.add("ring-[#D4AF37]/50");
          }, 1500);
        }
      }, 350); // Generous timeout for smooth layout transition
      return () => clearTimeout(timer);
    }
    prevViewRef.current = activeView;
  }, [activeView, focusedSceneId]);

  return (
    <div className="min-h-screen bg-[#0F0F0F] text-[#E0D8D0] flex flex-col font-sans selection:bg-[#D4AF37]/30 selection:text-white">
      
      {/* Upper Fixed Sticky Panel Container */}
      <div className="sticky top-0 z-50 flex flex-col bg-[#0F0F0F] shadow-md border-b border-[#D4AF37]/25 divide-y divide-zinc-900/80">
        
        {/* Premium Header Section */}
        <header className="py-3 px-4 sm:px-8 bg-[#0F0F0F] shrink-0 flex flex-wrap lg:flex-nowrap items-center justify-between gap-4">
          
          {/* LEFT GROUP: Brand, New/Open/Save, Active Project, Server Folder, AutoSave */}
          <div className="flex items-center flex-wrap sm:flex-nowrap gap-4">
            {/* App Brand */}
            <div className="flex flex-col">
              <h1 className="text-xl sm:text-2xl tracking-widest uppercase font-light text-[#D4AF37] font-serif">
                DiárioMaker
              </h1>
              
              {/* Below DiárioMaker: +Novo | Abrir... | Salvar */}
              <div className="flex items-center gap-1.5 mt-1 select-none">
                <button
                  type="button"
                  onClick={() => {
                    setNewProjectDate(new Date().toLocaleDateString("sv-SE"));
                    setNewProjectScript("");
                    setNewProjectStyle("auto");
                    setNewProjectStyleRefImage(undefined);
                    setNewProjectEngine(useOpenAiForPrompts && openAiKey ? "openai" : "gemini");
                    setNewProjectModalError(null);
                    setShowNewProjectModal(true);
                  }}
                  className="text-[10px] uppercase tracking-wider font-mono font-bold text-slate-400 hover:text-[#D4AF37] cursor-pointer flex items-center gap-1 transition-all bg-transparent border-none p-0"
                  title="Iniciar um novo projeto configurando a Data e o Roteiro"
                >
                  <Plus size={10} className="text-[#D4AF37]/70" />
                  <span>Novo</span>
                </button>

                <span className="text-zinc-700 text-[10px] select-none">|</span>

                <label 
                  className={`text-[10px] uppercase tracking-wider font-mono font-bold text-slate-400 hover:text-[#D4AF37] cursor-pointer flex items-center gap-1 transition-all ${
                    isImporting ? "opacity-60 cursor-not-allowed" : ""
                  }`}
                  title="Carregar um arquivo de projeto (.dmaker, .diariomaker ou legado .json) do computador"
                >
                  {isImporting ? (
                    <Loader2 size={10} className="animate-spin text-[#D4AF37]" />
                  ) : (
                    <Upload size={10} className="text-[#D4AF37]/70" />
                  )}
                  <span>{isImporting ? "Abrindo..." : "Abrir..."}</span>
                  <input 
                    type="file" 
                    accept=".dmaker,.diariomaker,.json" 
                    onChange={handleLoadProject} 
                    className="hidden" 
                    disabled={isImporting}
                  />
                </label>

                <span className="text-zinc-700 text-[10px] select-none">|</span>

                <button
                  type="button"
                  onClick={handleSaveProject}
                  disabled={scenes.length === 0 || isExporting}
                  className={`text-[10px] uppercase tracking-wider font-mono font-bold flex items-center gap-1 transition-all ${
                    scenes.length === 0 || isExporting
                      ? "text-zinc-650 opacity-25 cursor-not-allowed"
                      : "text-slate-400 hover:text-[#D4AF37] cursor-pointer bg-transparent border-none p-0"
                  }`}
                  title="Salvar todas as cenas e imagens em um arquivo .dmaker"
                >
                  {isExporting ? (
                    <Loader2 size={10} className="animate-spin text-[#D4AF37]" />
                  ) : (
                    <Save size={10} className={scenes.length === 0 ? "text-zinc-600" : "text-[#D4AF37]/70"} />
                  )}
                  <span>{isExporting ? "Salvando..." : "Salvar"}</span>
                </button>
              </div>
            </div>

            {/* Projeto Ativo Panel */}
            <div className="flex flex-col border-l border-zinc-800 pl-4 py-0.5 justify-center">
              <span className="text-[8px] uppercase tracking-wider text-zinc-500 font-mono font-bold block mb-0.5">Projeto Ativo</span>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                className="bg-transparent border-b border-transparent hover:border-[#D4AF37]/20 focus:border-[#D4AF37]/50 focus:outline-none text-[13px] text-white font-mono px-0.5 pb-0.5 w-[130px] sm:w-[160px] truncate transition-colors font-bold"
                placeholder="Nome do projeto..."
                title="Clique para editar o nome do projeto"
              />

              {/* Below Projeto Ativo: Pasta do projeto (Servidor) and AutoSave side-by-side */}
              <div className="flex items-center gap-2 mt-1 text-[9px] font-mono">
                <div className="flex items-center gap-1">
                  <span className="text-[#D4AF37] font-bold text-[8px] uppercase tracking-wider">Pasta:</span>
                  <span className="text-zinc-500 select-none">projects/</span>
                  <input
                    type="text"
                    value={projectFolder}
                    onChange={(e) => {
                      const cleaned = e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_");
                      setProjectFolder(cleaned);
                    }}
                    className="bg-transparent border-b border-transparent hover:border-[#D4AF37]/20 focus:border-[#D4AF37]/50 focus:outline-none text-[10px] text-stone-200 font-mono px-0.5 pb-0.5 w-[80px] sm:w-[100px] truncate transition-colors font-semibold"
                    placeholder="nome-da-pasta"
                    title="Pasta física no servidor"
                  />
                </div>

                <span className="text-zinc-700">|</span>

                <div className="flex items-center gap-1 select-none">
                  <span className="text-zinc-500">AutoSave:</span>
                  <span className="text-emerald-400 font-semibold">Ativo</span>
                  {lastDiskSaveTime && (
                    <span className="text-zinc-500 text-[8px]">
                      ({lastDiskSaveTime})
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT GROUP: Actions, Scroll 7x, Queue status, Config, Gerar cenas vazias */}
          <div className="flex items-center gap-3 flex-wrap lg:flex-nowrap">
            
            {/* UNDO / REDO BUTTONS */}
            <div className="flex items-center gap-1.5 bg-neutral-900/30 border border-zinc-800/60 p-1 rounded-md">
              {/* Desfazer (smaller, retains text and icon) */}
              <button
                type="button"
                onClick={handleUndo}
                disabled={history.length === 0}
                className={`px-2 py-1 border text-[10px] uppercase tracking-wider font-mono font-bold transition-all flex items-center gap-1 rounded ${
                  history.length === 0
                    ? "border-zinc-800/40 text-zinc-650 bg-transparent cursor-not-allowed opacity-35"
                    : "border-[#D4AF37] text-[#D4AF37] hover:bg-[#D4AF37]/10 cursor-pointer"
                }`}
                title="Desfazer a última ação (Undo)"
              >
                <Undo size={11} />
                <span>Desfazer ({history.length})</span>
              </button>

              {/* Refazer (smaller, arrow icon ONLY) */}
              <button
                type="button"
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                className={`p-1.5 border text-[10px] uppercase tracking-wider font-mono font-bold transition-all flex items-center justify-center rounded ${
                  redoStack.length === 0
                    ? "border-zinc-800/40 text-zinc-650 bg-transparent cursor-not-allowed opacity-35"
                    : "border-[#D4AF37] text-[#D4AF37] hover:bg-[#D4AF37]/10 cursor-pointer"
                }`}
                title={`Refazer a última ação desfeita (${redoStack.length})`}
              >
                <Redo size={11} />
              </button>
            </div>

            <div className="h-7 w-px bg-zinc-800 hidden sm:block" />

            {/* STACKED: Acervo de Imagens and Roteiro do Projeto */}
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setIsGalleryOpen(true)}
                className="px-2.5 py-1 border border-[#D4AF37]/60 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[9px] uppercase tracking-wider font-mono font-bold transition-all flex items-center gap-1.5 rounded cursor-pointer"
                title="Abrir galeria do acervo de imagens do projeto"
              >
                <History size={11} />
                <span>Acervo de Imagens</span>
              </button>

              <button
                type="button"
                onClick={() => setShowScriptModal(true)}
                className="px-2.5 py-1 border border-[#D4AF37]/60 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[9px] uppercase tracking-wider font-mono font-bold transition-all flex items-center gap-1.5 rounded cursor-pointer"
                title="Visualizar ou editar o roteiro completo do projeto"
              >
                <FileText size={11} />
                <span>Roteiro do Projeto</span>
              </button>
            </div>

            <div className="h-7 w-px bg-zinc-800 hidden sm:block" />

            {/* Conectar Cenas Tool Button */}
            <button
              type="button"
              onClick={() => {
                setIsConnectionMode(!isConnectionMode);
                setSelectedSceneIdsForConnection([]);
              }}
              className={`px-3 py-1.5 border text-[10px] uppercase tracking-wider font-bold transition-all flex items-center gap-1.5 rounded cursor-pointer ${
                isConnectionMode
                  ? "bg-[#D4AF37] text-black border-[#D4AF37] hover:bg-white"
                  : "border-[#D4AF37]/60 text-[#D4AF37] hover:bg-[#D4AF37]/10"
              }`}
              title="Conectar cenas para compartilharem consistência estética"
            >
              <LinkIcon size={11} />
              <span>Conectar Cenas</span>
            </button>

            {/* Fila de Geração Button */}
            {(() => {
              const activeQueueCount = scenes.filter(
                (s) =>
                  s.renderStatus === "queued" ||
                  s.renderStatus === "rendering" ||
                  s.promptQueueStatus === "queued" ||
                  s.promptQueueStatus === "generating"
              ).length;
              const hasActiveQueue = activeQueueCount > 0;

              return (
                <button
                  type="button"
                  onClick={() => setShowQueuePanel(!showQueuePanel)}
                  className={`px-3 py-1.5 border text-[10px] uppercase tracking-wider font-mono font-bold transition-all flex items-center gap-1.5 rounded cursor-pointer ${
                    hasActiveQueue
                      ? showQueuePanel
                        ? "bg-[#D4AF37] text-black border-[#D4AF37]"
                        : "bg-amber-950/50 text-[#D4AF37] border-amber-500/60 hover:bg-amber-900/40 animate-pulse shadow-[0_0_10px_rgba(212,175,55,0.2)]"
                      : showQueuePanel
                        ? "bg-zinc-800 text-zinc-200 border-zinc-700"
                        : "border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 bg-zinc-900/40"
                  }`}
                  title="Abrir/Fechar painel de acompanhamento da fila de geração"
                >
                  {hasActiveQueue ? (
                    <Loader2 className="animate-spin text-current" size={11} />
                  ) : (
                    <Sparkles size={11} className="text-[#D4AF37]/80" />
                  )}
                  <span>
                    Fila{hasActiveQueue ? `: ${activeQueueCount} Ativa` : " (0)"}
                  </span>
                  <span className="text-[8px]">{showQueuePanel ? "▲" : "▼"}</span>
                </button>
              );
            })()}

            <div className="h-7 w-px bg-zinc-800 hidden lg:block" />

            {/* Scroll 7x Panel */}
            <div className="flex items-center gap-2.5">
              <div className="flex flex-col">
                <span className="text-[7px] uppercase tracking-wider text-zinc-500 font-mono font-bold block mb-0.5">Scroll 7x</span>
                <div
                  ref={superScrollPadRef}
                  className="w-12 h-12 rounded-lg bg-gradient-to-br from-[#121212] to-[#181818] border border-[#D4AF37]/35 hover:border-[#D4AF37] hover:bg-[#D4AF37]/10 transition-all duration-300 cursor-ns-resize flex flex-col items-center justify-center select-none relative overflow-hidden group"
                  title="Rolagem 7 VEZES MAIS RÁPIDA pelo storyboard"
                >
                  <div className="flex flex-col items-center justify-center text-[#D4AF37]/70 group-hover:text-[#D4AF37] transition-colors pointer-events-none z-10">
                    <span className="text-[6px] animate-pulse font-mono font-bold">▲</span>
                    <Cpu size={11} className="text-[#D4AF37] my-0.5 group-hover:scale-110 transition-transform duration-300" />
                    <span className="text-[6px] animate-pulse font-mono font-bold">▼</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col h-full justify-between">
                <span className="text-[7px] uppercase tracking-wider text-zinc-500 font-mono font-bold block mb-0.5">Cena Ativa</span>
                <div className="h-12 px-2.5 rounded-lg bg-zinc-950/60 border border-zinc-900 flex items-center justify-center min-w-[70px]">
                  <span className="text-lg font-mono font-black text-[#D4AF37] tracking-tight">
                    {scenes.length > 0 
                      ? (scenes[visibleSceneIndex]?.sceneNumber || String(visibleSceneIndex + 1)).padStart(2, "0") 
                      : "00"}
                  </span>
                  <span className="text-[9px] font-mono font-bold text-zinc-650 ml-1 select-none">
                    / {String(scenes.length).padStart(2, "0")}
                  </span>
                </div>
              </div>
            </div>

            <div className="h-7 w-px bg-zinc-800 hidden lg:block" />

            {/* TOP RIGHT CORNER: Config Button (Icon only with text outside) & Gerar cenas vazias */}
            <div className="flex flex-col items-end gap-1.5 ml-auto lg:ml-0">
              
              {/* Config / Storyboard Button */}
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => setActiveView(activeView === "storyboard" ? "config" : "storyboard")}
                  className="p-2 border border-[#D4AF37] bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] rounded-md transition-all cursor-pointer shadow-[0_0_10px_rgba(212,175,55,0.1)]"
                  title={activeView === "config" ? "Voltar ao Storyboard" : "Abrir Configurações do Projeto"}
                >
                  {activeView === "config" ? (
                    <Film size={15} />
                  ) : (
                    <Settings size={15} />
                  )}
                </button>
                <span className="text-[8px] uppercase tracking-wider font-mono font-bold text-zinc-400 mt-0.5 select-none">
                  {activeView === "config" ? "Storyboard" : "Configurações"}
                </span>
              </div>

              {/* Gerar Cenas Vazias collapsible menu */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowEmptyScenesSubMenu(!showEmptyScenesSubMenu)}
                  className="px-2.5 py-1 border border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-[9px] uppercase tracking-wider font-mono font-bold rounded flex items-center gap-1 transition-all cursor-pointer"
                  title="Gerenciar geração de cenas vazias do projeto"
                >
                  <Sparkles size={10} />
                  <span>Gerar cenas vazias</span>
                  <span className="text-[8px] ml-0.5">{showEmptyScenesSubMenu ? "▲" : "▼"}</span>
                </button>

                {/* Sub-buttons when expanded */}
                {showEmptyScenesSubMenu && (
                  <div className="absolute right-0 top-full mt-1.5 z-50 bg-[#161616] border border-[#333] rounded p-1.5 shadow-xl flex flex-col gap-1 min-w-[130px] animate-fadeIn">
                    
                    {/* Button 1: Gerar Apenas Prompts (Icon + "Prompts") */}
                    <button
                      type="button"
                      onClick={() => {
                        handleGenerateAllEmptyPromptsOnly();
                        setShowEmptyScenesSubMenu(false);
                      }}
                      className="w-full px-2 py-1 bg-amber-500/10 hover:bg-amber-500 hover:text-black text-amber-400 border border-amber-500/30 text-[9px] uppercase tracking-wider font-mono font-bold rounded flex items-center gap-1.5 transition-all cursor-pointer"
                      title="Gera apenas as descrições visuais e prompts das cenas sem gerar imagens"
                    >
                      <Edit3 size={11} />
                      <span>Prompts</span>
                    </button>

                    {/* Button 2: Gera Imagens Vazias (with Submenu Model Selection) */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowImageModelSubMenu(!showImageModelSubMenu)}
                        className="w-full px-2 py-1 bg-amber-950/40 hover:bg-amber-500 hover:text-black text-amber-300 border border-amber-800/50 text-[9px] uppercase tracking-wider font-mono font-bold rounded flex items-center justify-between gap-1.5 transition-all cursor-pointer"
                        title="Gera imagens apenas para as cenas que não têm foto — selecione o modelo de IA desejado"
                      >
                        <div className="flex items-center gap-1.5">
                          <Image size={11} />
                          <span>Imagens</span>
                        </div>
                        <span className="text-[8px] ml-1">{showImageModelSubMenu ? "◄" : "►"}</span>
                      </button>

                      {/* Image Model Selection Flyout Submenu */}
                      {showImageModelSubMenu && (
                        <div className="absolute right-full top-0 mr-1.5 z-50 bg-[#141414] border border-[#D4AF37]/50 rounded p-1.5 shadow-2xl flex flex-col gap-1 min-w-[170px] animate-fadeIn">
                          <div className="px-2 py-0.5 text-[8px] font-mono uppercase tracking-widest text-[#D4AF37] border-b border-[#333] font-bold mb-1">
                            Modelo de Imagem:
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              handleQueueAllPendingImages("gemini-2.5-flash-image");
                              setShowImageModelSubMenu(false);
                              setShowEmptyScenesSubMenu(false);
                            }}
                            className="w-full px-2 py-1 text-left bg-[#1f1f1f] hover:bg-[#D4AF37] hover:text-black text-amber-300 text-[9px] font-mono font-bold rounded flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <span>🍌 Nano Banana (Flash)</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              handleQueueAllPendingImages("imagen-3.0-generate-002");
                              setShowImageModelSubMenu(false);
                              setShowEmptyScenesSubMenu(false);
                            }}
                            className="w-full px-2 py-1 text-left bg-[#1f1f1f] hover:bg-[#D4AF37] hover:text-black text-amber-300 text-[9px] font-mono font-bold rounded flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <span>🎨 Google Imagen 3</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              handleQueueAllPendingImages("imagen-3.0-fast-generate-001");
                              setShowImageModelSubMenu(false);
                              setShowEmptyScenesSubMenu(false);
                            }}
                            className="w-full px-2 py-1 text-left bg-[#1f1f1f] hover:bg-[#D4AF37] hover:text-black text-amber-300 text-[9px] font-mono font-bold rounded flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <span>⚡ Fast Imagen 3</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              handleQueueAllPendingImages("gpt-image-2");
                              setShowImageModelSubMenu(false);
                              setShowEmptyScenesSubMenu(false);
                            }}
                            className="w-full px-2 py-1 text-left bg-[#1f1f1f] hover:bg-[#D4AF37] hover:text-black text-amber-300 text-[9px] font-mono font-bold rounded flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <span>🤖 OpenAI GPT-Image 2</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Button 3: Gerar Todos (Icon + "Prpt+Img") */}
                    <button
                      type="button"
                      onClick={() => {
                        handleGenerateAllEmptyPromptsAndImages();
                        setShowEmptyScenesSubMenu(false);
                      }}
                      className="w-full px-2 py-1 bg-[#D4AF37]/15 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] border border-[#D4AF37]/40 text-[9px] uppercase tracking-wider font-mono font-bold rounded flex items-center gap-1.5 transition-all cursor-pointer"
                      title="Gera todos os prompts e depois enfileira as imagens para serem geradas automaticamente"
                    >
                      <Sparkles size={11} />
                      <span>Prpt+Img</span>
                    </button>

                  </div>
                )}
              </div>

            </div>

          </div>
        </header>

      {/* Render Queue Panel inside sticky bar */}
      {showQueuePanel && (
        <div className="bg-[#121212] px-6 sm:px-10 py-3 text-xs animate-slideDown shadow-lg shrink-0 border-t border-[#222]">
          <div className="max-w-[1600px] mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Loader2 className={`animate-spin ${scenes.some(s => s.renderStatus === "queued" || s.renderStatus === "rendering" || s.promptQueueStatus === "queued" || s.promptQueueStatus === "generating") ? "text-[#D4AF37]" : "text-zinc-600"}`} size={14} />
              <span className="font-mono text-[10px] uppercase tracking-wider font-bold text-[#D4AF37]">
                Acompanhamento da Fila ({scenes.filter(s => s.renderStatus === "queued" || s.renderStatus === "rendering" || s.promptQueueStatus === "queued" || s.promptQueueStatus === "generating").length} tarefas em processamento)
              </span>
            </div>
            
            {scenes.some(s => s.renderStatus === "queued" || s.renderStatus === "rendering" || s.promptQueueStatus === "queued" || s.promptQueueStatus === "generating") ? (
              <div className="flex flex-wrap items-center gap-2 max-h-24 overflow-y-auto pr-2">
                {/* Prompts in queue */}
                {scenes
                  .filter(s => s.promptQueueStatus === "queued" || s.promptQueueStatus === "generating")
                  .map((scene) => {
                    const sceneIndex = scenes.findIndex(sc => sc.id === scene.id);
                    return (
                      <div 
                        key={`prompt-${scene.id}`} 
                        className="bg-black/80 border border-blue-900/40 rounded px-2.5 py-1 flex items-center gap-3 font-mono text-[10px] animate-fadeIn animate-pulse"
                      >
                        <span className="text-blue-400 font-bold">PROMPT #{sceneIndex + 1}</span>
                        <span className={`text-[9px] uppercase font-bold px-1 rounded ${
                          scene.promptQueueStatus === "generating" ? "bg-blue-500/15 text-blue-400" : "bg-zinc-800 text-zinc-400"
                        }`}>
                          {scene.promptQueueStatus === "generating" ? "Criando" : "Fila"}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCancelPromptQueue(scene.id)}
                          className="text-rose-400 hover:text-rose-300 hover:underline transition-all uppercase tracking-wider font-bold text-[8px] cursor-pointer font-mono"
                          title="Remover da fila de prompts"
                        >
                          [Cancelar]
                        </button>
                      </div>
                    );
                  })}

                {/* Images in queue */}
                {scenes
                  .filter(s => s.renderStatus === "queued" || s.renderStatus === "rendering")
                  .map((scene) => {
                    const sceneIndex = scenes.findIndex(sc => sc.id === scene.id);
                    return (
                      <div 
                        key={`image-${scene.id}`} 
                        className="bg-black/80 border border-[#2b2b2b] rounded px-2.5 py-1 flex items-center gap-3 font-mono text-[10px] animate-fadeIn"
                      >
                        <span className="text-zinc-400 font-bold">CENA #{sceneIndex + 1}</span>
                        <span className={`text-[9px] uppercase font-bold px-1 rounded ${
                          scene.renderStatus === "rendering" ? "bg-amber-500/15 text-amber-400" : "bg-zinc-800 text-zinc-400"
                        }`}>
                          {scene.renderStatus === "rendering" ? "Gerando" : "Fila"}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCancelRender(scene.id)}
                          className="text-rose-400 hover:text-rose-300 hover:underline transition-all uppercase tracking-wider font-bold text-[8px] cursor-pointer font-mono"
                          title="Liberar este quadro e tirá-lo da fila"
                        >
                          [Cancelar]
                        </button>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <span className="text-zinc-500 font-mono text-[10px]">
                Nenhum prompt ou imagem na fila no momento.
              </span>
            )}

            {scenes.some(s => s.renderStatus === "queued" || s.renderStatus === "rendering" || s.promptQueueStatus === "queued" || s.promptQueueStatus === "generating") && (
              <button
                type="button"
                onClick={() => {
                  scenes.forEach(s => {
                    if (s.renderStatus === "queued" || s.renderStatus === "rendering") {
                      handleCancelRender(s.id);
                    }
                    if (s.promptQueueStatus === "queued" || s.promptQueueStatus === "generating") {
                      handleCancelPromptQueue(s.id);
                    }
                  });
                  setShowQueuePanel(false);
                  setNotification("✓ Toda a fila de geração foi cancelada e limpa.");
                }}
                className="text-[9px] uppercase tracking-wider font-mono font-bold px-3 py-1 bg-rose-950/45 hover:bg-rose-900 border border-rose-900/40 hover:border-rose-700 text-rose-300 rounded cursor-pointer transition-all"
              >
                Parar Toda a Fila
              </button>
            )}
          </div>
        </div>
      )}

      {/* Aesthetic Connection Control Center inside sticky bar */}
      {isConnectionMode && (
        <div className="bg-[#121212] px-6 sm:px-10 py-4.5 space-y-4 shadow-2xl animate-slideDown shrink-0 text-left border-t border-zinc-900">
          <div className="max-w-[1600px] mx-auto space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-2.5">
              <div className="flex items-center gap-2">
                <LinkIcon size={15} className="text-[#D4AF37] animate-pulse" />
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-[#E0D8D0]">
                  Painel de Conectar Cenas & Sequencial de Personagem
                </span>
              </div>
              <span className="text-[10px] font-mono text-stone-500">
                Selecione 2 ou mais cenas clicando nos círculos de seleção à esquerda de cada cena
              </span>
            </div>

            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              {/* Select Connection Group option */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[10px] uppercase font-mono tracking-wider text-stone-400">Grupo Cromático:</span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {connectionGroups.map((group) => {
                    const isGroupSelected = selectedConnectionGroupId === group.id;
                    return (
                      <button
                        key={group.id}
                        type="button"
                        onClick={() => setSelectedConnectionGroupId(group.id)}
                        className="px-3 py-1 rounded text-[10px] uppercase font-mono font-bold transition-all flex items-center gap-2 border cursor-pointer"
                        style={{
                          backgroundColor: isGroupSelected ? `${group.color}20` : "#161616",
                          color: isGroupSelected ? "#fff" : "#a8a29e",
                          borderColor: isGroupSelected ? group.color : "#2d2d2d",
                        }}
                      >
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: group.color }}></span>
                        <span>{group.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Actions buttons */}
              <div className="flex items-center gap-2">
                {/* Confirm Link */}
                <button
                  type="button"
                  disabled={selectedSceneIdsForConnection.length < 2}
                  onClick={handleConfirmConnection}
                  className={`px-3 py-1.5 rounded text-[10px] uppercase font-mono font-bold transition-all flex items-center gap-1.5 border ${
                    selectedSceneIdsForConnection.length >= 2
                      ? "bg-[#D4AF37] text-black border-[#D4AF37] hover:bg-white cursor-pointer shadow-[0_0_15px_rgba(212,175,55,0.15)]"
                      : "bg-zinc-800/20 text-zinc-650 border-zinc-850 cursor-not-allowed"
                  }`}
                  title="Ligar e sincronizar as cenas selecionadas para compartilharem diretrizes estéticas"
                >
                  <Check size={12} />
                  <span>Conectar Cenas ({selectedSceneIdsForConnection.length})</span>
                </button>

                {/* Clear selection / Remove connection */}
                <button
                  type="button"
                  disabled={selectedSceneIdsForConnection.length === 0}
                  onClick={handleRemoveConnection}
                  className={`px-3 py-1.5 rounded text-[10px] uppercase font-mono font-bold transition-all flex items-center gap-1.5 border ${
                    selectedSceneIdsForConnection.length > 0
                      ? "bg-rose-950/25 text-rose-400 border-rose-900/30 hover:bg-rose-900 hover:text-white cursor-pointer"
                      : "bg-zinc-850/10 text-zinc-600 border-transparent cursor-not-allowed"
                  }`}
                  title="Desvincular todas as cenas selecionadas para que fiquem independentes"
                >
                  <Unlink size={12} />
                  <span>Desvincular</span>
                </button>

                {/* Exit/Cancel */}
                <button
                  type="button"
                  onClick={() => {
                    setIsConnectionMode(false);
                    setSelectedSceneIdsForConnection([]);
                  }}
                  className="px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-stone-400 hover:text-white rounded text-[10px] uppercase font-mono font-bold cursor-pointer transition-all"
                >
                  Sair
                </button>
              </div>
            </div>

            <div className="text-[10px] leading-relaxed text-stone-400 font-sans italic bg-stone-950/40 p-3 rounded border border-zinc-850">
              💡 <strong>Garantia de Consistência Narrativa:</strong> Ao conectar cenas em um grupo, as referências de imagem (se houver), os prompts e descrições são automaticamente injetados no sistema do Diretor de Arte AI. Quando você for refinar ou geração de imagens de uma cena do grupo, a IA saberá do visual das outras cenas vinculadas, mantendo o mesmo ator, roupas, iluminação e estilo artístico.
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Main Workplace Layout */}
      <main ref={mainScrollRef} className="flex-1 w-full mx-auto p-4 sm:p-8 overflow-y-auto">
        {activeView === "config" ? (
          /* Second Page: Configuration & New Script Input */
          <div className="max-w-5xl mx-auto w-full grid grid-cols-1 md:grid-cols-12 gap-8 py-4 animate-fadeIn">
            {/* Left Hand: Consolidated AI APIs Panel */}
            <div className="md:col-span-6 space-y-6">
              {/* Unified AI Connections & API Panel */}
              <div className="bg-[#161616] border border-[#333] rounded-lg p-5 space-y-5">
                <div className="flex items-center gap-2 border-b border-[#333] pb-3 justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles size={14} className="text-[#D4AF37]" />
                    <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-[#D4AF37]">
                      Conexões e APIs de IA
                    </h3>
                  </div>
                  <span className="text-[9px] uppercase font-mono text-stone-500 font-bold">Painel Unificado</span>
                </div>

                {/* Sub-tabs selector */}
                <div className="grid grid-cols-3 gap-1.5 bg-[#0a0a0a] p-1 rounded border border-[#222]">
                  <button
                    type="button"
                    onClick={() => setActiveApiTab("gemini")}
                    className={`text-[10px] py-2 px-1 rounded uppercase font-mono font-bold tracking-wider transition-all cursor-pointer text-center ${
                      activeApiTab === "gemini"
                        ? "bg-[#D4AF37] text-black shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    Gemini
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveApiTab("chatgpt")}
                    className={`text-[10px] py-2 px-1 rounded uppercase font-mono font-bold tracking-wider transition-all cursor-pointer text-center ${
                      activeApiTab === "chatgpt"
                        ? "bg-[#D4AF37] text-black shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    ChatGPT
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveApiTab("ollama")}
                    className={`text-[10px] py-2 px-1 rounded uppercase font-mono font-bold tracking-wider transition-all cursor-pointer text-center ${
                      activeApiTab === "ollama"
                        ? "bg-[#D4AF37] text-black shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    Ollama Local
                  </button>
                </div>

                {/* Tab content */}
                <div className="space-y-4 pt-1">
                  {activeApiTab === "gemini" && (
                    <div className="space-y-4 animate-fadeIn">
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Está enfrentando erros de limite de cota (<code className="text-rose-400 font-mono">429 Resource Exhausted</code>)? Insira sua chave de API gratuita do Gemini para rodar diretamente em sua cota pessoal.
                      </p>
                      
                      <div className="space-y-2">
                        <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                          Chave de API Gemini
                        </label>
                        <div className="relative">
                          <input
                            type={showApiKey ? "text" : "password"}
                            value={customApiKey}
                            onChange={(e) => setCustomApiKey(e.target.value)}
                            placeholder="Cole sua API Key (AIzaSy...)"
                            className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 pr-10 text-xs font-mono text-white placeholder-zinc-650 focus:border-[#D4AF37] focus:outline-none transition-all"
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-2.5 top-2.5 text-slate-500 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                          >
                            {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>

                        <div className="flex gap-2 pt-1">
                          <a
                            href="https://aistudio.google.com/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 py-1.5 border border-[#333] bg-[#0a0a0a] hover:bg-[#111] text-center text-slate-400 hover:text-white text-[10px] uppercase tracking-wider font-mono rounded transition-all"
                          >
                            Criar chave grátis
                          </a>
                          {customApiKey && (
                            <>
                              <button
                                type="button"
                                onClick={handleTestApiKey}
                                disabled={isTestingKey}
                                className="px-2.5 py-1.5 border border-[#D4AF37]/35 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[10px] uppercase tracking-wider font-mono rounded transition-all cursor-pointer disabled:opacity-50"
                              >
                                {isTestingKey ? "Testando..." : "Testar"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setCustomApiKey("");
                                  setKeyTestResult(null);
                                  setNotification("Chave de API removida. Usando a chave padrão do servidor.");
                                }}
                                className="px-2.5 py-1.5 border border-rose-950/40 bg-rose-950/10 hover:bg-rose-950/30 text-rose-400 text-[10px] uppercase tracking-wider font-mono rounded transition-all cursor-pointer"
                              >
                                Limpar
                              </button>
                            </>
                          )}
                        </div>

                        {customApiKey ? (
                          <div className="flex items-center gap-1.5 text-[9px] font-mono text-emerald-400 bg-emerald-950/20 border border-emerald-900/30 px-2 py-1 rounded">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            <span>Chave ativa: Geração rodando em sua cota pessoal</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-[9px] font-mono text-slate-500 bg-black/20 border border-[#222] px-2 py-1 rounded">
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
                            <span>Usando chave pública do servidor (limite compartilhado)</span>
                          </div>
                        )}

                        {keyTestResult && (
                          <div className={`text-[10px] p-2.5 rounded border font-mono leading-relaxed ${
                            keyTestResult.success 
                              ? "bg-emerald-950/25 border-emerald-500/20 text-emerald-300" 
                              : "bg-rose-950/25 border-rose-500/20 text-rose-300"
                          }`}>
                            <div className="font-bold mb-0.5">{keyTestResult.success ? "✓ Conexão Ativa" : "✗ Falha no Teste"}</div>
                            <p className="text-[9px] text-slate-300">{keyTestResult.message}</p>
                          </div>
                        )}

                        {/* Dynamic Gemini Models list */}
                        <div className="space-y-3 pt-3 border-t border-[#2b2b2b]">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] uppercase tracking-wider text-[#D4AF37] font-mono font-bold">
                              Modelos Gemini Disponíveis
                            </span>
                            <button
                              type="button"
                              onClick={() => fetchAvailableModels("gemini")}
                              disabled={geminiSearchStatus === "searching"}
                              className={`text-[9px] uppercase font-mono px-2 py-0.5 rounded border transition-all cursor-pointer disabled:opacity-50 ${
                                geminiSearchStatus === "success"
                                  ? "bg-emerald-950/40 border-emerald-900/60 text-emerald-400 font-bold"
                                  : geminiSearchStatus === "error"
                                  ? "bg-rose-950/40 border-rose-900/60 text-rose-400 font-bold"
                                  : "border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700"
                              }`}
                            >
                              {geminiSearchStatus === "searching" && "⏳ Buscando..."}
                              {geminiSearchStatus === "success" && "✓ Atualizado!"}
                              {geminiSearchStatus === "error" && "✗ Falha!"}
                              {geminiSearchStatus === "idle" && "🔎 Buscar Online"}
                            </button>
                          </div>
                          
                          <div className="space-y-2 max-h-36 overflow-y-auto bg-black/20 p-2.5 rounded border border-[#222]">
                            <div className="space-y-1">
                              <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block font-bold">Prompt (Texto):</span>
                              <div className="flex flex-wrap gap-1">
                                {(availableModels.gemini?.text || []).map((m) => (
                                  <span key={m} className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[9px] rounded text-slate-350 font-mono">
                                    {m}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="space-y-1 pt-1.5 border-t border-[#222]">
                              <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block font-bold">Imagem (Imagen):</span>
                              <div className="flex flex-wrap gap-1">
                                {(availableModels.gemini?.image || []).map((m) => (
                                  <span key={m} className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[9px] rounded text-emerald-450 font-mono">
                                    {m}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeApiTab === "chatgpt" && (
                    <div className="space-y-4 animate-fadeIn">
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Quer criar roteiros, prompts e renderizações com a tecnologia do ChatGPT e DALL-E? Ative a integração inserindo sua chave OpenAI abaixo.
                      </p>

                      <div className="space-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                            Chave de API OpenAI
                          </label>
                          <div className="relative">
                            <input
                              type={showOpenAiKey ? "text" : "password"}
                              value={openAiKey}
                              onChange={(e) => setOpenAiKey(e.target.value)}
                              placeholder="Cole sua OpenAI Key (sk-proj-...)"
                              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 pr-10 text-xs font-mono text-white placeholder-zinc-650 focus:border-[#D4AF37] focus:outline-none transition-all"
                            />
                            <button
                              type="button"
                              onClick={() => setShowOpenAiKey(!showOpenAiKey)}
                              className="absolute right-2.5 top-2.5 text-slate-500 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                            >
                              {showOpenAiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>
                        </div>

                        {openAiKey.trim() && (
                          <>
                            {/* Toggle use OpenAI for prompt structuring */}
                            <div className="flex items-center justify-between p-2.5 bg-black/25 border border-[#222] rounded">
                              <div className="space-y-0.5">
                                <span className="text-[10px] font-bold text-[#E0D8D0] uppercase tracking-wide">
                                  Usar ChatGPT para Prompts
                                </span>
                                <p className="text-[9px] text-slate-400">
                                  Processa roteiros e descrições com IA OpenAI
                                </p>
                              </div>
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={useOpenAiForPrompts}
                                  onChange={(e) => setUseOpenAiForPrompts(e.target.checked)}
                                  className="sr-only peer"
                                />
                                <div className="w-8 h-4 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-450 after:border-zinc-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#D4AF37] peer-checked:after:bg-black"></div>
                              </label>
                            </div>

                            {/* Chat model selection */}
                            {useOpenAiForPrompts && (
                              <div className="space-y-1.5">
                                <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                                  Modelo do ChatGPT
                                </label>
                                <div className="flex gap-1.5">
                                  <select
                                    value={(availableModels.openai?.text || []).includes(openAiModel) ? openAiModel : (openAiModel === "" ? "" : "custom")}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      if (val !== "custom") {
                                        setOpenAiModel(val);
                                      } else {
                                        setOpenAiModel("");
                                      }
                                    }}
                                    className="flex-1 bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1.5 text-xs text-white focus:border-[#D4AF37] focus:outline-none font-mono"
                                  >
                                    {(availableModels.openai?.text || []).map((m) => (
                                      <option key={m} value={m}>{m}</option>
                                    ))}
                                    <option value="custom">✍ Digitar ID de Modelo Personalizado...</option>
                                  </select>
                                  {(!(availableModels.openai?.text || []).includes(openAiModel) || openAiModel === "") && (
                                    <input
                                      type="text"
                                      value={openAiModel}
                                      placeholder="Ex: gpt-4.5-preview"
                                      onChange={(e) => setOpenAiModel(e.target.value)}
                                      className="w-1/2 bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1.5 text-xs text-white focus:border-[#D4AF37] focus:outline-none font-mono"
                                    />
                                  )}
                                </div>
                              </div>
                            )}

                            {/* DALL-E image generation model selection */}
                            <div className="space-y-1.5">
                              <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                                Modelo DALL-E (Imagem)
                              </label>
                              <div className="flex gap-1.5">
                                <select
                                  value={(availableModels.openai?.image || []).includes(openAiDalleModel) ? openAiDalleModel : (openAiDalleModel === "" ? "" : "custom")}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    if (val !== "custom") {
                                      setOpenAiDalleModel(val);
                                    } else {
                                      setOpenAiDalleModel("");
                                    }
                                  }}
                                  className="flex-1 bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1.5 text-xs text-white focus:border-[#D4AF37] focus:outline-none font-mono"
                                >
                                  {(availableModels.openai?.image || []).map((m) => (
                                    <option key={m} value={m}>{m}</option>
                                  ))}
                                  <option value="custom">✍ Digitar ID de Modelo Personalizado...</option>
                                </select>
                                {(!(availableModels.openai?.image || []).includes(openAiDalleModel) || openAiDalleModel === "") && (
                                  <input
                                    type="text"
                                    value={openAiDalleModel}
                                    placeholder="Ex: dall-e-3-hd"
                                    onChange={(e) => setOpenAiDalleModel(e.target.value)}
                                    className="w-1/2 bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1.5 text-xs text-white focus:border-[#D4AF37] focus:outline-none font-mono"
                                  />
                                )}
                              </div>
                            </div>
                            
                            {/* Dynamic OpenAI Models list */}
                            <div className="space-y-3 pt-3 border-t border-[#2b2b2b]">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] uppercase tracking-wider text-[#D4AF37] font-mono font-bold">
                                  Modelos OpenAI Disponíveis
                                </span>
                                <button
                                  type="button"
                                  onClick={() => fetchAvailableModels("openai")}
                                  disabled={openaiSearchStatus === "searching"}
                                  className={`text-[9px] uppercase font-mono px-2 py-0.5 rounded border transition-all cursor-pointer disabled:opacity-50 ${
                                    openaiSearchStatus === "success"
                                      ? "bg-emerald-950/40 border-emerald-900/60 text-emerald-400 font-bold"
                                      : openaiSearchStatus === "error"
                                      ? "bg-rose-950/40 border-rose-900/60 text-rose-400 font-bold"
                                      : "border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700"
                                  }`}
                                >
                                  {openaiSearchStatus === "searching" && "⏳ Buscando..."}
                                  {openaiSearchStatus === "success" && "✓ Atualizado!"}
                                  {openaiSearchStatus === "error" && "✗ Falha!"}
                                  {openaiSearchStatus === "idle" && "🔎 Buscar Online"}
                                </button>
                              </div>
                              
                              <div className="space-y-2 max-h-36 overflow-y-auto bg-black/20 p-2.5 rounded border border-[#222]">
                                <div className="space-y-1">
                                  <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block font-bold">Prompt (Texto):</span>
                                  <div className="flex flex-wrap gap-1">
                                    {(availableModels.openai?.text || []).map((m) => (
                                      <span key={m} className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[9px] rounded text-slate-350 font-mono">
                                        {m}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                                <div className="space-y-1 pt-1.5 border-t border-[#222]">
                                  <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block font-bold">Imagem (DALL-E):</span>
                                  <div className="flex flex-wrap gap-1">
                                    {(availableModels.openai?.image || []).map((m) => (
                                      <span key={m} className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-[9px] rounded text-emerald-450 font-mono">
                                        {m}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </>
                        )}

                        {openAiKey ? (
                          <div className="flex items-center justify-between p-2.5 bg-emerald-950/20 border border-emerald-900/30 rounded">
                            <div className="flex items-center gap-1.5 text-[9px] font-mono text-emerald-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                              <span>OpenAI Ativo</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenAiKey("");
                                setUseOpenAiForPrompts(false);
                                setNotification("Integração OpenAI removida.");
                              }}
                              className="text-[9px] uppercase font-mono text-rose-400 hover:text-rose-350 transition-colors cursor-pointer"
                            >
                              Desativar
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-[9px] font-mono text-slate-500 bg-black/20 border border-[#222] px-2 py-1 rounded">
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
                            <span>Chave OpenAI Ausente (Imagens rodando via Nano Banana)</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {activeApiTab === "ollama" && (
                    <div className="space-y-4 animate-fadeIn">
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Gere roteiros e prompts localmente no seu computador sem depender de nuvem ou cotas de API. Conecte com qualquer modelo local ativo.
                      </p>

                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                            URL da API do Ollama
                          </label>
                          <input
                            type="text"
                            value={ollamaUrl}
                            onChange={(e) => setOllamaUrl(e.target.value)}
                            placeholder="http://localhost:11434"
                            className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-1.5 text-xs font-mono text-white focus:border-[#D4AF37] focus:outline-none"
                          />
                        </div>

                        <div className="space-y-1">
                          <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                            Modelo no Ollama
                          </label>
                          <div className="flex gap-1.5">
                            {ollamaModels.length > 0 ? (
                              <select
                                value={ollamaModels.includes(ollamaModel) ? ollamaModel : "custom"}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val !== "custom") {
                                    setOllamaModel(val);
                                  } else {
                                    setOllamaModel("");
                                  }
                                }}
                                className="flex-1 bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1.5 text-xs text-white focus:border-[#D4AF37] focus:outline-none font-mono cursor-pointer"
                              >
                                {ollamaModels.map((m) => (
                                  <option key={m} value={m}>{m}</option>
                                ))}
                                <option value="custom">✍ Digitar Personalizado...</option>
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={ollamaModel}
                                onChange={(e) => setOllamaModel(e.target.value)}
                                placeholder="Ex: llama3, mistral, deepseek-r1"
                                className="flex-1 bg-[#0a0a0a] border border-[#333] rounded px-3 py-1.5 text-xs font-mono text-white focus:border-[#D4AF37] focus:outline-none"
                              />
                            )}
                            <button
                              type="button"
                              onClick={fetchOllamaModels}
                              disabled={isFetchingOllamaModels}
                              className="px-2.5 py-1.5 border border-[#D4AF37]/35 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[10px] uppercase tracking-wider font-mono rounded transition-all cursor-pointer disabled:opacity-50"
                            >
                              {isFetchingOllamaModels ? "Buscando..." : "Buscar Modelos"}
                            </button>
                          </div>
                          {(!ollamaModels.includes(ollamaModel) || ollamaModel === "") && ollamaModels.length > 0 && (
                            <input
                              type="text"
                              value={ollamaModel}
                              onChange={(e) => setOllamaModel(e.target.value)}
                              placeholder="Digite o ID do modelo Ollama"
                              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-1.5 text-xs font-mono text-white focus:border-[#D4AF37] focus:outline-none mt-1.5"
                            />
                          )}
                        </div>

                        <div className="bg-black/35 p-3 rounded border border-zinc-850 space-y-1.5">
                          <span className="text-[9px] font-mono uppercase tracking-wider text-[#D4AF37] block">Como ativar o Ollama no seu PC:</span>
                          <p className="text-[10px] text-slate-400 leading-relaxed">
                            Inicie o Ollama habilitando a permissão de CORS:
                          </p>
                          <div className="text-[9px] font-mono bg-black/60 p-1.5 rounded text-stone-300 border border-[#222]">
                            OLLAMA_ORIGINS="*" ollama serve
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Estilos Artísticos Panel (Subido para abaixo de Conexões) */}
              <div className="bg-[#161616] border border-[#333] rounded-lg p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-[#333] pb-3">
                  <div className="flex items-center gap-2">
                    <Cpu size={14} className="text-[#D4AF37]" />
                    <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-[#D4AF37]">
                      Estilos Artísticos
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const newId = `custom_style_${Date.now()}`;
                      const newStyle: ArtisticStyle = {
                        id: newId,
                        name: "Novo Estilo",
                        prompt: "Style: [Descreva o estilo artístico aqui]",
                        autoDetectKeywords: ""
                      };
                      setArtisticStyles([...artisticStyles, newStyle]);
                      setSelectedStyleTab(newId);
                      setNotification("✓ Novo estilo criado com sucesso!");
                    }}
                    className="px-2.5 py-1 border border-[#D4AF37]/35 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[10px] uppercase font-mono rounded transition-all cursor-pointer flex items-center gap-1"
                  >
                    <Plus size={10} />
                    <span>Novo Estilo</span>
                  </button>
                </div>

                {/* Vertical Side Tabs Layout */}
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 min-h-[220px]">
                  {/* Left Side: Style Tabs List */}
                  <div className="sm:col-span-4 border-r border-[#2c2c2c] pr-2 space-y-1 max-h-[260px] overflow-y-auto">
                    {artisticStyles.map((style) => (
                      <button
                        key={style.id}
                        type="button"
                        onClick={() => setSelectedStyleTab(style.id)}
                        className={`w-full text-left px-2.5 py-1.5 rounded text-[11px] font-mono transition-all truncate flex items-center justify-between cursor-pointer ${
                          (selectedStyleTab === style.id || (!selectedStyleTab && style.id === artisticStyles[0]?.id))
                            ? "bg-[#D4AF37] text-black font-bold shadow-sm"
                            : "text-stone-300 hover:bg-[#222] hover:text-white"
                        }`}
                      >
                        <span className="truncate">{style.name}</span>
                      </button>
                    ))}
                  </div>

                  {/* Right Side: Editable Panel for Selected Style */}
                  <div className="sm:col-span-8 space-y-3 pl-1">
                    {(() => {
                      const activeStyle = artisticStyles.find(s => s.id === selectedStyleTab) || artisticStyles[0];
                      if (!activeStyle) return <div className="text-xs text-zinc-500 font-mono">Nenhum estilo selecionado.</div>;

                      return (
                        <>
                          <div className="flex items-center justify-between">
                            <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono">
                              Nome do Estilo
                            </label>
                            {activeStyle.id !== "caravaggio" && activeStyle.id !== "urban_realism" && (
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = artisticStyles.filter(s => s.id !== activeStyle.id);
                                  setArtisticStyles(updated);
                                  setSelectedStyleTab(updated[0]?.id || "");
                                  setNotification("Estilo removido com sucesso.");
                                }}
                                className="text-rose-400 hover:text-rose-300 text-[10px] font-mono flex items-center gap-1 cursor-pointer"
                              >
                                <Trash2 size={11} />
                                Excluir
                              </button>
                            )}
                          </div>
                          <input
                            type="text"
                            value={activeStyle.name}
                            onChange={(e) => {
                              setArtisticStyles(artisticStyles.map(s => s.id === activeStyle.id ? { ...s, name: e.target.value } : s));
                            }}
                            className="w-full bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1 text-xs font-serif text-[#D4AF37] focus:border-[#D4AF37] focus:outline-none"
                          />

                          <div>
                            <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block mb-1">
                              Prompt de Diretriz Artística
                            </label>
                            <textarea
                              rows={3}
                              value={activeStyle.prompt}
                              onChange={(e) => {
                                setArtisticStyles(artisticStyles.map(s => s.id === activeStyle.id ? { ...s, prompt: e.target.value } : s));
                              }}
                              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1.5 text-xs text-stone-200 focus:border-[#D4AF37] focus:outline-none font-sans leading-relaxed resize-y"
                              placeholder="Descreva as diretrizes visuais e iluminação deste estilo..."
                            />
                          </div>

                          <div>
                            <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block mb-1">
                              Detecção Contextual / Keywords
                            </label>
                            <input
                              type="text"
                              value={activeStyle.autoDetectKeywords || ""}
                              onChange={(e) => {
                                setArtisticStyles(artisticStyles.map(s => s.id === activeStyle.id ? { ...s, autoDetectKeywords: e.target.value } : s));
                              }}
                              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-2.5 py-1.5 text-xs font-mono text-stone-300 focus:border-[#D4AF37] focus:outline-none"
                              placeholder="ex: favela, cristo, iluminação dramática"
                            />
                          </div>

                          {/* Save & Restore Buttons */}
                          <div className="flex items-center justify-between pt-2 border-t border-[#222]">
                            <button
                              type="button"
                              onClick={() => {
                                try {
                                  localStorage.setItem("ethos_storyboard_artistic_styles", JSON.stringify(artisticStyles));
                                } catch (e) {}
                                setNotification("✓ Estilos Artísticos salvos com sucesso!");
                              }}
                              className="px-3 py-1.5 bg-[#D4AF37] hover:bg-white text-black text-[10px] uppercase font-mono font-bold rounded transition-all cursor-pointer flex items-center gap-1.5"
                            >
                              <Save size={11} />
                              <span>Salvar Estilos</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm("Restaurar estilos padrão de fábrica?")) {
                                  setArtisticStyles(DEFAULT_ARTISTIC_STYLES);
                                  setSelectedStyleTab(DEFAULT_ARTISTIC_STYLES[0].id);
                                  setNotification("✓ Estilos padrões restaurados.");
                                }
                              }}
                              className="text-[9px] text-stone-500 hover:text-stone-300 underline font-mono cursor-pointer"
                            >
                              Restaurar Estilos Padrão
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </div>

            {/* Right Hand: Storage, Backups and Project Info Section */}
            <div className="md:col-span-6 space-y-6">
                <div className="flex items-center gap-2 border-b border-[#333] pb-2">
                  <HardDrive size={14} className="text-[#D4AF37]" />
                  <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-[#D4AF37]">
                    Armazenamento & Cache Local
                  </h3>
                </div>
                
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Gerencie onde e como suas imagens geradas são guardadas localmente para manter o aplicativo rápido e sem travamentos ao digitar.
                </p>

                <div className="space-y-3.5">
                  {/* IndexedDB Toggle */}
                  <div className="flex items-start gap-3 bg-[#0a0a0a] p-3 rounded border border-[#333]/60">
                    <input
                      type="checkbox"
                      id="enable-local-cache"
                      checked={localCacheEnabled}
                      onChange={(e) => setLocalCacheEnabled(e.target.checked)}
                      className="mt-0.5 rounded border-[#333] text-[#D4AF37] focus:ring-[#D4AF37] bg-black cursor-pointer"
                    />
                    <div className="space-y-1">
                      <label htmlFor="enable-local-cache" className="text-xs font-bold text-white cursor-pointer hover:text-[#D4AF37] transition-colors">
                        Ativar Cache em IndexedDB
                      </label>
                      <p className="text-[10px] text-slate-400 leading-normal">
                        Salva as imagens de forma assíncrona no banco de dados do seu navegador para evitar sobrecarregar a memória e eliminar lentidão na escrita.
                      </p>
                    </div>
                  </div>

                  {/* Cache Size Info & Clear */}
                  <div className="bg-black/40 border border-[#222] p-2.5 rounded text-[11px] font-mono space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <span className="text-slate-500 text-[9px] uppercase tracking-wider block">Espaço Usado em Disco</span>
                        <span className="text-[#D4AF37] font-bold text-xs">
                          {isHydrating ? "Calculando..." : `${cacheSizeMB.toFixed(2)} MB`}
                        </span>
                      </div>
                      {!showConfirmClearCache ? (
                        <button
                          type="button"
                          onClick={() => setShowConfirmClearCache(true)}
                          className="px-2.5 py-1.5 border border-rose-950/40 bg-rose-950/10 hover:bg-rose-950/30 text-rose-400 text-[10px] uppercase tracking-wider font-mono rounded transition-all cursor-pointer"
                        >
                          Limpar Cache
                        </button>
                      ) : (
                        <div className="flex flex-col gap-1.5 items-end text-right">
                          <span className="text-[9px] text-rose-300 font-sans block">Apagar todas as imagens cacheadas?</span>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  // Purge browser client cache
                                  await clearCache();

                                  // Purge server-side physical image directory files and legacy autosave JSONs
                                  await fetch("/api/storyboard/projects/clear-cache", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ folder: projectFolder })
                                  }).catch((err) => console.warn("Failed to clear physical server cache:", err));

                                  const clearedScenes = scenes.map(s => ({
                                    ...s,
                                    generatedImageUrl: undefined,
                                    imageVersions: []
                                  }));
                                  setScenes(clearedScenes);
                                  setSessionImageArchive([]);
                                  setLocalStorageItemSafely("ethos_storyboard_scenes", JSON.stringify(clearedScenes));
                                  localStorage.removeItem("ethos_storyboard_image_archive");
                                  setCacheSizeMB(0);
                                  setNotification("✓ Cache físico local e temporários excluídos com êxito!");
                                  setShowConfirmClearCache(false);
                                } catch (err: any) {
                                  setError(`Erro ao limpar cache: ${err.message}`);
                                  setShowConfirmClearCache(false);
                                }
                              }}
                              className="px-2 py-0.5 bg-rose-900 hover:bg-rose-800 text-rose-100 text-[9px] font-mono rounded cursor-pointer uppercase font-bold"
                            >
                              Sim
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowConfirmClearCache(false)}
                              className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-slate-300 text-[9px] font-mono rounded cursor-pointer uppercase"
                            >
                              Não
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Export Options (Option B / Save Mode) */}
                  <div className="space-y-2 pt-1">
                    <span className="text-slate-500 text-[9px] uppercase tracking-wider block font-mono">Método de Salvamento do Projeto</span>
                    
                    <div className="grid grid-cols-1 gap-2">
                      <button
                        type="button"
                        onClick={() => setExportModeOption("complete")}
                        className={`text-left p-2.5 border rounded transition-all cursor-pointer ${
                          exportModeOption === "complete"
                            ? "bg-[#D4AF37]/5 border-[#D4AF37] text-white"
                            : "bg-[#0a0a0a] border-[#333] text-slate-400 hover:border-zinc-500"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold text-white font-mono">Opção A: Pacote Completo (.dmaker)</span>
                          {exportModeOption === "complete" && <Check size={12} className="text-[#D4AF37]" />}
                        </div>
                        <p className="text-[10px] text-slate-400 leading-snug">
                          Inclui todos os dados textuais e embarca todos os arquivos binários de imagem em um Zip único de backup. Perfeito para compartilhar.
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => setExportModeOption("lightweight")}
                        className={`text-left p-2.5 border rounded transition-all cursor-pointer ${
                          exportModeOption === "lightweight"
                            ? "bg-[#D4AF37]/5 border-[#D4AF37] text-white"
                            : "bg-[#0a0a0a] border-[#333] text-slate-400 hover:border-zinc-500"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold text-white font-mono">Opção B: Metadados Ultraleve</span>
                          {exportModeOption === "lightweight" && <Check size={12} className="text-[#D4AF37]" />}
                        </div>
                        <p className="text-[10px] text-slate-400 leading-snug">
                          Exporta apenas os prompts e referências aos arquivos no cache físico do PC. Salvamento instantâneo, com arquivo menor que 10KB!
                        </p>
                      </button>
                    </div>
                  </div>
                </div>

              {/* Backups de Segurança e Auto-Save Panel */}
              <div className="bg-[#161616] border border-[#333] rounded-lg p-5 space-y-4">
                <div className="flex items-center gap-2 border-b border-[#333] pb-2 justify-between">
                  <div className="flex items-center gap-2">
                    <History size={14} className="text-[#D4AF37]" />
                    <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-[#D4AF37]">
                      Backups & Auto-Save
                    </h3>
                  </div>
                  {isAutosaving && (
                    <span className="text-[9px] uppercase tracking-wider font-mono text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-900/30 font-bold shrink-0 animate-pulse">
                      Salvando...
                    </span>
                  )}
                </div>

                <div className="space-y-3">
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Seu progresso é salvo automaticamente no servidor a cada evento importante: <strong>divisão de cenas</strong>, <strong>geração de prompt</strong> e <strong>geração de imagens</strong>. Você pode restaurar qualquer backup anterior em caso de recarregamento ou fechamento acidental da página.
                  </p>

                  {/* Status Auto-save */}
                  <div className="flex items-center justify-between text-[10px] font-mono bg-black/45 p-2.5 rounded border border-zinc-850">
                    <span className="text-slate-500">Último Auto-save:</span>
                    <span className="text-white font-bold flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                      {lastAutosaveTime ? `Às ${lastAutosaveTime}` : "Nenhum nesta sessão"}
                    </span>
                  </div>

                  {/* Backups List */}
                  <div className="space-y-2">
                    <span className="text-slate-500 text-[9px] uppercase tracking-wider block font-mono">Backups Disponíveis no Servidor</span>
                    
                    {availableBackups.length === 0 ? (
                      <p className="text-[10px] font-mono text-zinc-650 italic">Nenhum backup encontrado no servidor.</p>
                    ) : (
                      <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
                        {availableBackups.map((backup) => {
                          const formattedDate = new Date(backup.updatedAt).toLocaleString("pt-BR", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit"
                          });
                          const formattedSize = (backup.size / 1024).toFixed(1);
                          return (
                            <div 
                              key={backup.type} 
                              className="bg-neutral-900/70 hover:bg-neutral-900 border border-zinc-850 p-2.5 rounded flex items-center justify-between transition-colors"
                            >
                              <div className="space-y-0.5">
                                <span className="text-xs font-bold text-white block truncate">{backup.name}</span>
                                <span className="text-[9px] text-stone-500 block font-mono">
                                  {formattedDate} • {formattedSize} KB
                                </span>
                              </div>
                              {confirmRestoreBackup === backup.type ? (
                                <div className="flex flex-col gap-1.5 items-end shrink-0 select-none">
                                  <span className="text-[8px] text-rose-300 font-sans block text-right">Substituir atual?</span>
                                  <div className="flex gap-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        handleRestoreBackup(backup.type);
                                        setConfirmRestoreBackup(null);
                                      }}
                                      className="px-2 py-0.5 bg-rose-900 hover:bg-rose-800 text-rose-100 text-[9px] font-mono rounded cursor-pointer uppercase font-bold"
                                    >
                                      Sim
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmRestoreBackup(null)}
                                      className="px-2 py-0.5 bg-zinc-850 hover:bg-zinc-850 text-slate-300 text-[9px] font-mono rounded cursor-pointer uppercase"
                                    >
                                      Não
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmRestoreBackup(backup.type)}
                                  className="px-2.5 py-1 bg-[#D4AF37]/10 border border-[#D4AF37]/30 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[10px] uppercase font-mono rounded cursor-pointer transition-all shrink-0"
                                  title={`Restaurar ${backup.name}`}
                                >
                                  Restaurar
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Manual instant server save */}
                  <button
                    type="button"
                    disabled={scenes.length === 0}
                    onClick={async () => {
                      try {
                        setIsAutosaving(true);
                        const response = await fetch("/api/storyboard/session", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ scenes, stylePreference }),
                        });
                        if (response.ok) {
                          setNotification("✓ Sessão principal salva no servidor com sucesso!");
                          fetchAvailableBackups();
                        } else {
                          setError("Falha ao salvar sessão manual no servidor.");
                        }
                      } catch (err: any) {
                        setError(`Erro ao salvar no servidor: ${err.message}`);
                      } finally {
                        setIsAutosaving(false);
                      }
                    }}
                    className="w-full py-1.5 border border-[#333] hover:border-[#D4AF37]/60 text-slate-400 hover:text-white bg-[#0a0a0a] text-[10px] uppercase tracking-wider font-mono rounded transition-all cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Save size={11} className="text-[#D4AF37]" />
                    <span>Salvar Backup Instantâneo</span>
                  </button>
                </div>
              </div>

              {/* Export and Action Panel */}
              {scenes.length > 0 && (
                <div className="bg-[#161616] border border-[#333] rounded-lg p-5 space-y-4">
                  <div className="flex items-center gap-2 border-b border-[#333] pb-2">
                    <Download size={14} className="text-[#D4AF37]" />
                    <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-[#D4AF37]">
                      Exportar Storyboard
                    </h3>
                  </div>
                  
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Baixe todos os resultados criados na sua sessão atual em formatos organizados de imagem ou texto.
                  </p>

                  <div className="flex flex-col gap-2.5 pt-1">
                    {/* Baixar Todas as Imagens (ZIP) */}
                    <button
                      type="button"
                      onClick={handleDownloadAllImages}
                      disabled={isDownloadingZip || !scenes.some(s => s.generatedImageUrl)}
                      className="w-full py-2 border-2 border-[#D4AF37] bg-[#D4AF37]/20 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[10px] uppercase tracking-widest font-mono font-bold rounded transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(212,175,55,0.05)] hover:shadow-[0_0_18px_rgba(212,175,55,0.3)]"
                      title="Baixar todas as imagens criadas para essa sessão completa em um arquivo ZIP"
                    >
                      {isDownloadingZip ? (
                        <>
                          <Loader2 className="animate-spin text-[#D4AF37]" size={12} />
                          <span>Baixando Imagens...</span>
                        </>
                      ) : (
                        <>
                          <Download size={12} className="text-[#D4AF37]" />
                          <span>Baixar Todas as Imagens (ZIP)</span>
                        </>
                      )}
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      {/* Export TXT */}
                      <button
                        onClick={handleExportToTXT}
                        className="py-2 border border-[#333] text-[10px] uppercase tracking-widest text-[#D4AF37]/90 bg-neutral-900/40 hover:bg-[#D4AF37]/10 cursor-pointer font-mono font-bold rounded transition-all flex items-center justify-center gap-1.5"
                        title="Exportar lista de prompts"
                      >
                        <FileText size={11} />
                        <span>Export Prompts</span>
                      </button>

                      {/* Export CSV */}
                      <button
                        onClick={handleExportToCSV}
                        className="py-2 text-[10px] uppercase tracking-widest bg-zinc-800 hover:bg-[#D4AF37] hover:text-black text-white font-mono font-bold rounded cursor-pointer transition-all flex items-center justify-center gap-1.5"
                        title="Exportar planilha"
                      >
                        <span>CSV</span>
                      </button>
                    </div>

                    {/* NLE Export Buttons (XML & EDL) & Mid-Project Audio Upload */}
                    <div className="pt-2 border-t border-[#333]/60 space-y-2">
                      <span className="text-[9px] font-mono uppercase tracking-widest text-[#D4AF37] font-bold block">
                        🎬 Exportar Timeline NLE & Narração
                      </span>

                      <input
                        ref={midProjectAudioInputRef}
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={handleMidProjectAudioUpload}
                      />

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => midProjectAudioInputRef.current?.click()}
                          className="flex-1 py-2 bg-[#222] hover:bg-[#333] border border-[#D4AF37]/40 hover:border-[#D4AF37] text-[#D4AF37] text-[10px] uppercase tracking-widest font-mono font-bold rounded transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-md"
                          title="Anexar ou alinhar arquivo de narração em áudio para calcular timecodes exatos"
                        >
                          <Mic size={12} />
                          <span>{audioNarrationUrl ? "🎙️ Substituir Áudio" : "🎙️ Anexar Narração"}</span>
                        </button>

                        {audioNarrationUrl && (
                          <button
                            type="button"
                            onClick={handleResyncCurrentProjectAudio}
                            className="py-2 px-3 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black border border-[#D4AF37]/60 text-[#D4AF37] text-[10px] uppercase tracking-widest font-mono font-bold rounded transition-all cursor-pointer flex items-center justify-center gap-1 shadow-md"
                            title="Corrigir e re-alinhar todos os timecodes do projeto atual com o novo algoritmo N-Gram"
                          >
                            <RefreshCw size={12} />
                            <span>Re-sincronizar TC</span>
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={handleExportXML}
                          className="py-2 border border-[#D4AF37]/50 text-[10px] uppercase tracking-widest text-[#D4AF37] bg-neutral-900/60 hover:bg-[#D4AF37] hover:text-black cursor-pointer font-mono font-bold rounded transition-all flex items-center justify-center gap-1"
                          title="Exportar timeline XML para Premiere, DaVinci Resolve ou Final Cut Pro"
                        >
                          <span>FCP / Premiere XML</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleExportEDL}
                          className="py-2 border border-[#D4AF37]/50 text-[10px] uppercase tracking-widest text-[#D4AF37] bg-neutral-900/60 hover:bg-[#D4AF37] hover:text-black cursor-pointer font-mono font-bold rounded transition-all flex items-center justify-center gap-1"
                          title="Exportar Edit Decision List (.edl) padrão CMX 3600"
                        >
                          <span>Timeline EDL</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Quick Stats Summary Panel of the Project */}
              <div className="bg-[#161616] border border-[#333] rounded-lg p-5 space-y-4">
                <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-[#D4AF37] border-b border-[#333] pb-2">
                  Informações do Projeto
                </h3>
                
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div className="bg-[#0a0a0a] p-3 rounded border border-[#333]/60">
                    <span className="text-slate-500 block text-[9px] uppercase tracking-wider font-mono">Quadros Identificados</span>
                    <span className="text-xl font-light text-[#E0D8D0] font-serif block mt-1">
                      {scenes.length}
                    </span>
                  </div>
                  <div className="bg-[#0a0a0a] p-3 rounded border border-[#333]/60">
                    <span className="text-slate-500 block text-[9px] uppercase tracking-wider font-mono">Estilo Padrão</span>
                    <span className="text-xs font-light text-[#E0D8D0] block mt-2 font-mono text-[#D4AF37] truncate">
                      {stylePreference === "auto" ? "Inteligente" : stylePreference === "caravaggio" ? "Caravaggio" : "Realismo BR"}
                    </span>
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 bg-black/30 p-2.5 rounded border border-[#333]/40 space-y-1 font-mono">
                  <div className="flex justify-between">
                    <span>Direção de Arte:</span>
                    <span className="text-[#D4AF37]">Habilitada</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Idiomas dos Prompts:</span>
                    <span className="text-white">Inglês</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Fidelidade de Aspecto:</span>
                    <span className="text-white">16:9 Cinema</span>
                  </div>
                </div>

                <div className="space-y-2 pt-2">
                  <button
                    type="button"
                    onClick={handleManualRestoreSession}
                    className="w-full py-2 border border-[#D4AF37]/35 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[9px] uppercase tracking-widest font-mono font-bold rounded transition-all cursor-pointer flex items-center justify-center gap-1.5"
                    title="Tentar recuperar a sessão de filmagem anterior imediatamente gravada no servidor"
                  >
                    <RefreshCw size={11} />
                    <span>Resgatar Sessão Anterior</span>
                  </button>

                  {scenes.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      {!showConfirmClear ? (
                        <button
                          type="button"
                          onClick={() => setShowConfirmClear(true)}
                          className="w-full py-2 border border-rose-950/40 bg-rose-950/10 hover:bg-rose-950/35 text-rose-400 text-[9px] uppercase tracking-widest font-mono font-bold rounded transition-all cursor-pointer"
                          title="Limpar storyboard e começar do zero"
                        >
                          Limpar toda a Sessão
                        </button>
                      ) : (
                        <div className="bg-rose-950/20 border border-rose-900/30 rounded p-2.5 space-y-2 animate-fadeIn text-center">
                          <p className="text-[10px] text-rose-300 font-sans leading-normal">
                            Tem certeza que deseja apagar o storyboard atual?
                          </p>
                          <div className="flex gap-2 justify-center">
                            <button
                              type="button"
                              onClick={handleClearSession}
                              className="px-2.5 py-1 bg-rose-900 hover:bg-rose-800 text-rose-100 text-[9px] font-mono font-bold rounded cursor-pointer uppercase tracking-wider"
                            >
                              Sim, Limpar
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowConfirmClear(false)}
                              className="px-2.5 py-1 bg-[#222] hover:bg-[#333] text-slate-300 text-[9px] font-mono rounded cursor-pointer uppercase tracking-wider"
                            >
                              Voltar
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>
        ) : (
          /* First Page: Interactive Storyboard Flow */
          <div className="max-w-[1600px] w-full mx-auto flex flex-col space-y-5 animate-fadeIn">
            
            {/* Section banner indicator */}
            <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-[#333] pb-4 gap-4 shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-4 bg-[#D4AF37]"></div>
                <h2 className="text-base sm:text-lg font-light text-[#D4AF37] italic font-serif">
                  Sequência de Gravação Interativa
                </h2>
              </div>
              <div className="flex items-center gap-3.5 flex-wrap">
                <span className="text-[10px] text-[#D4AF37] font-mono tracking-widest uppercase">{scenes.length} {scenes.length === 1 ? "Cena Carregada" : "Cenas Identificadas"}</span>
              </div>
            </div>

            {/* Interactive Alerts or Errors */}
            {error && (
              <div className="bg-rose-950/40 border border-rose-900/60 text-rose-300 p-4 rounded text-xs flex items-start gap-2.5 animate-fadeIn">
                <AlertCircle size={16} className="text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="block font-bold">Inconveniente de Processamento:</strong>
                  <p className="mt-1 text-slate-350 leading-relaxed">{error}</p>
                  <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                    <button 
                      onClick={() => setError(null)} 
                      className="px-2.5 py-1 bg-rose-900/50 hover:bg-rose-900 text-rose-100 text-[9px] uppercase tracking-wider rounded font-mono font-bold cursor-pointer"
                    >
                      Ignorar Aviso
                    </button>

                    <button 
                      onClick={handleFetchLogs} 
                      className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-[#D4AF37] text-[9px] uppercase tracking-wider rounded font-mono font-bold cursor-pointer flex items-center gap-1"
                    >
                      <FileText size={10} />
                      <span>📄 Ver Logs de Erro do Servidor</span>
                    </button>

                    <p className="text-[10px] text-slate-400/80 leading-normal italic ml-1">
                      Configure a GEMINI_API_KEY no menu Secrets se necessário.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Quick notification bubble */}
            {notification && (
              <div className="bg-zinc-900 text-[#D4AF37] border border-[#D4AF37]/45 text-[11px] px-4 py-2.5 rounded shadow-lg font-mono tracking-wide flex items-center justify-between animate-fadeIn shrink-0">
                <div className="flex items-center gap-2">
                  <Info size={14} className="text-[#D4AF37]" />
                  <span>{notification}</span>
                </div>
                <button 
                  onClick={() => setNotification(null)} 
                  className="text-xs hover:text-white px-1 cursor-pointer font-bold"
                >
                  ×
                </button>
              </div>
            )}

            {/* Card Flow List */}
            {scenes.length > 0 ? (
              <div className="space-y-6 flex-1 pr-1 pb-16 overflow-y-visible">
                {scenes.map((scene, index) => (
                  <div
                    key={`${scene.id}-${index}`}
                    id={`scene-card-${scene.id}`}
                    data-scene-card="true"
                    data-scene-number={scene.sceneNumber || String(index + 1)}
                    data-scene-index={index}
                    onClickCapture={() => setFocusedSceneId(scene.id)}
                    onFocusCapture={() => setFocusedSceneId(scene.id)}
                    className={`transition-all duration-300 rounded-lg ${
                      focusedSceneId === scene.id ? "ring-2 ring-[#D4AF37]/50 shadow-[0_0_15px_rgba(212,175,55,0.1)]" : ""
                    }`}
                  >
                    <StoryboardCard
                      scene={scene}
                      index={index}
                      totalScenes={scenes.length}
                      onUpdate={handleUpdateScene}
                      onSplit={handleSplitScene}
                      onMerge={handleMergeScene}
                      onRegenerate={handleRegenerateScene}
                      onDelete={handleDeleteScene}
                      onMoveUp={handleMoveUp}
                      onMoveDown={handleMoveDown}
                      isRegenerating={scene.promptQueueStatus === "generating"}
                      isQueued={scene.promptQueueStatus === "queued"}
                      isStudioOpen={activeStudioSceneId === scene.id}
                      onOpenStudio={() => {
                        setFocusedSceneId(scene.id);
                        setActiveStudioSceneId(scene.id);
                      }}
                      onCloseStudio={() => setActiveStudioSceneId(null)}
                      stylePreference={stylePreference}
                      customApiKey={customApiKey}
                      openAiKey={openAiKey}
                      openAiDalleModel={openAiDalleModel}
                      onCancelRender={handleCancelRender}
                      consecutiveNumbering={consecutiveNumbering}
                      onToggleConsecutiveNumbering={(val) => {
                        pushToHistory();
                        setConsecutiveNumbering(val);
                        setNotification(val ? "Numeração linear contínua ativada." : "Subnumeração hierárquica ativada.");
                      }}
                      connectionGroups={connectionGroups}
                      isConnectionMode={isConnectionMode}
                      selectedSceneIdsForConnection={selectedSceneIdsForConnection}
                      onToggleSceneSelection={handleToggleSceneSelection}
                      scenes={scenes}
                      availableModels={availableModels}
                      ollamaModels={ollamaModels}
                      audioNarrationUrl={audioNarrationUrl}
                      fps={24}
                    />
                  </div>
                ))}

                {/* Add blank button helper block at the bottom */}
                <div className="pt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={handleAddBlankScene}
                    className="px-5 py-3 border border-[#333] hover:border-[#D4AF37]/50 bg-[#161616]/40 text-[10px] tracking-[0.2em] font-mono text-slate-400 uppercase rounded hover:text-white transition-all flex items-center gap-2 cursor-pointer shadow-lg hover:shadow-[#D4AF37]/5"
                  >
                    <Plus size={13} className="text-[#D4AF37]" />
                    <span>Inserir Quadro Manual de Transição</span>
                  </button>
                </div>
              </div>
            ) : isGenerating ? (
              /* Active audio transcription / script generation loading screen */
              <div className="border border-[#D4AF37]/35 rounded-lg p-12 text-center my-auto flex flex-col items-center justify-center max-w-xl mx-auto py-20 bg-[#121212]/80 mt-12 animate-fadeIn shadow-2xl">
                <div className="w-16 h-16 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/40 flex items-center justify-center text-[#D4AF37] mb-6 animate-pulse">
                  <Loader2 size={32} className="animate-spin text-[#D4AF37]" />
                </div>
                <h3 className="text-lg font-serif italic text-white mb-2">Processando Narração e Roteiro...</h3>
                <p className="text-xs text-[#D4AF37] font-mono leading-relaxed mb-4">
                  {notification || "Transcrevendo voz via IA e estruturando cenas cinematográficas 16:9..."}
                </p>
                <div className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase animate-pulse">
                  Aguarde enquanto os timecodes e cartelas são alocados...
                </div>
              </div>
            ) : (
              /* Pristine empty placeholder */
              <div className="border border-dashed border-[#333] rounded-lg p-12 text-center my-auto flex flex-col items-center justify-center max-w-xl mx-auto py-24 bg-[#161616]/20 mt-12">
                <div className="w-16 h-16 rounded-full bg-[#111] border border-[#D4AF37]/20 flex items-center justify-center text-[#D4AF37]/75 mb-6 shadow-radial">
                  <Film size={26} />
                </div>
                <h3 className="text-lg font-serif italic text-white mb-2">Aguardando Direção de Filme</h3>
                <p className="text-xs text-slate-500 max-w-sm leading-relaxed mb-6 font-sans">
                  Seu storyboard ainda não foi projetado. Abra o painel de <strong className="text-[#D4AF37] font-semibold">Roteiro e Configurações</strong> no topo para colar seu texto e começar!
                </p>
                <button
                  onClick={() => setActiveView("config")}
                  className="px-6 py-3 bg-[#D4AF37] text-black font-bold uppercase tracking-wider text-xs rounded-md hover:bg-white transition-colors duration-200 cursor-pointer mb-6"
                >
                  📝 Abrir Roteiro e Configurações
                </button>
                
                <div className="flex flex-wrap justify-center gap-2 text-[10px] font-mono text-[#D4AF37]/70 uppercase tracking-widest bg-black/40 px-4 py-2 border border-[#333] rounded">
                  <span>Barroco ou</span>
                  <span>• Cotidiano Brasileiro •</span>
                  <span>Proporção 16:9</span>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Exquisite Footer */}
      <footer className="h-12 border-t border-[#D4AF37]/15 flex flex-col sm:flex-row items-center justify-between px-6 sm:px-10 text-[9px] uppercase tracking-[0.15em] opacity-50 shrink-0 bg-[#0F0F0F] gap-2 pt-2 sm:pt-0 pb-2 sm:pb-0 font-mono">
        <div>Ready with Gemini Art Director Pro</div>
        <div className="flex gap-4 sm:gap-8 text-center">
          <span>Medieval Caravaggio Styling</span>
          <span className="hidden md:inline">•</span>
          <span>Urban Brazilian Realism</span>
          <span className="hidden md:inline">•</span>
          <span>Meditation Storytelling Pipeline</span>
        </div>
      </footer>

      {/* New Project Wizard Modal Overlay */}
      {showNewProjectModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 sm:p-6 overflow-y-auto animate-fadeIn">
          <div className="bg-[#121212] border border-[#D4AF37]/45 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl relative flex flex-col animate-scaleUp">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
              <div className="flex items-center gap-2.5">
                <Plus className="text-[#D4AF37]" size={18} />
                <h3 className="text-sm font-serif tracking-widest uppercase text-[#D4AF37] font-semibold">
                  Iniciar Novo Projeto
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowNewProjectModal(false)}
                className="text-slate-400 hover:text-white text-xl font-bold cursor-pointer transition-colors p-1"
                title="Fechar"
              >
                &times;
              </button>
            </div>
            
            {/* Content / Form */}
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!newProjectDate) {
                setNewProjectModalError("Por favor, preencha a data do diário.");
                return;
              }
              
              // Clear state, caches, and trigger generation
              setScenes([]);
              setSessionImageArchive([]);
              setScriptText(newProjectScript);
              setSelectedStyle(newProjectStyle);
              setScriptReferenceImage(newProjectStyleRefImage);
              setDiaryDate(newProjectDate);
              setSaveVersion(1);
              
              // format: DEMB_AAMMDD_V01
              const formatDiaryDate = (dateStr: string): string => {
                if (!dateStr) return "";
                const parts = dateStr.split("-");
                if (parts.length === 3) {
                  const year = parts[0].slice(-2);
                  const month = parts[1];
                  const day = parts[2];
                  return `${year}${month}${day}`;
                }
                return "";
              };
              
              const formattedDate = formatDiaryDate(newProjectDate);
              const initialProjectName = `DEMB_${formattedDate}_V01`;
              setProjectName(initialProjectName);

              try {
                await clearCache();
                setCacheSizeMB(0);
              } catch (err) {
                console.warn("Failed to clear cache for new project:", err);
              }

              try {
                localStorage.setItem("ethos_storyboard_scenes", "[]");
                localStorage.setItem("ethos_storyboard_image_archive", "[]");
                localStorage.setItem("ethos_storyboard_script_text", newProjectScript);
                localStorage.setItem("ethos_storyboard_selected_style", newProjectStyle);
                localStorage.setItem("ethos_storyboard_project_name", initialProjectName);
                localStorage.setItem("ethos_storyboard_diary_date", newProjectDate);
                localStorage.setItem("ethos_storyboard_save_version", "1");
                if (newProjectStyleRefImage) {
                  localStorage.setItem("ethos_storyboard_script_reference_image", newProjectStyleRefImage);
                } else {
                  localStorage.removeItem("ethos_storyboard_script_reference_image");
                }
              } catch (_) {}

              // Notify legacy backend
              fetch("/api/storyboard/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                  scenes: [], 
                  stylePreference: "auto",
                  projectName: initialProjectName,
                  scriptText: newProjectScript,
                  diaryDate: newProjectDate,
                  saveVersion: 1
                }),
              }).catch((err) => console.warn("Failed to initialize server session for new project:", err));

              setShowNewProjectModal(false);

              if (newProjectAudioFile || newProjectScript.trim()) {
                handleGenerateStoryboardWithAudio({
                  text: newProjectScript.trim(),
                  style: newProjectStyle,
                  referenceImage: newProjectStyleRefImage,
                  selectedEngine: newProjectEngine,
                  audioFile: newProjectAudioFile,
                  audioFileName: newProjectAudioFileName,
                  explicitProjectName: initialProjectName
                });
                setActiveView("storyboard");
              } else {
                setNotification(`✓ Novo projeto "${initialProjectName}" criado com sucesso!`);
                setActiveView("storyboard");
              }
            }} className="p-6 space-y-5">
              
              {newProjectModalError && (
                <div className="p-3 bg-rose-950/30 border border-rose-900/50 rounded text-rose-300 text-xs font-mono">
                  ⚠ {newProjectModalError}
                </div>
              )}
              
              {/* Date Input */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-wider text-slate-400 font-mono block">
                  Data do Diário (Obrigatório)
                </label>
                <input
                  type="date"
                  value={newProjectDate}
                  onChange={(e) => setNewProjectDate(e.target.value)}
                  required
                  className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 text-xs font-mono text-white focus:border-[#D4AF37] focus:outline-none transition-all cursor-pointer"
                />
                <p className="text-[10px] text-zinc-500 font-sans leading-relaxed">
                  A data informada definirá automaticamente o nome do arquivo compactado ao salvar (ex: <code className="text-stone-300">DEMB_YYMMDD_V01.dmaker</code>).
                </p>
              </div>

              {/* Audio Upload Dropzone */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-wider text-[#D4AF37] font-mono font-bold block flex items-center gap-1.5">
                  <Mic size={12} className="text-[#D4AF37]" />
                  <span>Narração em Áudio (MP3 / WAV) - Opcional</span>
                </label>
                <div className="p-3 bg-[#0a0a0a] border border-[#333] hover:border-[#D4AF37]/40 rounded flex items-center justify-between gap-3 transition-colors">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-full bg-[#D4AF37]/10 text-[#D4AF37]">
                      <Mic size={16} />
                    </div>
                    <div>
                      <span className="text-[11px] font-bold text-stone-200 block font-mono">
                        {newProjectAudioFileName ? `🎙️ ${newProjectAudioFileName}` : "Anexar Arquivo de Narração em Áudio"}
                      </span>
                      <span className="text-[9px] text-zinc-400 block">
                        {newProjectAudioFileName ? "Áudio carregado. O DiarioMaker vai transcrever a voz e alinhar os timecodes." : "Transcreve a voz automaticamente e gera as cenas com timecodes exatos."}
                      </span>
                    </div>
                  </div>

                  <input
                    ref={newProjectAudioInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        const file = e.target.files[0];
                        setNewProjectAudioFile(file);
                        setNewProjectAudioFileName(file.name);
                      }
                    }}
                  />

                  {newProjectAudioFileName ? (
                    <button
                      type="button"
                      onClick={() => {
                        setNewProjectAudioFile(null);
                        setNewProjectAudioFileName(undefined);
                        if (newProjectAudioInputRef.current) newProjectAudioInputRef.current.value = "";
                      }}
                      className="px-2.5 py-1 rounded bg-rose-950/60 hover:bg-rose-900 border border-rose-800 text-rose-300 text-[9px] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer"
                    >
                      Remover
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => newProjectAudioInputRef.current?.click()}
                      className="px-3 py-1.5 rounded bg-[#222] hover:bg-[#333] border border-[#444] text-[#D4AF37] hover:border-[#D4AF37] text-[10px] font-mono font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shadow-md"
                    >
                      <Upload size={11} />
                      <span>Escolher Áudio</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Script Input */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-wider text-slate-400 font-mono block">
                  Roteiro / Instruções iniciais {newProjectAudioFileName ? "(Opcional se houver áudio)" : ""}
                </label>
                <textarea
                  value={newProjectScript}
                  onChange={(e) => setNewProjectScript(e.target.value)}
                  placeholder={newProjectAudioFileName ? "Deixe em branco para transcrição 100% automática do áudio..." : "Cole aqui o roteiro de meditação ou instruções cotidianas do diário..."}
                  rows={4}
                  className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 text-xs text-white placeholder-zinc-700 focus:border-[#D4AF37] focus:outline-none transition-all leading-relaxed resize-y font-sans"
                />
              </div>

              {/* Style preference input */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-wider text-slate-400 font-mono block">
                  Direção de Arte / Estilo Visual
                </label>
                <select
                  value={newProjectStyle}
                  onChange={(e) => setNewProjectStyle(e.target.value as StylePreference)}
                  className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 text-xs font-mono text-white focus:border-[#D4AF37] focus:outline-none transition-all cursor-pointer"
                >
                  <option value="auto">Auto (Direção de Arte Inteligente baseada no texto)</option>
                  <option value="caravaggio">Medieval Caravaggio (Barroco Claro-Escuro)</option>
                  <option value="urban_realism">Cotidiano Brasileiro (Realismo de Rua)</option>
                </select>
              </div>

              {/* AI Engine Selector for Segmenter */}
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-wider text-slate-400 font-mono block">
                  Motor de IA para Segmentação do Roteiro
                </label>
                <div className="grid grid-cols-2 gap-2 bg-[#0A0A0A] p-1 border border-[#333] rounded">
                  <button
                    type="button"
                    onClick={() => setNewProjectEngine("gemini")}
                    className={`text-[10px] py-2 px-1 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer text-center ${
                      newProjectEngine === "gemini"
                        ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] shadow-sm"
                        : "text-slate-400 hover:text-white hover:bg-[#161616]"
                    }`}
                  >
                    Gemini 3.5 Flash (Recomendado)
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewProjectEngine("openai")}
                    className={`text-[10px] py-2 px-1 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer text-center ${
                      newProjectEngine === "openai"
                        ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] shadow-sm"
                        : "text-slate-400 hover:text-white hover:bg-[#161616]"
                    }`}
                  >
                    ChatGPT (Requer OpenAI Key)
                  </button>
                </div>
                {newProjectEngine === "openai" && !openAiKey && (
                  <p className="text-[9px] text-rose-400 font-mono">
                    ⚠️ Chave OpenAI ausente em Conexões! Configure a chave nas configurações de conexões primeiro ou use o Gemini.
                  </p>
                )}
              </div>

              {/* Shortcut scripts presets */}
              <div className="space-y-2 border-t border-zinc-850 pt-3">
                <span className="text-[9px] uppercase tracking-wider text-slate-500 font-mono block">
                  Modelos de Exemplo (Clique para preencher)
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {SAMPLE_SCRIPTS.map((sample, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setNewProjectScript(sample.text);
                        // Map category to StylePreference
                        const styleMap: Record<string, StylePreference> = {
                          "biblical": "caravaggio",
                          "modern": "urban_realism"
                        };
                        setNewProjectStyle(styleMap[sample.category] || "auto");
                        setNotification(`Exemplo "${sample.title}" carregado no formulário!`);
                      }}
                      className="text-left p-2.5 bg-black/40 border border-[#222] hover:border-[#D4AF37]/40 rounded hover:bg-black/60 transition-all cursor-pointer"
                    >
                      <div className="text-[11px] font-bold text-[#D4AF37] truncate mb-0.5">{sample.title}</div>
                      <div className="text-[9px] text-slate-400 truncate uppercase font-mono">{sample.styleLabel}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Footer Buttons */}
              <div className="flex justify-end gap-3 border-t border-zinc-850 pt-4 mt-2">
                <button
                  type="button"
                  onClick={() => setShowNewProjectModal(false)}
                  className="px-4 py-2 border border-[#333] bg-transparent hover:bg-zinc-900 text-slate-400 hover:text-white text-[10px] uppercase tracking-wider font-mono rounded transition-all cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[#D4AF37] text-black hover:bg-white text-[10px] uppercase tracking-wider font-mono font-bold rounded transition-all cursor-pointer flex items-center gap-1.5"
                >
                  <Film size={11} />
                  <span>Criar Novo Projeto</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Complete Script Dialog / Modal Overlay */}
      {showScriptModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 sm:p-6 overflow-y-auto animate-fadeIn">
          <div className="bg-[#121212] border border-[#D4AF37]/45 rounded-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto shadow-2xl relative flex flex-col animate-scaleUp">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
              <div className="flex items-center gap-2.5">
                <FileText className="text-[#D4AF37]" size={18} />
                <h3 className="text-sm font-serif tracking-widest uppercase text-[#D4AF37] font-semibold">
                  Roteiro do Projeto Ativo
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowScriptModal(false)}
                className="text-slate-400 hover:text-white text-xl font-bold cursor-pointer transition-colors p-1"
                title="Fechar Roteiro"
              >
                &times;
              </button>
            </div>
            {/* Content */}
            <div className="p-6">
              <ScriptInputArea 
                onGenerate={(text, style, referenceImage, selectedEngine) => {
                  handleGenerateStoryboard(text, style, referenceImage, selectedEngine);
                  setShowScriptModal(false);
                }} 
                onGenerateWithAudio={(params) => {
                  handleGenerateStoryboardWithAudio(params);
                  setShowScriptModal(false);
                }}
                isGenerating={isGenerating} 
                scriptText={scriptText}
                setScriptText={setScriptText}
                selectedStyle={selectedStyle}
                setSelectedStyle={setSelectedStyle}
                scriptReferenceImage={scriptReferenceImage}
                setScriptReferenceImage={setScriptReferenceImage}
                hasScenes={scenes.length > 0}
                useOpenAiForPrompts={useOpenAiForPrompts}
                openAiKey={openAiKey}
                artisticStyles={artisticStyles}
                onGoToSettings={() => {
                  setActiveView("config");
                  setShowScriptModal(false);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Clear Cache Confirmation Modal */}
      {showClearCacheModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-fadeIn">
          <div className="bg-[#121212] border border-[#D4AF37]/45 rounded-xl max-w-md w-full p-6 shadow-2xl relative flex flex-col space-y-4 animate-scaleUp text-center">
            <div className="w-12 h-12 rounded-full bg-rose-950/30 border border-rose-900/40 flex items-center justify-center text-rose-400 mx-auto">
              <Trash2 size={20} />
            </div>
            
            <h3 className="text-sm font-serif tracking-widest uppercase text-white font-semibold">
              Limpar Cache de Imagens?
            </h3>
            
            <p className="text-xs text-slate-400 leading-relaxed font-sans">
              Esta ação apagará todas as imagens guardadas temporariamente no seu navegador para liberar espaço. 
              O texto das cenas será preservado, mas as imagens precisarão ser carregadas/geradas novamente.
            </p>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowClearCacheModal(false)}
                className="flex-1 py-2 border border-[#333] bg-transparent hover:bg-zinc-900 text-slate-400 hover:text-white text-[10px] uppercase tracking-wider font-mono rounded transition-all cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await clearCache();
                    const clearedScenes = scenes.map(s => ({
                      ...s,
                      generatedImageUrl: undefined,
                      imageVersions: []
                    }));
                    setScenes(clearedScenes);
                    setSessionImageArchive([]);
                    setLocalStorageItemSafely("ethos_storyboard_scenes", JSON.stringify(clearedScenes));
                    localStorage.removeItem("ethos_storyboard_image_archive");
                    setCacheSizeMB(0);
                    setNotification("✓ Cache de imagens locais limpo com sucesso!");
                    setShowClearCacheModal(false);
                  } catch (err: any) {
                    setError(`Erro ao limpar cache: ${err.message}`);
                    setShowClearCacheModal(false);
                  }
                }}
                className="flex-1 py-2 bg-rose-900 hover:bg-rose-800 text-rose-100 text-[10px] uppercase tracking-wider font-mono font-bold rounded transition-all cursor-pointer"
              >
                Confirmar e Limpar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Server Logs Viewer Modal */}
      {showLogsModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 sm:p-6 overflow-y-auto animate-fadeIn">
          <div className="bg-[#121212] border border-[#D4AF37]/50 rounded-xl max-w-4xl w-full max-h-[85vh] overflow-y-auto shadow-2xl relative flex flex-col animate-scaleUp font-mono">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
              <div className="flex items-center gap-2.5">
                <FileText className="text-[#D4AF37]" size={18} />
                <h3 className="text-sm font-mono tracking-widest uppercase text-[#D4AF37] font-bold">
                  Logs de Erro do Servidor
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowLogsModal(false)}
                className="text-slate-400 hover:text-white text-xl font-bold cursor-pointer transition-colors p-1"
                title="Fechar Logs"
              >
                &times;
              </button>
            </div>
            <div className="p-6 bg-black/90 text-zinc-300 text-xs overflow-x-auto whitespace-pre-wrap font-mono font-normal leading-relaxed border-b border-zinc-800 max-h-[60vh]">
              {logsText || "Nenhum erro registrado até o momento."}
            </div>
            <div className="px-6 py-4 flex items-center justify-between shrink-0 bg-neutral-900/50">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(logsText);
                  setNotification("✓ Logs copiados para a área de transferência!");
                }}
                className="px-4 py-2 border border-[#D4AF37]/40 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[#D4AF37] text-[10px] uppercase tracking-wider font-mono font-bold rounded transition-all cursor-pointer flex items-center gap-1.5"
              >
                <Copy size={11} />
                <span>Copiar Logs</span>
              </button>
              <button
                type="button"
                onClick={() => setShowLogsModal(false)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] uppercase tracking-wider font-mono font-bold rounded transition-all cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Immersive Session Image Gallery Modal */}
      {isGalleryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 sm:p-6 md:p-8 animate-fadeIn">
          <div className="bg-[#121212] border border-[#D4AF37]/25 rounded-xl max-w-6xl w-full h-[85vh] flex flex-col shadow-[0_0_50px_rgba(212,175,55,0.15)] animate-scaleUp overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#333]/60 bg-black/40 shrink-0">
              <div className="flex items-center gap-2">
                <History className="text-[#D4AF37]" size={18} />
                <div>
                  <h2 className="text-sm font-mono font-bold tracking-widest uppercase text-[#D4AF37]">
                    Acervo Imagens da Sessão
                  </h2>
                  <p className="text-[10px] text-slate-400 font-sans mt-0.5 leading-none">
                    Todas as imagens geradas, refinadas ou preservadas nesta sessão.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsGalleryOpen(false)}
                className="p-1 rounded bg-[#222] hover:bg-rose-950 text-slate-400 hover:text-rose-400 cursor-pointer transition-colors"
                title="Fechar Acervo"
              >
                <X size={16} />
              </button>
            </div>

            {/* Gallery Grid Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-thin">
              {/* Active Scenes Collection */}
              <div className="space-y-6">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-slate-400 border-b border-[#222] pb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  Cenas Ativas no Storyboard ({scenes.length})
                </h3>

                {scenes.length === 0 ? (
                  <p className="text-xs text-slate-500 italic font-sans pl-2">
                    Nenhuma cena ativa para exibir fotos.
                  </p>
                ) : (
                  scenes.map((scene, idx) => {
                    const sceneImages = getImagesForScene(scene.id);
                    if (sceneImages.length === 0) return null;

                    return (
                      <div key={`active-scene-group-${scene.id}-${idx}`} className="bg-black/40 border border-[#222] rounded-lg p-4 space-y-3">
                        {/* Scene Header */}
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <span className="text-[10px] uppercase font-mono font-bold text-[#D4AF37] tracking-wider px-1.5 py-0.5 bg-[#D4AF37]/10 rounded border border-[#D4AF37]/20">
                              Cena {scene.sceneNumber || (idx + 1)}
                            </span>
                            <p className="text-xs text-slate-300 mt-1.5 line-clamp-1 italic font-serif">
                              "{scene.text}"
                            </p>
                          </div>
                          <span className="text-[10px] font-mono text-slate-500 shrink-0">
                            {sceneImages.length} {sceneImages.length === 1 ? "foto" : "fotos"}
                          </span>
                        </div>

                        {/* Images Grid for this Active Scene */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                          {sceneImages.map((img, imgIdx) => {
                            const isActiveInScene = scene.generatedImageUrl === img.url;
                            return (
                              <div
                                key={`${img.id}-${imgIdx}`}
                                className={`relative group border rounded-lg overflow-hidden bg-black aspect-video flex flex-col ${
                                  isActiveInScene
                                    ? "border-[#D4AF37] ring-1 ring-[#D4AF37]/35"
                                    : "border-[#222] hover:border-[#333]"
                                }`}
                              >
                                {/* Image display */}
                                <img
                                  src={img.url}
                                  alt="Preview"
                                  className="w-full h-full object-cover select-none pointer-events-none"
                                  referrerPolicy="no-referrer"
                                />

                                {/* Active badge on top right */}
                                {isActiveInScene && (
                                  <span className="absolute top-1.5 right-1.5 bg-emerald-500 text-black text-[8px] font-mono font-bold uppercase px-1 py-0.5 rounded shadow">
                                    Ativa
                                  </span>
                                )}

                                {/* Hover action sheet */}
                                <div className="absolute inset-0 bg-black/95 opacity-0 group-hover:opacity-100 flex flex-col justify-between p-2.5 transition-all duration-200">
                                  {/* Top part: details */}
                                  <div className="text-[9px] font-mono text-slate-400 space-y-0.5 leading-normal">
                                    <div className="text-slate-300 flex justify-between">
                                      <span>IA: {img.model || "Flux / MJ"}</span>
                                      <span className="text-slate-500">{img.timestamp}</span>
                                    </div>
                                    <div className="line-clamp-3 text-[8px] text-slate-400 italic">
                                      {img.prompt}
                                    </div>
                                  </div>

                                  {/* Bottom part: actions */}
                                  <div className="grid grid-cols-2 gap-1.5 pt-1.5 border-t border-[#222]">
                                    {!isActiveInScene ? (
                                      <button
                                        type="button"
                                        onClick={() => handleActivateArchiveImage(scene.id, img.url, img)}
                                        className="col-span-2 py-1 bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black border border-[#D4AF37]/30 text-[#D4AF37] text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all text-center"
                                      >
                                        Ativar na Cena
                                      </button>
                                    ) : (
                                      <span className="col-span-2 py-1 text-center text-emerald-400 bg-emerald-950/20 border border-emerald-900/30 text-[8px] uppercase tracking-wider font-mono font-bold rounded">
                                        Imagem Ativa
                                      </span>
                                    )}

                                    <button
                                      type="button"
                                      onClick={() => {
                                        const cleanTitle = (scene.text || "")
                                          .toLowerCase()
                                          .normalize("NFD")
                                          .replace(/[\u0300-\u036f]/g, "")
                                          .replace(/[^a-z0-9]/g, "-")
                                          .replace(/-+/g, "-")
                                          .substring(0, 24)
                                          .replace(/^-|-$/g, "");
                                        const num = consecutiveNumbering 
                                          ? String(idx + 1).padStart(2, "0") 
                                          : (scene.sceneNumber || String(idx + 1));
                                        const letter = img.letter || "A";
                                        const filename = `cena-${num}_${letter}${cleanTitle ? `-${cleanTitle}` : ""}.png`;
                                        handleDownloadArchiveImage(img.url, filename);
                                      }}
                                      className="py-1 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all text-center"
                                      title="Baixar Foto"
                                    >
                                      Baixar
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => {
                                        navigator.clipboard.writeText(img.prompt);
                                        setNotification("✓ Prompt copiado para a área de transferência!");
                                      }}
                                      className="py-1 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all flex items-center justify-center gap-1"
                                      title="Copiar Prompt"
                                    >
                                      <Copy size={8} />
                                      <span>Copiar</span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => handleDeleteArchiveImage(img.url)}
                                      className="col-span-2 py-1 bg-rose-950/20 hover:bg-rose-900 border border-rose-900/30 hover:border-rose-700 text-rose-300 text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all flex items-center justify-center gap-1"
                                      title="Remover permanentemente"
                                    >
                                      <Trash2 size={8} />
                                      <span>Remover</span>
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Discarded / Orphan Images Collection */}
              <div className="space-y-4 pt-4">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-slate-400 border-b border-[#222] pb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                  Imagens Descartadas / Históricas ({getDiscardedImages().length})
                  <span className="text-[9px] font-sans font-normal text-slate-500 lowercase normal-case tracking-normal">
                    (de cenas apagadas ou fundidas)
                  </span>
                </h3>

                {getDiscardedImages().length === 0 ? (
                  <p className="text-xs text-slate-500 italic font-sans pl-2">
                    Nenhuma imagem descartada nesta sessão.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {getDiscardedImages().map((img, imgIdx) => (
                      <div
                        key={`${img.id}-${imgIdx}`}
                        className="relative group border border-dashed border-[#333] hover:border-[#444] rounded-lg overflow-hidden bg-black/60 aspect-video flex flex-col"
                      >
                        <img
                          src={img.url}
                          alt="Descartada"
                          className="w-full h-full object-cover select-none pointer-events-none opacity-60 group-hover:opacity-100 transition-opacity"
                          referrerPolicy="no-referrer"
                        />

                        {/* Scene tag of discarded scene */}
                        <span className="absolute top-1.5 left-1.5 bg-[#222]/90 border border-slate-700 text-slate-300 text-[8px] font-mono font-bold uppercase px-1 rounded shadow">
                          Cena {img.originalSceneNumber || "Removida"}
                        </span>

                        {/* Hover action sheet */}
                        <div className="absolute inset-0 bg-black/95 opacity-0 group-hover:opacity-100 flex flex-col justify-between p-2.5 transition-all duration-200">
                          {/* Details */}
                          <div className="text-[9px] font-mono text-slate-400 space-y-0.5 leading-normal">
                            <div className="text-slate-300 flex justify-between">
                              <span>IA: {img.model || "Flux"}</span>
                              <span className="text-slate-500">{img.timestamp}</span>
                            </div>
                            <div className="line-clamp-2 text-[8px] text-slate-400 italic">
                              {img.prompt}
                            </div>
                            <div className="line-clamp-2 text-[8px] text-slate-500 italic mt-1 border-t border-zinc-800/60 pt-1">
                              Ref: "{img.text}"
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="grid grid-cols-2 gap-1.5 pt-1.5 border-t border-[#222]">
                            <button
                              type="button"
                              onClick={() => handleRestoreAsNewScene(img)}
                              className="col-span-2 py-1 bg-emerald-950/20 hover:bg-emerald-800 border border-emerald-900/40 text-emerald-300 text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all text-center"
                              title="Criar nova cena no storyboard com esta foto e narração"
                            >
                              Restaurar como Nova Cena
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                const cleanTitle = (img.text || "")
                                  .toLowerCase()
                                  .normalize("NFD")
                                  .replace(/[\u0300-\u036f]/g, "")
                                  .replace(/[^a-z0-9]/g, "-")
                                  .replace(/-+/g, "-")
                                  .substring(0, 24)
                                  .replace(/^-|-$/g, "");
                                const num = img.originalSceneNumber || "X";
                                const letter = img.letter || "A";
                                const filename = `cena-${num}_${letter}${cleanTitle ? `-${cleanTitle}` : ""}.png`;
                                handleDownloadArchiveImage(img.url, filename);
                              }}
                              className="py-1 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all text-center"
                            >
                              Baixar
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(img.prompt);
                                setNotification("✓ Prompt copiado para a área de transferência!");
                              }}
                              className="py-1 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all flex items-center justify-center gap-1"
                            >
                              <Copy size={8} />
                              <span>Prompt</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleDeleteArchiveImage(img.url)}
                              className="col-span-2 py-1 bg-rose-950/25 hover:bg-rose-900 border border-rose-900/30 hover:border-rose-700 text-rose-300 text-[8px] uppercase tracking-wider font-mono font-bold rounded cursor-pointer transition-all flex items-center justify-center gap-1"
                            >
                              <Trash2 size={8} />
                              <span>Remover</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer / Controls */}
            <div className="px-6 py-4 border-t border-[#333]/60 bg-black/40 flex items-center justify-between shrink-0 font-mono text-[9px] text-slate-500 uppercase tracking-widest">
              <span>Total de {sessionImageArchive.length} imagens no acervo completo</span>
              {!showConfirmPurgeDiscarded ? (
                <button
                  type="button"
                  onClick={() => setShowConfirmPurgeDiscarded(true)}
                  disabled={getDiscardedImages().length === 0}
                  className="px-3 py-1 border border-rose-950/40 hover:bg-rose-950/20 text-rose-400 font-bold rounded cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  title="Apagar permanentemente todas as imagens descartadas para liberar memória"
                >
                  Limpar Descartadas
                </button>
              ) : (
                <div className="flex items-center gap-2 select-none normal-case">
                  <span className="text-[10px] text-rose-300 font-sans">Deseja apagar as descartadas?</span>
                  <button
                    type="button"
                    onClick={() => {
                      const activeUrls = new Set(scenes.map(s => s.generatedImageUrl).filter(Boolean));
                      scenes.forEach(s => {
                        if (s.imageVersions) {
                          s.imageVersions.forEach(v => activeUrls.add(v.url));
                        }
                      });
                      setSessionImageArchive(prev => prev.filter(img => activeUrls.has(img.url)));
                      setNotification("✓ Acervo limpo: todas as imagens descartadas foram expurgadas.");
                      setShowConfirmPurgeDiscarded(false);
                    }}
                    className="px-2 py-0.5 bg-rose-900 hover:bg-rose-800 text-rose-100 text-[9px] font-mono font-bold rounded cursor-pointer uppercase"
                  >
                    Sim
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowConfirmPurgeDiscarded(false)}
                    className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-slate-300 text-[9px] font-mono rounded cursor-pointer uppercase"
                  >
                    Não
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Floating Notifications Panel */}
      <div id="floating-notifications-container" className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 max-w-sm pointer-events-none">
        <AnimatePresence>
          {floatingNotifications.map((n) => (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 50, scale: 0.9, transition: { duration: 0.2 } }}
              className="pointer-events-auto flex gap-3.5 bg-black/95 border border-zinc-800 hover:border-[#D4AF37]/50 p-3 rounded-lg shadow-2xl backdrop-blur-md text-stone-200 text-xs w-80 relative overflow-hidden group cursor-pointer transition-all"
              onClick={() => {
                setActiveStudioSceneId(n.sceneId);
                setFloatingNotifications((prev) => prev.filter((item) => item.id !== n.id));
              }}
            >
              {/* Colored left bar */}
              <div className={`absolute top-0 left-0 bottom-0 w-1 ${n.type === "image" ? "bg-[#D4AF37]" : "bg-blue-500"}`} />
              
              {n.type === "image" && n.imageUrl ? (
                <div className="w-16 h-16 shrink-0 rounded overflow-hidden border border-zinc-850/80 bg-zinc-950 relative">
                  <img src={n.imageUrl} alt="Render" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" referrerPolicy="no-referrer" />
                  <div className="absolute inset-0 bg-black/30 group-hover:bg-transparent transition-colors" />
                </div>
              ) : (
                <div className="w-16 h-16 shrink-0 rounded bg-zinc-900/40 border border-zinc-850/80 flex items-center justify-center text-blue-400">
                  <FileText size={20} />
                </div>
              )}
              
              <div className="flex-1 flex flex-col justify-center min-w-0 pr-4">
                <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500 font-bold mb-0.5">
                  Estúdio AI • Cena {n.sceneNumber}
                </span>
                <p className="text-[11px] leading-snug font-sans text-stone-300 font-medium">
                  {n.message}
                </p>
                <span className="text-[9px] text-[#D4AF37] font-mono mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  Clique para abrir no Estúdio →
                </span>
              </div>
              
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFloatingNotifications((prev) => prev.filter((item) => item.id !== n.id));
                }}
                className="absolute top-2 right-2 text-zinc-500 hover:text-white transition-colors cursor-pointer"
              >
                <X size={12} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Global isGenerating Modal Overlay */}
      {isGenerating && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[99999] flex flex-col items-center justify-center animate-fadeIn">
          <div className="bg-[#121212] border border-[#D4AF37]/50 rounded-xl p-8 max-w-md text-center shadow-2xl space-y-4">
            <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/40 flex items-center justify-center text-[#D4AF37] mx-auto animate-pulse">
              <Loader2 size={28} className="animate-spin text-[#D4AF37]" />
            </div>
            <h3 className="text-base font-serif italic text-white font-bold">Processando Narração & Re-sincronizando...</h3>
            <p className="text-xs text-[#D4AF37] font-mono leading-relaxed">
              {notification || "Calculando alinhamento de áudio N-Gram de 8 palavras..."}
            </p>
            <div className="text-[10px] text-zinc-400 font-mono uppercase tracking-widest animate-pulse">
              Aguarde enquanto os timecodes são corrigidos no disco...
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
