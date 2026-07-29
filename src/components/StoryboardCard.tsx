import React, { useRef, useState, useEffect } from "react";
import { StoryboardScene, StylePreference, ConnectionGroup } from "../types";
import { getCachedImage } from "../lib/cacheStore";
import { downloadSingleImageFile } from "../lib/imageUtils";
import { 
  Scissors, 
  ChevronUp, 
  ChevronDown, 
  Trash2, 
  Sparkles, 
  Merge, 
  Save, 
  Edit3, 
  Image as ImageIcon,
  MessageSquare,
  RefreshCw,
  Clock,
  Maximize2,
  X,
  Cpu,
  Layers,
  Check,
  ExternalLink,
  Sliders,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Upload,
  Download,
  Copy,
  Send,
  Link as LinkIcon,
  Unlink
} from "lucide-react";
import { resizeAndCompressImage } from "../utils";

interface StoryboardCardProps {
  key?: string;
  scene: StoryboardScene;
  index: number;
  totalScenes: number;
  onUpdate: (id: string, fields: Partial<StoryboardScene>) => void;
  onSplit: (index: number, splitText1: string, splitText2: string) => void;
  onMerge: (index: number) => void;
  onRegenerate: (index: number, andGenerateImage?: boolean) => void;
  onDelete: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  isRegenerating: boolean;
  isQueued?: boolean;
  isStudioOpen?: boolean;
  onOpenStudio?: () => void;
  onCloseStudio?: () => void;
  stylePreference: StylePreference;
  customApiKey?: string;
  openAiKey?: string;
  openAiDalleModel?: string;
  onCancelRender?: (id: string) => void;
  consecutiveNumbering?: boolean;
  onToggleConsecutiveNumbering?: (value: boolean) => void;
  connectionGroups?: ConnectionGroup[];
  isConnectionMode?: boolean;
  selectedSceneIdsForConnection?: string[];
  onToggleSceneSelection?: (sceneId: string) => void;
  scenes?: StoryboardScene[];
}

export default function StoryboardCard({
  scene,
  index,
  totalScenes,
  onUpdate,
  onSplit,
  onMerge,
  onRegenerate,
  onDelete,
  onMoveUp,
  onMoveDown,
  isRegenerating,
  isQueued = false,
  isStudioOpen = false,
  onOpenStudio,
  onCloseStudio,
  stylePreference,
  customApiKey,
  openAiKey,
  openAiDalleModel,
  onCancelRender,
  consecutiveNumbering = true,
  onToggleConsecutiveNumbering,
  connectionGroups = [],
  isConnectionMode = false,
  selectedSceneIdsForConnection = [],
  onToggleSceneSelection,
  scenes = []
}: StoryboardCardProps) {
  const narrationRef = useRef<HTMLTextAreaElement>(null);
  const [isManualEditing, setIsManualEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptInputCopied, setPromptInputCopied] = useState(false);

  const sceneNumText = consecutiveNumbering 
    ? String(index + 1).padStart(2, "0") 
    : (scene.sceneNumber || String(index + 1));
  
  // Local state for interactive editing to prevent constant parent state writes
  const [localText, setLocalText] = useState(scene.text);
  const [localDescription, setLocalDescription] = useState(scene.description);
  const [localPrompt, setLocalPrompt] = useState(scene.prompt);

  // New scene-specific parameters
  const [localGuidelines, setLocalGuidelines] = useState(scene.generationGuidelines || "");
  const [localSceneStyle, setLocalSceneStyle] = useState<StylePreference>(scene.sceneStylePreference || "auto");
  const [localAiModel, setLocalAiModel] = useState(scene.promptAiModel || "gemini-3.5-flash");
  const [localTargetTool, setLocalTargetTool] = useState(scene.promptTargetTool || "Nano Banana");

  // Sync state when props shift to prevent stale states
  React.useEffect(() => {
    setLocalText(scene.text);
    setLocalDescription(scene.description);
    setLocalPrompt(scene.prompt);
    setLocalGuidelines(scene.generationGuidelines || "");
    setLocalSceneStyle(scene.sceneStylePreference || "auto");
    setLocalAiModel(scene.promptAiModel || "gemini-3.5-flash");
    setLocalTargetTool(scene.promptTargetTool || "Nano Banana");
  }, [
    scene.text,
    scene.description,
    scene.prompt,
    scene.generationGuidelines,
    scene.sceneStylePreference,
    scene.promptAiModel,
    scene.promptTargetTool
  ]);

  // Determine model/algorithm used to generate prompt
  const getModelIndicator = () => {
    const chosen = scene.promptAiModel || "gemini-3.5-flash";
    const used = scene.promptAiModelUsed;

    if (!used) return null;

    if (used === "fallback") {
      return {
        label: "ALG",
        colorClass: "text-rose-400 bg-rose-950/40 border-rose-900/60",
        tooltip: "Algoritmo local de extração de palavras (Fallback)",
      };
    }

    if (used === "ollama") {
      return {
        label: "OLL",
        colorClass: "text-blue-400 bg-blue-950/40 border-blue-900/60",
        tooltip: "Ollama (Modelo local)",
      };
    }

    // Check if it matches chosen (modulo naming details)
    if (used === chosen || (chosen === "gemini-3.5-flash" && used === "gemini-3.5-flash")) {
      let label = "G3.5";
      if (used.includes("3.1-pro")) label = "G3.1P";
      else if (used.includes("3.1")) label = "G3.1";
      return {
        label: label,
        colorClass: "text-emerald-400 bg-emerald-950/40 border-emerald-900/60",
        tooltip: `Modelo indicado utilizado: ${used}`,
      };
    }

    // Gemini 3.1 fallback when it wasn't the chosen model
    if (used.includes("3.1") || used.includes("flash-lite") || used.includes("flash-latest")) {
      return {
        label: "G3.1",
        colorClass: "text-amber-400 bg-amber-950/40 border-amber-900/60",
        tooltip: `Fallback automático para Gemini 3.1 Lite (Indicado: ${chosen})`,
      };
    }

    return {
      label: used.substring(0, 5).toUpperCase(),
      colorClass: "text-stone-400 bg-stone-900 border-stone-800",
      tooltip: `Modelo utilizado: ${used}`,
    };
  };

  const modelIndicator = getModelIndicator();

  // Scroll locking mechanism when the Studio is open + ESC key close listener
  React.useEffect(() => {
    if (isStudioOpen) {
      document.body.style.overflow = "hidden";
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          onCloseStudio?.();
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
  }, [isStudioOpen, onCloseStudio]);

  const [selectedModel, setSelectedModel] = useState<"nano_banana" | "nano_banana_pro" | "nano_banana_2" | "chatgpt_dalle3">("nano_banana");
  const [isStudioGenerating, setIsStudioGenerating] = useState(false);
  const [studioPrompt, setStudioPrompt] = useState(scene.prompt);
  const [studioResultUrl, setStudioResultUrl] = useState<string | undefined>(scene.generatedImageUrl);
  const [renderMetadata, setRenderMetadata] = useState<{ engineName?: string; renderTimeSeconds?: number; creativeShader?: string } | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);

  // Auto-resolve IndexedDB cached images if url starts with idb://
  const [resolvedIdbUrl, setResolvedIdbUrl] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    if (scene.generatedImageUrl && scene.generatedImageUrl.startsWith("idb://")) {
      const key = scene.generatedImageUrl.replace("idb://", "");
      getCachedImage(key).then((realData) => {
        if (isMounted) {
          if (realData) {
            setResolvedIdbUrl(realData);
          } else {
            setResolvedIdbUrl(null);
          }
        }
      });
    } else {
      setResolvedIdbUrl(null);
    }
    return () => { isMounted = false; };
  }, [scene.generatedImageUrl]);

  const activeImageUrl = (scene.generatedImageUrl && scene.generatedImageUrl.startsWith("idb://"))
    ? (resolvedIdbUrl || undefined)
    : scene.generatedImageUrl;

  // Conversational chat edit states
  const [chatInputText, setChatInputText] = useState("");
  const [isChatGenerating, setIsChatGenerating] = useState(false);
  const [selectedChatModel, setSelectedChatModel] = useState<"nano_banana" | "nano_banana_pro" | "nano_banana_2" | "chatgpt_dalle3">("nano_banana");

  // Drag and Drop "droplet" + Manual PC File Upload features
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Scene-specific visual instruction reference image states and refs
  const visualInstructionInputRef = useRef<HTMLInputElement>(null);
  const modalVisualInstructionInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingVisualInstruction, setIsDraggingVisualInstruction] = useState(false);
  const [isDraggingModalVisualInstruction, setIsDraggingModalVisualInstruction] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const processFile = async (file: File) => {
    if (file && file.type.startsWith("image/")) {
      try {
        const compressedBase64 = await resizeAndCompressImage(file, 1280, 0.8);
        onUpdate(scene.id, {
          generatedImageUrl: compressedBase64,
          engineName: "Upload do Computador",
          renderStatus: "idle",
          renderError: undefined
        });
      } catch (err) {
        console.error("Erro ao processar imagem de upload:", err);
      }
    }
  };

  const processVisualInstructionFile = async (file: File) => {
    if (file && file.type.startsWith("image/")) {
      try {
        const compressedBase64 = await resizeAndCompressImage(file, 800, 0.75);
        onUpdate(scene.id, {
          visualInstructionImage: compressedBase64
        });
      } catch (err) {
        console.error("Erro ao processar imagem de instrução visual:", err);
      }
    }
  };

  const handleClearVisualInstruction = (e: React.MouseEvent) => {
    e.stopPropagation();
    onUpdate(scene.id, {
      visualInstructionImage: undefined
    });
    if (visualInstructionInputRef.current) visualInstructionInputRef.current.value = "";
    if (modalVisualInstructionInputRef.current) modalVisualInstructionInputRef.current.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

  const triggerUpload = (e: React.MouseEvent) => {
    e.stopPropagation(); // Avoid triggering standard studio triggers
    fileInputRef.current?.click();
  };

  const handleQueueImage = () => {
    onUpdate(scene.id, { 
      renderStatus: "queued", 
      renderError: undefined,
      text: localText,
      description: localDescription,
      prompt: localPrompt,
      generationGuidelines: localGuidelines,
      sceneStylePreference: localSceneStyle,
      promptAiModel: localAiModel,
      promptTargetTool: localTargetTool
    });
  };

  const handleOpenStudio = () => {
    setStudioPrompt(scene.prompt || localPrompt);
    setStudioResultUrl(scene.generatedImageUrl);
    setRenderMetadata(scene.engineName ? {
      engineName: scene.engineName,
      renderTimeSeconds: scene.renderTimeSeconds,
      creativeShader: scene.selectedModel === "nano_banana_pro" ? "Resolução 4K estendida, simulação analógica de granulação de filme 35mm e desfoque anamórfico." : scene.selectedModel === "nano_banana_2" ? "Estetização pictórica neo-expressionista com pinceladas simuladas por inteligência neural profunda." : "Cores amigáveis e contrastes neutros para fins contemplativos."
    } : null);
    if (scene.selectedModel) {
      setSelectedModel(scene.selectedModel);
      setSelectedChatModel(scene.selectedModel);
    }
    setStudioError(null);
    onOpenStudio?.();
  };

  const handleGenerateImage = async () => {
    setIsStudioGenerating(true);
    setStudioError(null);
    try {
      const response = await fetch("/api/storyboard/generate-image", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(customApiKey ? { "x-gemini-key": customApiKey } : {})
        },
        body: JSON.stringify({
          prompt: studioPrompt,
          model: selectedModel,
          visualInstructionImage: scene.visualInstructionImage,
          customApiKey
        })
      });

      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        if (!response.ok) {
          let htmlTitle = "";
          if (text.includes("<title>")) {
            const match = text.match(/<title>([\s\S]*?)<\/title>/i);
            if (match && match[1]) {
              htmlTitle = `: ${match[1].trim()}`;
            }
          }
          throw new Error(`Erro na comunicação com o servidor de renderização (Status: ${response.status}${htmlTitle})`);
        }
        throw new Error("Resposta do servidor de renderização malformada (não é um JSON válido).");
      }

      if (!response.ok) {
        throw new Error(data.error || "Erro na comunicação com o servidor de renderização.");
      }

      setStudioResultUrl(data.imageUrl);
      setRenderMetadata(data.metadata);

      if (!data.isAiGenerated && data.generationError) {
        setStudioError(`(Aviso: Modo de Reprodução Simulada) O motor Nano Banana reportou: "${data.generationError}". Para liberar a geração de imagens sob demanda totalmente customizadas do zero a partir do seu prompt, por favor, configure uma chave nos Secrets e aprove o fluxo de faturamento. Ativamos a renderização de imagens de estoque curadas com foco semântico para manter o storyboard de pé.`);
      }
    } catch (err: any) {
      setStudioError(err.message || "Erro de conexão ao gerar a imagem.");
    } finally {
      setIsStudioGenerating(false);
    }
  };

  const handleApplyStudioResult = () => {
    if (studioResultUrl) {
      onUpdate(scene.id, {
        generatedImageUrl: studioResultUrl,
        selectedModel: selectedModel,
        engineName: renderMetadata?.engineName,
        renderTimeSeconds: renderMetadata?.renderTimeSeconds,
        prompt: studioPrompt
      });
      onCloseStudio?.();
    }
  };

  // Direct render handler triggered directly from the image workspace buttons
  const handleDirectRender = (model: "nano_banana" | "nano_banana_pro" | "nano_banana_2" | "chatgpt_dalle3") => {
    onUpdate(scene.id, { 
      renderStatus: "queued", 
      selectedModel: model, 
      prompt: localPrompt || scene.prompt,
      renderError: undefined 
    });
  };

  // Clear image handler (Limpar Imagem)
  const handleClearImage = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const currentUrl = scene.generatedImageUrl;
    const remainingVersions = (scene.imageVersions || []).filter(v => v.url !== currentUrl);
    
    onUpdate(scene.id, {
      generatedImageUrl: undefined,
      imageVersions: remainingVersions,
      engineName: undefined,
      renderTimeSeconds: undefined,
      renderStatus: "idle",
      renderError: undefined,
      isPromptModified: false
    });
  };

  // Download single image with correct nomenclature (cena-XX_A-slug.png)
  const handleDownloadImage = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!scene.generatedImageUrl) return;

    const activeVersion = (scene.imageVersions || []).find(v => v.url === scene.generatedImageUrl);
    const letter = activeVersion?.letter || "A";

    const cleanTitle = (scene.text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // remove portuguese accents
      .replace(/[^a-z0-9]/g, "-")      // replace non-alphanumeric with hyphens
      .replace(/-+/g, "-")             // collapse duplicate hyphens
      .substring(0, 24)                // keep it concise
      .replace(/^-|-$/g, "");          // trim starting or ending hyphens

    const cleanNum = sceneNumText.replace(/[^a-zA-Z0-9-]/g, "_");
    const filename = `cena-${cleanNum}_${letter}${cleanTitle ? `-${cleanTitle}` : ""}`;

    try {
      await downloadSingleImageFile(scene.generatedImageUrl, filename);
    } catch (err) {
      console.error("Erro ao baixar imagem da cena:", err);
    }
  };

  // Copy prompt to clipboard with temporary feedback status
  const handleCopyPrompt = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const promptText = scene.prompt || localPrompt;
    if (!promptText) return;
    navigator.clipboard.writeText(promptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Copies all prompt instruction/parameter details to clipboard for use in other engines/models
  const handleCopyPromptInfo = (e: React.MouseEvent) => {
    e.stopPropagation();

    const activeStyle = scene.sceneStylePreference && scene.sceneStylePreference !== "auto" 
      ? scene.sceneStylePreference 
      : stylePreference;

    let styleGuidance = "Automatically detect and choose the best matching Art Director styling.";
    if (activeStyle === "caravaggio") {
      styleGuidance = "Strictly use the Caravaggio-inspired dramatic chiaroscuro historical/religious style. The image must be a borderless full screen image, with absolutely no picture frames, wooden borders, museum background, or canvas edges.";
    } else if (activeStyle === "urban_realism") {
      styleGuidance = "Strictly use the gritty, naturalistic Brazilian urban realism style.";
    }

    let directionPrompt = "";
    if (scene.generationGuidelines && scene.generationGuidelines.trim()) {
      directionPrompt = `\nCRITICAL CREATIVE DIRECTION / CRITIQUE:
"${scene.generationGuidelines.trim()}"
You MUST strictly incorporate and prioritize this concept or correction constraint. Guide composition, character postures, and tone to match this advice (e.g. if requested to depict mediocrity instead of positive/purposeful outcomes, focus purely on uninspired, mundane, mediocre elements and faces).`;
    }

    const toolGuidance = `OPTIMIZATION FOCUS: Format and tailor this prompt for the image generation engine "${scene.promptTargetTool || "Nano Banana"}". Emphasize compatible cues, weight tags, or structures ideal for ${scene.promptTargetTool || "Nano Banana"}.`;

    let connectedContext = "";
    if (scene.connectionGroupId && Array.isArray(scenes) && scenes.length > 0) {
      const otherConnected = scenes.filter(s => s.connectionGroupId === scene.connectionGroupId && s.id !== scene.id);
      if (otherConnected.length > 0) {
        connectedContext = `\n\nCRITICAL VISUAL CONTINUITY & NARRATIVE CONSISTENCY CONSTRAINTS (SAME GROUP CONTEXT):
This scene belongs to a group of connected scenes designed to share character designs, lighting setups, location assets, and visual styles to guarantee aesthetic continuity.
Ensure the clothing style, hair, skin features, props, facial structures, color palette, and location details are aligned with these scenes:
` + otherConnected.map((s, i) => {
          const sIndex = scenes.findIndex(orig => orig.id === s.id);
          const sceneNum = sIndex !== -1 ? sIndex + 1 : (i + 1);
          const numPad = String(sceneNum).padStart(2, "0");
          return `- Connected Scene #${numPad}:
  Narration: "${s.text || ""}"
  Visual Description: "${s.description || ""}"
  Image Prompt: "${s.prompt || ""}"`;
        }).join("\n");
      }
    }

    const systemInstruction = `You are a professional Art Director specializing in religious, contemplative, and human-centric daily meditations.
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
     Use gritty, naturalistic Brazilian urban realism style. Focus on natural ambient lighting, authentic everyday ordinary people (with unique faces, expressive lines, genuine gestures, real bodies), authentic places (concrete walls, favelas, cobblestones, bus stops, humble Brazilian homes, warm tropical light or rain showers), realistic cinematic film photorealism, avoiding glossy high-tech looks or clean synthetic renders.`;

    const userPromptText = `Generate a fresh, improved visual description (written in Brazilian Portuguese (PT-BR) ONLY) and English image prompt for this storyboard segment narration.
You should provide a different creative angle or improved composition than the current description if provided below.

Narration Segment: "${scene.text}"
Current Visual Description (to improve/change): "${scene.description || ""}"
Current Image Prompt (to improve/change): "${scene.prompt || ""}"
Styling Directive: ${styleGuidance}
${directionPrompt}
${toolGuidance}${connectedContext}`;

    const textToCopy = `=== INSTRUÇÃO DO SISTEMA (SYSTEM INSTRUCTION) ===
${systemInstruction}

=== PROMPT DE ENTRADA DO USUÁRIO (USER PROMPT) ===
${userPromptText}`;

    navigator.clipboard.writeText(textToCopy).then(() => {
      setPromptInputCopied(true);
      setTimeout(() => setPromptInputCopied(false), 2000);
    }).catch(err => {
      console.error("Failed to copy text: ", err);
    });
  };

  // Select image option generated within the chat history thread
  const handleSelectChatImage = (msg: any) => {
    if (msg.imageUrl) {
      onUpdate(scene.id, {
        generatedImageUrl: msg.imageUrl,
        prompt: msg.promptUsed || scene.prompt,
        description: msg.descriptionUsed || scene.description,
        selectedModel: msg.model || "nano_banana",
        promptAiModelUsed: msg.promptAiModelUsed || "gemini-3.5-flash",
        isPromptModified: false
      });
    }
  };

  // Chat message sender that queries our visual chat editor API and runs direct rendering
  const handleSendChatMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInputText.trim() || isChatGenerating) return;

    const userMsgText = chatInputText;
    setChatInputText("");
    setIsChatGenerating(true);

    const userMsg = {
      id: `msg-user-${Date.now()}`,
      role: "user" as const,
      text: userMsgText,
      timestamp: new Date().toLocaleTimeString()
    };

    const initialHistory = scene.chatHistory || [
      {
        id: "welcome",
        role: "assistant" as const,
        text: `Olá! Eu sou o seu Diretor de Arte do Estúdio AI. Estou pronto para discutir a composição visual da sua cena e fazer edições sucessivas nas imagens conforme conversamos.\n\nO que gostaria de ajustar ou detalhar nesta cena? Peça mudanças de iluminação, estilo, elementos ou clima!`,
        reasoning: "Analisei a narração original para estabelecer a fundação visual da cena.",
        imageUrl: scene.generatedImageUrl,
        timestamp: new Date().toLocaleTimeString()
      }
    ];

    const currentHistory = [...initialHistory, userMsg];
    
    onUpdate(scene.id, {
      chatHistory: currentHistory
    });

    // Gather other scenes in the same connection group for aesthetic/visual continuity
    const otherConnectedScenes = scene.connectionGroupId
      ? scenes
          .filter((s) => s.connectionGroupId === scene.connectionGroupId && s.id !== scene.id)
          .map((s) => ({
            sceneNumber: s.sceneNumber || String(scenes.indexOf(s) + 1).padStart(2, "0"),
            text: s.text,
            description: s.description,
            prompt: s.prompt,
            generatedImageUrl: s.generatedImageUrl,
            visualInstructionImage: s.visualInstructionImage,
          }))
      : [];

    // Find the latest visual state in the current conversation thread for perfect context and continuous editing
    let latestChatImageUrl = scene.generatedImageUrl;
    let latestChatPrompt = scene.prompt || localPrompt;
    let latestChatDescription = scene.description || localDescription;

    // Search backwards to find the last assistant message that successfully generated an image and use its prompt/description/image
    for (let i = currentHistory.length - 1; i >= 0; i--) {
      const msg = currentHistory[i];
      if (msg.role === "assistant" && msg.imageUrl) {
        latestChatImageUrl = msg.imageUrl;
        if (msg.promptUsed) {
          latestChatPrompt = msg.promptUsed;
        }
        if (msg.descriptionUsed) {
          latestChatDescription = msg.descriptionUsed;
        }
        break;
      }
    }

    try {
      const editResponse = await fetch("/api/storyboard/chat-edit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(customApiKey ? { "x-gemini-key": customApiKey } : {})
        },
        body: JSON.stringify({
          sceneText: scene.text,
          chatHistory: currentHistory.slice(0, -1),
          userMessage: userMsgText,
          currentDescription: latestChatDescription,
          currentPrompt: latestChatPrompt,
          stylePreference: stylePreference,
          visualInstructionImage: scene.visualInstructionImage,
          currentImageUrl: latestChatImageUrl,
          customApiKey,
          connectedScenes: otherConnectedScenes
        })
      });

      if (!editResponse.ok) {
        const errorData = await editResponse.json();
        throw new Error(errorData.error || "Falha ao processar comandos no bate-papo.");
      }

      const editResult = await editResponse.json();

      const imgResponse = await fetch("/api/storyboard/generate-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(customApiKey ? { "x-gemini-key": customApiKey } : {})
        },
        body: JSON.stringify({
          prompt: editResult.newPrompt,
          model: selectedChatModel,
          visualInstructionImage: scene.visualInstructionImage,
          customApiKey
        })
      });

      if (!imgResponse.ok) {
        throw new Error("Suas diretrizes visuais foram salvas, mas o motor de renderização da imagem falhou ou excedeu a cota.");
      }

      const imgResult = await imgResponse.json();

      const assistantMsg = {
        id: `msg-assistant-${Date.now()}`,
        role: "assistant" as const,
        text: editResult.assistantText,
        reasoning: editResult.reasoning,
        imageUrl: imgResult.imageUrl,
        model: selectedChatModel,
        promptUsed: editResult.newPrompt,
        descriptionUsed: editResult.newDescription,
        promptAiModelUsed: editResult.promptAiModelUsed,
        timestamp: new Date().toLocaleTimeString()
      };

      onUpdate(scene.id, {
        chatHistory: [...currentHistory, assistantMsg]
      });

    } catch (err: any) {
      console.error("Chat edit conversational failure:", err);
      const assistantErrorMsg = {
        id: `msg-assistant-err-${Date.now()}`,
        role: "assistant" as const,
        text: `⚠️ Desculpe, não consegui processar esta solicitação. Motivo: ${err.message || "Erro de rede"}. Por favor, tente novamente em instantes.`,
        timestamp: new Date().toLocaleTimeString()
      };
      onUpdate(scene.id, {
        chatHistory: [...currentHistory, assistantErrorMsg]
      });
    } finally {
      setIsChatGenerating(false);
    }
  };

  const handleSaveManualEdit = () => {
    onUpdate(scene.id, {
      text: localText,
      description: localDescription,
      prompt: localPrompt,
      generationGuidelines: localGuidelines,
      sceneStylePreference: localSceneStyle,
      promptAiModel: localAiModel,
      promptTargetTool: localTargetTool
    });
    setIsManualEditing(false);
  };

  const handleCancelManualEdit = () => {
    setLocalText(scene.text);
    setLocalDescription(scene.description);
    setLocalPrompt(scene.prompt);
    setLocalGuidelines(scene.generationGuidelines || "");
    setLocalSceneStyle(scene.sceneStylePreference || "auto");
    setLocalAiModel(scene.promptAiModel || "gemini-3.5-flash");
    setLocalTargetTool(scene.promptTargetTool || "Nano Banana");
    setIsManualEditing(false);
  };

  const handleSplitClick = () => {
    const textarea = narrationRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const textLength = localText.length;

    let part1 = "";
    let part2 = "";

    if (start > 0 && start < textLength) {
      // Split at the cursor coordinates
      part1 = localText.substring(0, start).trim();
      part2 = localText.substring(start).trim();
    } else {
      // Split approximately in half down the nearest space
      const middle = Math.floor(textLength / 2);
      const spaceIndex = localText.indexOf(" ", middle);
      if (spaceIndex !== -1) {
        part1 = localText.substring(0, spaceIndex).trim();
        part2 = localText.substring(spaceIndex).trim();
      } else {
        part1 = localText.substring(0, middle).trim();
        part2 = localText.substring(middle).trim();
      }
    }

    if (!part1) part1 = "Segmento de Narração A";
    if (!part2) part2 = "Segmento de Narração B";

    onSplit(index, part1, part2);
  };

  // Determine what style cue to display visually
  const activeStyle = scene.sceneStylePreference && scene.sceneStylePreference !== "auto" 
    ? scene.sceneStylePreference 
    : (scene.sceneStylePreference === "auto" ? "auto" : stylePreference);

  const isCaravaggio = activeStyle === "caravaggio" || 
                       (activeStyle === "auto" && (scene.prompt.toLowerCase().includes("caravaggio") || scene.prompt.toLowerCase().includes("chiaroscuro"))) ||
                       (!scene.sceneStylePreference && stylePreference === "caravaggio");

  const isUrbanRealism = activeStyle === "urban_realism" || 
                         (activeStyle === "auto" && (scene.prompt.toLowerCase().includes("realism") || scene.prompt.toLowerCase().includes("brazil"))) ||
                         (!scene.sceneStylePreference && stylePreference === "urban_realism");

  const activeGroup = connectionGroups?.find(g => g.id === scene.connectionGroupId);

  return (
    <>
      <div 
        id={`storyboard-card-${scene.id}`}
        className="bg-[#1a1a1a] border border-[#333] rounded overflow-hidden transition-all duration-300 hover:border-[#D4AF37]/35 relative flex flex-col md:flex-row group"
        style={activeGroup ? { borderLeft: `6px solid ${activeGroup.color || "#D4AF37"}` } : {}}
      >
        {isConnectionMode && (
          <div 
            onClick={() => onToggleSceneSelection && onToggleSceneSelection(scene.id)}
            className="bg-black/90 border-r border-[#333] flex flex-col items-center justify-center p-4 cursor-pointer hover:bg-zinc-900 transition-all shrink-0 w-full md:w-16 min-h-[60px]"
            title="Selecionar cena para conectar"
          >
            <span className="text-[8px] text-zinc-500 uppercase tracking-widest font-mono mb-1.5 font-bold">Ligar</span>
            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
              selectedSceneIdsForConnection.includes(scene.id)
                ? "border-[#D4AF37] bg-[#D4AF37]/20"
                : "border-zinc-700 hover:border-zinc-500"
            }`}>
              {selectedSceneIdsForConnection.includes(scene.id) && (
                <div className="w-3 h-3 rounded-full bg-[#D4AF37]" />
              )}
            </div>
          </div>
        )}
        {/* Side Action Bar / Drag and Move handles */}
        <div className="bg-[#222] w-full md:w-16 flex md:flex-col items-center justify-between p-3 border-b md:border-b-0 md:border-r border-[#333] gap-2 select-none shrink-0">
          <div className="flex md:flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => onMoveUp(index)}
              disabled={index === 0}
              className={`p-1 rounded transition ${
                index === 0 
                  ? "text-slate-750 opacity-20 cursor-not-allowed" 
                  : "text-slate-400 hover:text-[#D4AF37] hover:bg-[#111] cursor-pointer"
              }`}
              title="Mover para cima"
            >
              <ChevronUp size={16} />
            </button>
            
            <div className="text-center font-mono my-1 pt-1">
              <span className="text-[8px] text-[#D4AF37]/50 uppercase tracking-widest block font-bold font-sans">Cena</span>
              <span className="text-xl font-light text-[#E0D8D0] block font-serif">{sceneNumText}</span>
            </div>

            <button
              type="button"
              onClick={() => onMoveDown(index)}
              disabled={index === totalScenes - 1}
              className={`p-1 rounded transition ${
                index === totalScenes - 1 
                  ? "text-slate-750 opacity-20 cursor-not-allowed" 
                  : "text-slate-400 hover:text-[#D4AF37] hover:bg-[#111] cursor-pointer"
              }`}
              title="Mover para baixo"
            >
              <ChevronDown size={16} />
            </button>
          </div>

          <button
            type="button"
            onClick={() => onDelete(index)}
            className="p-1.5 rounded text-rose-500/80 hover:text-rose-400 hover:bg-rose-950/20 transition cursor-pointer md:mt-auto"
            title="Excluir Cena"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* Dynamic Storyboard Preview Thumbnail/Art Strip Panel */}
        <div 
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`w-full md:w-[420px] lg:w-[520px] xl:w-[680px] 2xl:w-[800px] shrink-0 bg-[#0d0d0d] flex flex-col border-b md:border-b-0 md:border-r border-[#333] overflow-hidden animate-fadeIn ${
            isDragging ? "border-2 border-dashed border-[#D4AF37] bg-[#D4AF37]/10" : ""
          }`}
        >
          {/* 16:9 Pure Unobstructed Image Viewport */}
          <div className="relative w-full aspect-[16/9] bg-black flex items-center justify-center overflow-hidden group">
            {/* Friendly render fallback warning banner */}
            {scene.generatedImageUrl && scene.generatedImageUrl.startsWith("data:image/svg+xml") && (
              <div className="absolute top-2.5 left-2.5 right-2.5 bg-amber-950/90 border border-amber-500/35 backdrop-blur-md p-2 rounded text-[10px] text-amber-200 flex items-start gap-2.5 z-10 animate-fadeIn shadow-lg">
                <AlertTriangle size={14} className="text-[#D4AF37] shrink-0 mt-0.5" />
                <div className="flex-1 space-y-0.5 text-left">
                  <span className="font-bold uppercase tracking-wider block text-[#D4AF37] text-[9px]">⚠️ Esboço de Diretriz Visual (Standby)</span>
                  <p className="font-sans leading-relaxed text-zinc-300">
                    O motor de renderização da IA real de imagem não pôde concluir a imagem final (geralmente por falta de cota/crédito na chave de API). Ativamos este rascunho visual offline com as diretrizes e motivos desenhados no próprio card.
                  </p>
                  {scene.renderError && (
                    <p className="mt-1 font-mono text-[8px] bg-black/40 p-1 rounded border border-amber-500/10 text-[#D4AF37] overflow-x-auto select-all">
                      Erro técnico: {scene.renderError}
                    </p>
                  )}
                </div>
              </div>
            )}

            {activeImageUrl ? (
              <img 
                src={activeImageUrl} 
                alt={`Widescreen render scene #${sceneNumText}`} 
                className="w-full h-full object-cover relative z-0 animate-fadeIn"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const target = e.currentTarget;
                  const retries = parseInt(target.getAttribute("data-retries") || "0");
                  if (retries < 3) {
                    target.setAttribute("data-retries", String(retries + 1));
                    // Smoothly append retry parameter without setting src = "" to avoid black frame flashes
                    const cleanUrl = target.src.replace(/(\?|&)retry=\d+/, "");
                    const separator = cleanUrl.includes("?") ? "&" : "?";
                    target.src = `${cleanUrl}${separator}retry=${Date.now()}`;
                  }
                }}
              />
            ) : scene.generatedImageUrl?.startsWith("idb://") ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#131313] text-[#D4AF37] z-10">
                <Loader2 size={22} className="animate-spin mb-1.5 text-[#D4AF37]" />
                <span className="text-[9px] font-mono tracking-widest uppercase font-bold text-slate-400">
                  Carregando Cache...
                </span>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#131313] text-slate-500">
                <ImageIcon size={26} className="text-zinc-600 mb-1.5 animate-pulse" />
                <span className="text-[9px] font-mono tracking-widest uppercase font-bold text-zinc-500">
                  ESTÚDIO DE CENA 16:9
                </span>
                <span className="text-[8px] text-zinc-650 font-sans mt-0.5">
                  Arraste imagens ou use os renderizadores abaixo
                </span>
              </div>
            )}

            {/* Interactive semi-transparent loading overlay that doesn't block copy/clicks on background images */}
            {(scene.renderStatus === "queued" || scene.renderStatus === "rendering") && (
              <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] flex flex-col items-center justify-center text-center z-20 pointer-events-none">
                <div className="flex flex-col items-center justify-center p-4">
                  <Loader2 className="animate-spin text-[#D4AF37] mb-2" size={24} />
                  <span className="text-[10px] font-mono tracking-widest text-[#D4AF37] uppercase font-bold animate-pulse">
                    {scene.renderStatus === "rendering" ? "Renderizando..." : "Na Fila..."}
                  </span>
                  <span className="text-[8px] text-zinc-400 font-mono mt-1.5 uppercase">
                    via {scene.selectedModel === "nano_banana_pro" ? "Nano Banana Pro" : scene.selectedModel === "nano_banana_2" ? "Nano Banana 2" : "Nano Banana 2 light"}
                  </span>
                  {onCancelRender && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelRender(scene.id);
                      }}
                      className="mt-3 px-2.5 py-1 text-[9px] uppercase tracking-wider font-mono font-bold bg-rose-950 hover:bg-rose-900 border border-rose-900/50 hover:border-rose-700 text-rose-300 rounded cursor-pointer pointer-events-auto transition-colors"
                      title="Cancelar renderização e destravar cena"
                    >
                      Cancelar Geração
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Image Versions Thumbnails Container (Docked at top-right of image) */}
            {scene.imageVersions && scene.imageVersions.length > 0 && (
              <div 
                className="absolute top-3 right-3 flex flex-wrap items-center gap-1.5 bg-black/85 border border-zinc-800 p-1.5 rounded backdrop-blur-md shadow-xl max-w-[200px] sm:max-w-[320px] z-25 max-h-[110px] overflow-y-auto scrollbar-thin"
                onClick={(e) => e.stopPropagation()}
              >
                {scene.imageVersions.map((v, vIdx) => {
                  const isActive = v.url === scene.generatedImageUrl;
                  const isVersionIdb = v.url?.startsWith("idb://");
                  return (
                    <button
                      key={`${v.id || "version"}-${vIdx}`}
                      type="button"
                      onClick={() => {
                        onUpdate(scene.id, {
                          generatedImageUrl: v.url,
                          selectedModel: v.model as any,
                          engineName: v.engineName,
                          renderTimeSeconds: v.renderTimeSeconds,
                          prompt: v.prompt || scene.prompt,
                          description: v.description || scene.description
                        });
                      }}
                      className={`w-12 h-7 bg-zinc-900 border rounded cursor-pointer transition-all ${
                        isActive 
                          ? "border-[#D4AF37] scale-105 shadow-[0_0_8px_rgba(212,175,55,0.5)] z-10" 
                          : "border-zinc-850 hover:border-zinc-500 opacity-60 hover:opacity-100"
                      }`}
                      title={`Versão gerada em ${v.timestamp}${v.model ? ` via ${v.model}` : ""}`}
                    >
                      {isVersionIdb ? (
                        <div className="w-full h-full flex items-center justify-center bg-zinc-950">
                          <Loader2 size={10} className="animate-spin text-[#D4AF37]" />
                        </div>
                      ) : (
                        <img 
                          src={v.url} 
                          alt="Versão" 
                          className="w-full h-full object-cover" 
                          referrerPolicy="no-referrer"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Clean Dedicated AI Control Panel Docked Below Image (No Overlays or Dark Gradients over the Image) */}
          <div className="w-full bg-[#141414] border-t border-zinc-800/80 p-2.5 sm:p-3 text-left space-y-2 mt-auto">
            {/* Line 1: Gerar label + NB2 light, NB Pro, NB2 */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider font-mono text-[#D4AF37] font-bold mr-1 shrink-0">
                Gerar:
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleDirectRender("nano_banana")}
                  className="px-2 py-1 bg-[#161616] hover:bg-[#D4AF37] hover:text-black border border-zinc-800 hover:border-transparent text-[9px] uppercase font-mono font-bold rounded transition-all flex items-center gap-1 cursor-pointer"
                  title="Renderizar instantaneamente com Nano Banana 2 light"
                >
                  NB2 light
                </button>
                <button
                  type="button"
                  onClick={() => handleDirectRender("nano_banana_pro")}
                  className="px-2 py-1 bg-[#161616] hover:bg-[#D4AF37] hover:text-black border border-zinc-800 hover:border-transparent text-[9px] uppercase font-mono font-bold rounded transition-all flex items-center gap-1 cursor-pointer"
                  title="Renderizar instantaneamente com Nano Banana Pro"
                >
                  NB Pro
                </button>
                <button
                  type="button"
                  onClick={() => handleDirectRender("nano_banana_2")}
                  className="px-2 py-1 bg-[#161616] hover:bg-[#D4AF37] hover:text-black border border-zinc-800 hover:border-transparent text-[9px] uppercase font-mono font-bold rounded transition-all flex items-center gap-1 cursor-pointer"
                  title="Renderizar instantaneamente com Nano Banana 2"
                >
                  NB2
                </button>
                {openAiKey && (
                  <button
                    type="button"
                    onClick={() => handleDirectRender("chatgpt_dalle3")}
                    className="px-2 py-1 bg-[#2a2a2a] hover:bg-[#D4AF37] hover:text-black border border-zinc-800 hover:border-transparent text-[9px] uppercase font-mono font-bold rounded transition-all flex items-center gap-1.5 cursor-pointer"
                    title={`Renderizar instantaneamente com OpenAI (${openAiDalleModel || "dall-e-3"})`}
                  >
                    <span>OpenAI</span>
                    <span className="text-[7.5px] text-slate-400 lowercase font-normal italic">
                      ({openAiDalleModel || "dall-e-3"})
                    </span>
                  </button>
                )}
              </div>
            </div>

            {/* Line 2: Estúdio AI, Subir do PC, and Limpar Imagem */}
            <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-zinc-800/40">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleOpenStudio}
                  className="px-2.5 py-1 bg-[#D4AF37]/10 text-[#D4AF37] border border-[#D4AF37]/45 hover:bg-[#D4AF37] hover:text-black hover:border-transparent text-[9px] uppercase tracking-wider rounded font-bold transition-all flex items-center gap-1 cursor-pointer"
                  title="Abrir estúdio de chat com a IA para refinar imagem de forma iterativa"
                >
                  <Sparkles size={9} />
                  <span>Estúdio AI</span>
                </button>

                <button
                  type="button"
                  onClick={triggerUpload}
                  className="px-2 py-1 bg-[#161616] hover:bg-zinc-800 text-zinc-300 border border-zinc-805 text-[9px] uppercase font-mono font-bold rounded transition-all flex items-center gap-1 cursor-pointer"
                  title="Subir imagem do computador"
                >
                  <Upload size={9} className="text-[#D4AF37]" />
                  <span>Subir do PC</span>
                </button>
              </div>

              {scene.generatedImageUrl && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleDownloadImage}
                    className="px-2 py-1 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/20 border border-emerald-900/40 hover:border-emerald-800 rounded transition-all flex items-center gap-1 cursor-pointer text-[9px] uppercase font-mono font-bold"
                    title="Baixar imagem com nomenclatura correta"
                  >
                    <Download size={9} />
                    <span>Baixar</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleClearImage}
                    className="px-2 py-1 text-rose-400 hover:text-rose-300 hover:bg-rose-950/20 border border-rose-900/40 hover:border-rose-800 rounded transition-all flex items-center gap-1 cursor-pointer text-[9px] uppercase font-mono font-bold"
                    title="Limpar imagem deste quadro de cena"
                  >
                    <Trash2 size={9} />
                    <span>Limpar</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept="image/*" 
            className="hidden" 
          />
        </div>

        {/* Main Content Areas */}
        <div className="flex-1 p-5 space-y-4 text-[#E0D8D0]">
          
          {/* Style Badges banner */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#333] pb-2.5">
            <div className="flex items-center gap-2">
              {isCaravaggio && (
                <span className="text-[10px] font-serif py-0.5 px-2 rounded bg-[#D4AF37]/10 text-[#D4AF37] border border-[#D4AF37]/20 uppercase tracking-wider">
                  ✦ Caravaggio Chiaroscuro
                </span>
              )}
              {isUrbanRealism && (
                <span className="text-[10px] font-sans py-0.5 px-2 rounded bg-blue-950/40 text-blue-300 border border-blue-900/30 uppercase tracking-widest">
                  ❖ Realismo Paulistano / Carioca
                </span>
              )}
              {!isCaravaggio && !isUrbanRealism && (
                <span className="text-[10px] font-sans py-0.5 px-2 rounded bg-stone-900 text-stone-300 border border-[#333] uppercase">
                  ⚙ Sob Demanda (Auto IA)
                </span>
              )}
              {scene.generatedImageUrl && (
                <span className="text-[9px] font-mono py-0.5 px-1.5 rounded bg-emerald-950/30 text-emerald-400 border border-emerald-900/30 uppercase font-bold">
                  ✓ Foto Renderizada
                </span>
              )}
              {scene.isPromptModified && scene.generatedImageUrl && (
                <span className="text-[9px] font-mono py-0.5 px-1.5 rounded bg-amber-950/30 text-amber-400 border border-amber-900/30 uppercase font-bold animate-pulse animate-fadeIn" title="O prompt ou texto foi modificado desde a última renderização. Considere gerar novamente.">
                  ⚠ Modificado
                </span>
              )}
              {activeGroup && (
                <span 
                  className="text-[9px] font-mono py-0.5 px-2 rounded uppercase tracking-wider flex items-center gap-1 border font-bold animate-fadeIn"
                  style={{ 
                    backgroundColor: `${activeGroup.color}15`, 
                    color: activeGroup.color, 
                    borderColor: `${activeGroup.color}45` 
                  }}
                  title="Esta cena está conectada e compartilha memórias/prompts com outras cenas no mesmo grupo para consistência visual."
                >
                  <LinkIcon size={10} />
                  <span>Conexão: {activeGroup.name}</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isManualEditing ? (
                <>
                  <button
                    type="button"
                    onClick={handleSaveManualEdit}
                    className="px-2.5 py-1 bg-[#D4AF37] hover:bg-white text-black text-[10px] uppercase font-bold tracking-wider rounded transition flex items-center gap-1 shadow-sm cursor-pointer"
                  >
                    <Save size={10} /> Salvar
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelManualEdit}
                    className="px-2.5 py-1 bg-[#333] hover:bg-zinc-800 text-slate-300 text-[10px] uppercase font-medium rounded transition cursor-pointer"
                  >
                    Cancelar
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleCopyPromptInfo}
                    className="text-[10px] text-slate-400 hover:text-[#D4AF37] uppercase tracking-wider transition flex items-center gap-1.5 px-2.5 py-1 bg-[#222]/35 hover:bg-[#222] border border-[#333]/50 rounded cursor-pointer"
                    title="Copiar todas as instruções de geração que vão para a IA (incluindo texto, estilo, diretrizes e contexto)"
                  >
                    {promptInputCopied ? (
                      <>
                        <Check size={10} className="text-emerald-400" />
                        <span>Instruções Copiadas!</span>
                      </>
                    ) : (
                      <>
                        <Copy size={10} />
                        <span>Copiar instruções</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsManualEditing(true)}
                    className="text-[10px] text-slate-400 hover:text-[#D4AF37] uppercase tracking-wider transition flex items-center gap-1 px-2.5 py-1 bg-[#222]/35 hover:bg-[#222] border border-[#333]/50 rounded cursor-pointer"
                  >
                    <Edit3 size={10} /> Editar textos
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Narrative & Split row - Isolated at the top for full horizontal space */}
          <div className="space-y-1">
            <label className="text-[9px] uppercase tracking-widest text-[#D4AF37]/75 font-mono block">
              Narração/Texto original
            </label>
            {isManualEditing ? (
              <textarea
                ref={narrationRef}
                value={localText}
                onChange={(e) => setLocalText(e.target.value)}
                className="w-full h-24 bg-[#0a0a0a] border border-[#333] rounded p-3 text-xs text-[#E0D8D0] focus:outline-[#D4AF37]/40 resize-none leading-relaxed"
              />
            ) : (
              <div className="min-h-[80px] max-h-24 bg-transparent border-l-2 border-[#D4AF37]/50 pl-3.5 py-1 text-xs text-[#E0D8D0] italic leading-relaxed overflow-y-auto font-serif select-text">
                "{scene.text}"
              </div>
            )}
            {isManualEditing && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 animate-fadeIn">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSplitClick}
                    className="px-2.5 py-1 bg-[#222] hover:bg-[#D4AF37] hover:text-black text-[9px] uppercase tracking-wider rounded font-bold transition-all flex items-center gap-1 cursor-pointer border border-[#333]"
                    title="Dividir o roteiro na posição atual do cursor para inserir uma nova cena."
                  >
                    <Scissors size={10} />
                    <span>Dividir</span>
                  </button>

                  {index < totalScenes - 1 && (
                    <button
                      type="button"
                      onClick={() => onMerge(index)}
                      className="px-2.5 py-1 bg-[#222] hover:bg-[#D4AF37] hover:text-black text-[9px] uppercase tracking-wider rounded font-bold transition-all flex items-center gap-1 cursor-pointer border border-[#333]"
                      title="Fundir este bloco de narração com o bloco inferior."
                    >
                      <Merge size={10} />
                      <span>Mesclar</span>
                    </button>
                  )}

                  {/* Contextual Scene Numbering Toggle right next to Dividir and Mesclar */}
                  {onToggleConsecutiveNumbering && (
                    <div className="flex items-center gap-1.5 bg-zinc-900 border border-[#333] px-2 py-0.5 rounded text-[9px] font-mono sm:ml-1">
                      <span className="text-zinc-400 uppercase text-[8px] font-bold">Numeração:</span>
                      <div className="flex items-center bg-black/60 p-0.5 rounded border border-[#222]">
                        <button
                          type="button"
                          onClick={() => onToggleConsecutiveNumbering(true)}
                          className={`px-1.5 py-0.5 rounded-sm uppercase font-bold text-[8px] transition-all cursor-pointer ${
                            consecutiveNumbering 
                              ? "bg-[#D4AF37] text-black" 
                              : "text-zinc-400 hover:text-white"
                          }`}
                          title="Exibir numeração linear contínua (01, 02, 03...)"
                        >
                          Linear
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleConsecutiveNumbering(false)}
                          className={`px-1.5 py-0.5 rounded-sm uppercase font-bold text-[8px] transition-all cursor-pointer ${
                            !consecutiveNumbering 
                              ? "bg-[#D4AF37] text-black" 
                              : "text-zinc-400 hover:text-white"
                          }`}
                          title="Exibir subnúmeros hierárquicos para cenas divididas (ex: 4-1, 4-2)"
                        >
                          Subnúmeros
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Prompts Layout - Dividing the space of the former "Prompt Gerado" */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            
            {/* Prompt Amigável (IA) */}
            <div className="bg-[#0a0a0a] border border-[#333] rounded p-3.5 space-y-2 relative flex flex-col justify-between min-h-[140px]">
              <div className="space-y-2 w-full">
                <span className="text-[9px] font-mono tracking-widest text-[#D4AF37]/85 uppercase flex items-center gap-1.5 font-semibold">
                  <Sparkles size={10} className="text-[#D4AF37]/85" />
                  Prompt Amigável (IA)
                </span>
                {isManualEditing ? (
                  <textarea
                    value={localDescription}
                    onChange={(e) => setLocalDescription(e.target.value)}
                    className="w-full h-24 bg-[#050505] border border-[#333] rounded p-2 text-xs text-[#E0D8D0] focus:outline-none focus:border-[#D4AF37]/50 resize-none leading-relaxed"
                  />
                ) : (
                  <div className="min-h-[80px] max-h-24 pl-1 text-[11px] text-slate-400 leading-normal overflow-y-auto select-text font-sans">
                    {scene.description || "Aguardando diretrizes visuais. Clique em 'Regerar Prompt' para acionar o Diretor de Arte AI."}
                  </div>
                )}
              </div>
            </div>

            {/* Prompt Real (IA) with Icon-Only Copy Button */}
            <div id={`prompt-section-${scene.id}`} className="bg-[#0a0a0a] border border-[#333] rounded p-3.5 space-y-2 relative flex flex-col justify-between min-h-[140px]">
              <div className="space-y-2 w-full">
                <div className="flex items-center justify-between gap-2 pb-0.5">
                  <span className="text-[9px] font-mono tracking-widest text-[#D4AF37] uppercase flex items-center gap-1.5 font-semibold">
                    <Sparkles size={10} className="text-[#D4AF37]" />
                    Prompt Real (IA)
                  </span>
                  
                  <div className="flex items-center gap-1.5">
                    {modelIndicator && (
                      <span
                        className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${modelIndicator.colorClass}`}
                        title={modelIndicator.tooltip}
                      >
                        {modelIndicator.label}
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={handleCopyPrompt}
                      className="p-1.5 text-[#D4AF37] hover:text-[#fff] hover:bg-[#141414] border border-[#333] rounded cursor-pointer transition-all shadow-md flex items-center justify-center"
                      title="Copiar prompt"
                    >
                      {copied ? (
                        <Check size={11} className="text-emerald-400" />
                      ) : (
                        <Copy size={11} />
                      )}
                    </button>
                  </div>
                </div>
                
                {isManualEditing ? (
                  <textarea
                    value={localPrompt}
                    onChange={(e) => setLocalPrompt(e.target.value)}
                    className="w-full h-24 bg-[#050505] border border-[#333] rounded p-2 text-[11px] text-stone-300 font-mono focus:outline-none focus:border-[#D4AF37]/50 resize-none leading-relaxed"
                  />
                ) : (
                  <div className="min-h-[80px] max-h-24 pl-1 text-[11px] text-stone-300 font-mono leading-relaxed overflow-y-auto select-all">
                    {scene.prompt || "Configure ou gere seu prompt de cena..."}
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* New Generation Guidelines & Setup Area */}
          <div className="bg-[#141414] border border-[#2b2b2b] rounded p-4 space-y-4">
            {/* Free Text Creative Direction / Guidelines & Visual Droplet column */}
            <div className="space-y-1">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center">
                <label className="text-[9px] uppercase tracking-wider text-[#D4AF37]/80 font-mono font-bold block">
                  Instruções para criação
                </label>
                <span className="text-[8px] text-zinc-500 font-mono uppercase sm:text-right">
                  Ex: "mostrar pessoas medíocres no lugar de vencedores"
                </span>
              </div>
              
              <div className="flex gap-2 items-stretch">
                {/* Textarea covering full available width */}
                <textarea
                  value={localGuidelines}
                  onChange={(e) => {
                    setLocalGuidelines(e.target.value);
                  }}
                  onBlur={(e) => {
                    onUpdate(scene.id, { generationGuidelines: e.target.value });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
                      e.preventDefault();
                      if (!isRegenerating && !isQueued) {
                        onUpdate(scene.id, { generationGuidelines: localGuidelines });
                        onRegenerate(index);
                      }
                    }
                  }}
                   className="flex-1 h-[116px] bg-[#050505] border border-[#262626] focus:border-[#D4AF37]/45 hover:border-[#3a3a3a] rounded p-2.5 text-xs text-stone-200 placeholder-stone-600 focus:outline-[#D4AF37]/40 leading-relaxed resize-none transition-all"
                  placeholder="Escreva aqui indicações sobre a direção do prompt que você está procurando (Ex: 'Quero justamente o contrário: mostrar pessoas comuns com feições exaustas e cansadas vivendo uma vida insossa, sem glórias ou propósitos artificiais')."
                />

                {/* Right block: Two generation buttons and Droplet */}
                <div className="flex flex-col gap-1.5 shrink-0 w-[115px]">
                  {/* Button 1: Gerar Prompt */}
                  <button
                    type="button"
                    onClick={() => {
                      onUpdate(scene.id, { generationGuidelines: localGuidelines });
                      onRegenerate(index, false);
                    }}
                    disabled={isRegenerating || isQueued}
                    className={`h-[35px] border border-[#D4AF37]/35 text-[#D4AF37] bg-black hover:bg-[#D4AF37]/10 text-[9px] uppercase tracking-wider transition-all flex items-center justify-center gap-1 cursor-pointer rounded px-1.5 ${
                      isRegenerating || isQueued ? "animate-pulse opacity-50 cursor-wait" : ""
                    }`}
                    title="Gerar apenas o prompt (Sem criar a imagem)"
                  >
                    {isRegenerating ? (
                      <RefreshCw size={10} className="animate-spin" />
                    ) : isQueued ? (
                      <Clock size={10} className="animate-pulse text-[#D4AF37]/80" />
                    ) : (
                      <RefreshCw size={10} />
                    )}
                    <span className="font-bold text-center leading-tight">
                      {isRegenerating ? "Gerando..." : isQueued ? "Fila..." : (scene.prompt ? "Regerar Prompt" : "Gerar Prompt")}
                    </span>
                  </button>

                  {/* Button 2: Prompt + Imagem */}
                  <button
                    type="button"
                    onClick={() => {
                      onUpdate(scene.id, { generationGuidelines: localGuidelines });
                      onRegenerate(index, true);
                    }}
                    disabled={isRegenerating || isQueued}
                    className={`h-[35px] border border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10 hover:bg-[#D4AF37] hover:text-black text-[9px] uppercase tracking-wider transition-all flex items-center justify-center gap-1 cursor-pointer rounded px-1.5 font-bold ${
                      isRegenerating || isQueued ? "animate-pulse opacity-50 cursor-wait" : ""
                    }`}
                    title="Gerar prompt e em seguida iniciar a criação da imagem"
                  >
                    <Sparkles size={10} />
                    <span>Prompt + Imagem</span>
                  </button>

                  {/* Compact Visual Instruction Droplet Zone */}
                  <div 
                    onDragOver={(e) => { e.preventDefault(); setIsDraggingVisualInstruction(true); }}
                    onDragLeave={() => setIsDraggingVisualInstruction(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDraggingVisualInstruction(false);
                      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        processVisualInstructionFile(e.dataTransfer.files[0]);
                      }
                    }}
                    onClick={() => visualInstructionInputRef.current?.click()}
                    className={`h-[34px] border-2 border-dashed rounded flex flex-col items-center justify-center cursor-pointer relative overflow-hidden transition-all text-center ${
                      isDraggingVisualInstruction
                        ? "border-[#D4AF37] bg-[#D4AF37]/10"
                        : scene.visualInstructionImage
                        ? "border-zinc-850 bg-[#050505]"
                        : "border-zinc-850/80 bg-[#050505]/45 hover:border-zinc-700 hover:bg-[#050505]"
                    }`}
                    title="Imagem de referência para esta cena"
                  >
                    <input 
                      ref={visualInstructionInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          processVisualInstructionFile(e.target.files[0]);
                        }
                      }}
                    />

                    {scene.visualInstructionImage ? (
                      <div className="absolute inset-0 group flex items-center justify-center">
                        <img 
                          src={scene.visualInstructionImage} 
                          alt="Instrução Visual" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 bg-black/85 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleClearVisualInstruction(e);
                            }}
                            className="p-1 rounded bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800 transition-colors"
                            title="Remover referência"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center p-1 text-slate-500">
                        <Upload size={12} className="text-zinc-500 mb-0.5" />
                        <span className="text-[8px] font-mono tracking-wider uppercase font-bold text-zinc-500 leading-none">
                          Ref visual
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              {/* Style override dropdown */}
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                  Estilo de Imagem (Cena)
                </label>
                <select
                  value={localSceneStyle}
                  onChange={(e) => {
                    const val = e.target.value as StylePreference;
                    setLocalSceneStyle(val);
                    onUpdate(scene.id, { sceneStylePreference: val });
                  }}
                  className="w-full bg-[#050505] border border-[#333] hover:border-[#555] rounded px-2 py-1 text-xs text-[#E0D8D0] focus:outline-none focus:border-[#D4AF37]/50 cursor-pointer"
                >
                  <option value="auto">Auto</option>
                  <option value="caravaggio">✦ Caravaggio (Chiaroscuro)</option>
                  <option value="urban_realism">❖ Realismo Urbano (Rústico)</option>
                </select>
              </div>

              {/* AI Model dropdown */}
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                  Modelo de IA (Prompt)
                </label>
                <div className="flex gap-1.5">
                  <select
                    value={["gemini-3.5-flash", "gemini-3.1-pro-preview", "chatgpt", "ollama"].includes(localAiModel) ? localAiModel : "custom"}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val !== "custom") {
                        setLocalAiModel(val);
                        onUpdate(scene.id, { promptAiModel: val });
                      } else {
                        setLocalAiModel("");
                        onUpdate(scene.id, { promptAiModel: "" });
                      }
                    }}
                    className="flex-1 bg-[#050505] border border-[#333] hover:border-[#555] rounded px-2 py-1 text-xs text-[#E0D8D0] focus:outline-none focus:border-[#D4AF37]/50 cursor-pointer"
                  >
                    <option value="gemini-3.5-flash">Gemini 3.5 Flash (Padrão e Rápido)</option>
                    <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Reforço Criativo)</option>
                    <option value="chatgpt">ChatGPT (OpenAI API)</option>
                    <option value="ollama">Ollama (Local / Direct-Browser)</option>
                    <option value="custom">✍ Personalizado...</option>
                  </select>

                  {(!["gemini-3.5-flash", "gemini-3.1-pro-preview", "chatgpt", "ollama"].includes(localAiModel) || localAiModel === "") && (
                    <input
                      type="text"
                      value={localAiModel}
                      placeholder="Modelo ID"
                      onChange={(e) => {
                        const val = e.target.value;
                        setLocalAiModel(val);
                        onUpdate(scene.id, { promptAiModel: val });
                      }}
                      className="w-24 bg-[#050505] border border-[#333] rounded px-2 py-1 text-xs text-[#E0D8D0] focus:outline-none focus:border-[#D4AF37]/50 font-mono"
                    />
                  )}
                </div>
              </div>

              {/* Destination Tool dropdown/input */}
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-slate-400 font-mono block">
                  Ferramenta de Destino
                </label>
                <div className="flex gap-1.5">
                  <select
                    value={["Nano Banana", "Flux.1", "Flux.2", "ChatGPT"].includes(localTargetTool) ? localTargetTool : "Custom"}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val !== "Custom") {
                        setLocalTargetTool(val);
                        onUpdate(scene.id, { promptTargetTool: val });
                      } else {
                        setLocalTargetTool("Custom");
                      }
                    }}
                    className="flex-1 bg-[#050505] border border-[#333] hover:border-[#555] rounded px-2 py-1 text-xs text-[#E0D8D0] focus:outline-none focus:border-[#D4AF37]/50 cursor-pointer"
                  >
                    <option value="Nano Banana">Nano Banana</option>
                    <option value="Flux.2">Flux.2</option>
                    <option value="Flux.1">Flux.1</option>
                    <option value="ChatGPT">ChatGPT (Dall-E 3)</option>
                    <option value="Custom">Outra...</option>
                  </select>
                  
                  {(localTargetTool === "Custom" || !["Nano Banana", "Flux.1", "Flux.2", "ChatGPT"].includes(localTargetTool)) && (
                    <input
                      type="text"
                      value={localTargetTool === "Custom" ? "" : localTargetTool}
                      placeholder="Ferramenta..."
                      onChange={(e) => {
                        const val = e.target.value;
                        setLocalTargetTool(val);
                        onUpdate(scene.id, { promptTargetTool: val });
                      }}
                      className="w-24 bg-[#050505] border border-[#333] rounded px-2 py-1 text-xs text-[#E0D8D0] focus:outline-none focus:border-[#D4AF37]/50"
                    />
                  )}
                </div>
              </div>
            </div>
          </div>

          {scene.renderStatus === "failed" && scene.renderError && (
            <div className="bg-rose-950/35 border border-rose-900/50 p-3 rounded text-[10px] text-rose-300 flex items-start gap-2.5 animate-fadeIn">
              <AlertCircle size={14} className="text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1.5">
                <div>
                  <span className="font-bold uppercase tracking-wider block text-rose-400">Falha na Geração:</span>
                  <p className="mt-0.5 font-sans leading-relaxed text-slate-300">{scene.renderError}</p>
                </div>
                <button
                  type="button"
                  onClick={handleQueueImage}
                  className="px-2.5 py-0.5 bg-rose-900/40 hover:bg-rose-900 text-rose-100 text-[9px] uppercase tracking-wider rounded font-mono font-bold border border-rose-800 transition-colors cursor-pointer"
                >
                  Tentar Novamente
                </button>
              </div>
            </div>
          )}


        </div>
      </div>

      {/* NANO BANANA ART STUDIO INTERACTIVE CHAT MODAL */}
      {isStudioOpen && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 sm:p-6 bg-black/95 backdrop-blur-md animate-fadeIn">
          <div 
            className="bg-[#101010] border border-[#2b2b2b] rounded-lg shadow-2xl max-w-6xl w-full flex flex-col h-[85vh] max-h-[85vh] overflow-hidden text-[#E4DCD3]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[#2b2b2b] px-6 py-4 bg-[#141414]">
              <div className="flex items-center gap-2">
                <MessageSquare size={16} className="text-[#D4AF37]" />
                <div>
                  <h3 className="text-sm font-bold tracking-widest uppercase text-white font-mono flex items-center gap-1.5">
                    Estúdio AI Conversacional <span className="text-[10px] text-[#D4AF37] px-1 bg-[#D4AF37]/10 rounded border border-[#D4AF37]/20 font-bold">CHAT</span>
                  </h3>
                  <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">
                    Cena #{sceneNumText} • Memória e Raciocínio Ativo
                  </p>
                </div>
              </div>
              
              <button 
                type="button"
                onClick={() => onCloseStudio?.()}
                className="p-1 px-2.5 text-zinc-400 hover:text-white transition cursor-pointer text-[10px] uppercase tracking-widest font-mono border border-zinc-800 hover:border-zinc-500 rounded bg-[#1c1c1c]"
                title="Fechar estúdio de chat"
              >
                Fechar ×
              </button>
            </div>

            {/* Split Screen Workspace */}
            <div className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">
              
              {/* Left Column: Chat Conversation Thread */}
              <div className="flex-1 flex flex-col h-full border-r border-[#222] bg-[#0c0c0c] min-w-0">
                
                {/* Scrollable Chat Feed */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 min-h-0">
                  {(scene.chatHistory && scene.chatHistory.length > 0 ? scene.chatHistory : [
                    {
                      id: "welcome",
                      role: "assistant" as const,
                      text: `Olá! Eu sou o seu Diretor de Arte do Estúdio AI. Estou pronto para discutir a composição visual da sua cena e fazer edições sucessivas nas imagens conforme conversamos.\n\nO que gostaria de ajustar ou detalhar nesta cena? Peça mudanças de iluminação, estilo, elementos ou clima!`,
                      reasoning: "Analisei a narração original para estabelecer a fundação visual da cena.",
                      imageUrl: scene.generatedImageUrl,
                      timestamp: new Date().toLocaleTimeString()
                    }
                  ]).map((msg: any, msgIdx: number) => (
                    <div 
                      key={`${msg.id || "msg"}-${msgIdx}`} 
                      className={`flex flex-col max-w-[85%] ${
                        msg.role === "user" ? "ml-auto items-end" : "mr-auto items-start"
                      }`}
                    >
                      {/* Speaker title and timestamp */}
                      <span className="text-[8px] uppercase tracking-wider text-zinc-500 font-mono mb-1">
                        {msg.role === "user" ? "Você" : "Diretor Artístico AI"} • {msg.timestamp}
                      </span>

                      {/* Message Bubble */}
                      <div 
                        className={`rounded-lg p-3 text-xs leading-relaxed ${
                          msg.role === "user" 
                            ? "bg-[#D4AF37]/10 text-[#E0D8D0] border border-[#D4AF37]/30" 
                            : "bg-[#161616] text-[#E0D8D0] border border-[#2b2b2b]"
                        }`}
                      >
                        <p className="whitespace-pre-line select-text">{msg.text}</p>

                        {/* Visual Reasoning Block */}
                        {msg.role === "assistant" && msg.reasoning && (
                          <div className="mt-2.5 pt-2 border-t border-zinc-800/85 text-[10px] text-zinc-400 space-y-1">
                            <span className="text-[9px] font-mono tracking-wider uppercase text-[#D4AF37] flex items-center gap-1 font-bold">
                              <Cpu size={10} />
                              Raciocínio & Memória do Diretor:
                            </span>
                            <p className="font-mono italic text-[9px] leading-relaxed bg-[#0a0a0a]/50 p-2 rounded border border-zinc-900 select-text">
                              {msg.reasoning}
                            </p>
                          </div>
                        )}

                        {/* candidate image render inside chat bubble */}
                        {msg.imageUrl && (
                          <div className="mt-3.5 space-y-2">
                            <div className="relative aspect-[16/9] w-full max-w-md rounded overflow-hidden border border-zinc-800 group/chatimg bg-black shadow-inner">
                              <img 
                                src={msg.imageUrl} 
                                alt="Candidato a imagem da cena" 
                                className="w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                              {msg.imageUrl.startsWith("data:image/svg+xml") && (
                                <div className="absolute inset-x-0 bottom-0 bg-amber-950/90 border-t border-amber-500/20 p-2 text-[9px] text-amber-200 flex items-start gap-1.5 backdrop-blur-sm z-10 text-left">
                                  <AlertTriangle size={12} className="text-[#D4AF37] shrink-0 mt-0.5" />
                                  <span className="leading-snug">
                                    <strong>Esboço Standby:</strong> IA real offline ou sem cota. O motivo e diretrizes estão descritos no próprio card.
                                  </span>
                                </div>
                              )}
                              <div className="absolute top-2 right-2 flex gap-1">
                                <a 
                                  href={msg.imageUrl} 
                                  target="_blank" 
                                  rel="noreferrer" 
                                  className="p-1 bg-black/85 text-white rounded hover:bg-black transition text-[9px]"
                                  title="Abrir em nova aba"
                                >
                                  <ExternalLink size={10} />
                                </a>
                              </div>
                              {!msg.imageUrl.startsWith("data:image/svg+xml") && (
                                <div className="absolute bottom-2 left-2 bg-black/80 px-2 py-0.5 rounded text-[8px] font-mono text-zinc-400 border border-zinc-800">
                                  {msg.model || "Nano Banana"}
                                </div>
                              )}
                            </div>

                            {/* Select Image Button */}
                            <button
                              type="button"
                              onClick={() => handleSelectChatImage(msg)}
                              className={`w-full py-1.5 text-[9px] font-mono uppercase font-bold rounded flex items-center justify-center gap-1.5 transition-all ${
                                scene.generatedImageUrl === msg.imageUrl
                                  ? "bg-emerald-950/45 text-emerald-400 border border-emerald-800 cursor-default"
                                  : "bg-[#D4AF37] text-black hover:bg-white cursor-pointer"
                              }`}
                            >
                              <Check size={10} />
                              <span>
                                {scene.generatedImageUrl === msg.imageUrl
                                  ? "Imagem ativa na cena"
                                  : "✓ Usar esta Imagem na Cena"}
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {isChatGenerating && (
                    <div className="flex flex-col items-start max-w-[85%] mr-auto animate-pulse">
                      <span className="text-[8px] uppercase tracking-wider text-zinc-500 font-mono mb-1">
                        Diretor Artístico AI • Pensando...
                      </span>
                      <div className="bg-[#161616] border border-[#2b2b2b] rounded-lg p-4 text-xs text-zinc-400 space-y-2">
                        <div className="flex items-center gap-2 text-[#D4AF37]">
                          <Loader2 size={12} className="animate-spin" />
                          <span>Analisando solicitação e modificando prompt...</span>
                        </div>
                        <div className="h-2 w-48 bg-zinc-850 rounded animate-pulse"></div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Chat Input Dock Area */}
                <form 
                  onSubmit={handleSendChatMessage}
                  className="p-4 border-t border-[#222] bg-[#121212] space-y-3 shrink-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {/* Model selector tabs */}
                    <div className="flex items-center gap-1 bg-black p-1 rounded border border-zinc-800">
                      <span className="text-[8px] font-mono text-zinc-500 uppercase px-1.5 font-bold">Modelo:</span>
                      <button
                        type="button"
                        onClick={() => setSelectedChatModel("nano_banana")}
                        className={`px-2 py-0.5 text-[9px] font-mono uppercase rounded transition-colors cursor-pointer ${
                          selectedChatModel === "nano_banana"
                            ? "bg-[#D4AF37] text-black font-bold"
                            : "text-zinc-400 hover:text-white hover:bg-zinc-900"
                        }`}
                      >
                        NB2 light
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedChatModel("nano_banana_pro")}
                        className={`px-2 py-0.5 text-[9px] font-mono uppercase rounded transition-colors cursor-pointer ${
                          selectedChatModel === "nano_banana_pro"
                            ? "bg-[#D4AF37] text-black font-bold"
                            : "text-zinc-400 hover:text-white hover:bg-zinc-900"
                        }`}
                      >
                        NB Pro
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedChatModel("nano_banana_2")}
                        className={`px-2 py-0.5 text-[9px] font-mono uppercase rounded transition-colors cursor-pointer ${
                          selectedChatModel === "nano_banana_2"
                            ? "bg-[#D4AF37] text-black font-bold"
                            : "text-zinc-400 hover:text-white hover:bg-zinc-900"
                        }`}
                      >
                        NB2
                      </button>
                      {openAiKey && (
                        <button
                          type="button"
                          onClick={() => setSelectedChatModel("chatgpt_dalle3")}
                          className={`px-2 py-0.5 text-[9px] font-mono uppercase rounded transition-colors cursor-pointer flex items-center gap-1 ${
                            selectedChatModel === "chatgpt_dalle3"
                              ? "bg-[#D4AF37] text-black font-bold"
                              : "text-zinc-400 hover:text-white hover:bg-[#2a2a2a]"
                          }`}
                          title={`Usar OpenAI (${openAiDalleModel || "dall-e-3"}) para renderizar após a conversa`}
                        >
                          <span>OpenAI</span>
                          <span className={selectedChatModel === "chatgpt_dalle3" ? "text-[7.5px] text-black/60 lowercase" : "text-[7.5px] text-slate-500 lowercase"}>
                            ({openAiDalleModel || "dall-e-3"})
                          </span>
                        </button>
                      )}
                    </div>

                    <span className="text-[8px] text-zinc-500 font-mono hidden sm:inline">
                      O assistente se recorda de toda a conversa anterior
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Compact Visual Instruction Droplet on the Left */}
                    <div 
                      onDragOver={(e) => { e.preventDefault(); setIsDraggingModalVisualInstruction(true); }}
                      onDragLeave={() => setIsDraggingModalVisualInstruction(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setIsDraggingModalVisualInstruction(false);
                        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                          processVisualInstructionFile(e.dataTransfer.files[0]);
                        }
                      }}
                      onClick={() => modalVisualInstructionInputRef.current?.click()}
                      className={`w-10 h-10 shrink-0 border-2 border-dashed rounded flex items-center justify-center cursor-pointer relative overflow-hidden transition-all ${
                        isDraggingModalVisualInstruction
                          ? "border-[#D4AF37] bg-[#D4AF37]/10"
                          : scene.visualInstructionImage
                          ? "border-zinc-800 bg-[#0c0c0c]"
                          : "border-zinc-805 bg-black/40 hover:border-zinc-700 hover:bg-black/80"
                      }`}
                      title="Anexar imagem de referência/instrução visual para o chat"
                    >
                      <input 
                        ref={modalVisualInstructionInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                            processVisualInstructionFile(e.target.files[0]);
                          }
                        }}
                      />

                      {scene.visualInstructionImage ? (
                        <div className="absolute inset-0 group flex items-center justify-center">
                          <img 
                            src={scene.visualInstructionImage} 
                            alt="Instrução Visual" 
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                          <div className="absolute inset-0 bg-black/85 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleClearVisualInstruction(e);
                              }}
                              className="p-0.5 rounded bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800 transition-colors"
                              title="Remover referência"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-zinc-500 hover:text-zinc-300 flex items-center justify-center">
                          <Upload size={14} />
                        </div>
                      )}
                    </div>

                    {/* Chat Input Field */}
                    <input
                      type="text"
                      value={chatInputText}
                      onChange={(e) => setChatInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          if (!isChatGenerating && chatInputText.trim()) {
                            handleSendChatMessage(e);
                          }
                        }
                      }}
                      disabled={isChatGenerating}
                      className="flex-1 h-10 bg-black border border-zinc-800 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-[#D4AF37]/50 placeholder-zinc-650"
                      placeholder="Descreva mudanças: 'Adicione mais mistério', 'Mude a iluminação para luz de velas' (Ctrl+Enter)..."
                    />

                    {/* Small Paper Plane Button on the Right */}
                    <button
                      type="submit"
                      disabled={isChatGenerating || !chatInputText.trim()}
                      className="w-10 h-10 shrink-0 bg-[#D4AF37] hover:bg-white text-black rounded flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      title="Conversar e Renderizar (Ctrl+Enter)"
                    >
                      {isChatGenerating ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Send size={14} />
                      )}
                    </button>
                  </div>
                </form>
              </div>

              {/* Right Column: Active Scene Preview */}
              <div className="w-full lg:w-[35%] bg-[#121212] p-5 flex flex-col justify-between overflow-y-auto space-y-4">
                <div className="space-y-4">
                  <span className="text-[9px] font-mono tracking-widest uppercase text-zinc-500 block font-bold border-b border-zinc-800 pb-1.5">
                    Ilustração Ativa da Cena
                  </span>

                  {/* Active Widescreen 16:9 Image Preview */}
                  <div className="relative aspect-[16/9] w-full rounded overflow-hidden border border-[#333] bg-black">
                    {scene.generatedImageUrl ? (
                      <>
                        <img 
                          src={scene.generatedImageUrl} 
                          alt="Imagem Ativa" 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            const target = e.currentTarget;
                            const retries = parseInt(target.getAttribute("data-retries") || "0");
                            if (retries < 5) {
                              target.setAttribute("data-retries", String(retries + 1));
                              setTimeout(() => {
                                const baseSrc = target.src.split("?")[0];
                                target.src = "";
                                target.src = baseSrc + "?retry=" + Date.now();
                              }, 1000);
                            }
                          }}
                        />
                        {scene.generatedImageUrl.startsWith("data:image/svg+xml") && (
                          <div className="absolute top-2 left-2 right-2 bg-amber-950/95 border border-amber-500/25 p-2 text-[8px] text-amber-200 flex items-start gap-1.5 rounded-md backdrop-blur-sm z-10 text-left animate-fadeIn shadow-lg">
                            <AlertTriangle size={12} className="text-[#D4AF37] shrink-0 mt-0.5" />
                            <div className="flex-1 leading-snug">
                              <strong>Esboço de Standby Ativo:</strong> Motor de IA offline ou limite de faturamento excedido. Veja o motivo exato desenhado no próprio card.
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600">
                        <ImageIcon size={28} className="opacity-40 mb-1" />
                        <span className="text-[9px] font-mono uppercase tracking-widest">Sem imagem ativa</span>
                      </div>
                    )}
                  </div>



                  {/* Active Scene Meta */}
                  <div className="space-y-3 font-mono text-[10px] bg-black/45 p-3.5 rounded border border-zinc-850">
                    <div>
                      <span className="text-zinc-500 uppercase block">Texto/Narração original:</span>
                      <p className="text-[#E0D8D0] font-sans italic mt-0.5 text-xs leading-relaxed select-text">
                        "{scene.text}"
                      </p>
                    </div>

                    <div className="border-t border-zinc-900 pt-2">
                      <span className="text-[#D4AF37] uppercase block">Diretriz Visual (PT-BR):</span>
                      <p className="text-zinc-300 font-sans mt-0.5 text-[10px] leading-relaxed max-h-24 overflow-y-auto select-text font-light">
                        {scene.description || "Nenhuma diretriz"}
                      </p>
                    </div>

                    <div className="border-t border-zinc-900 pt-2">
                      <span className="text-[#D4AF37] uppercase block">Prompt de Imagem Ativo (EN):</span>
                      <p className="text-zinc-400 mt-0.5 text-[9px] leading-relaxed font-mono max-h-24 overflow-y-auto select-all">
                        {scene.prompt || "Nenhum prompt"}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="border-t border-zinc-800/85 pt-4">
                  <button
                    type="button"
                    onClick={() => onCloseStudio?.()}
                    className="w-full py-2 bg-zinc-900 hover:bg-zinc-800 text-[#E0D8D0] border border-zinc-800 font-mono text-[9px] uppercase tracking-widest rounded cursor-pointer transition-colors"
                  >
                    Pronto e Concluído
                  </button>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}
    </>
  );
}
