import React from "react";
import { StylePreference, ArtisticStyle } from "../types";
import { Sparkles, FileText, Film, MessageSquareCode, Upload, X, Image as ImageIcon, AlertCircle, Settings } from "lucide-react";
import { resizeAndCompressImage } from "../utils";

interface ScriptInputAreaProps {
  onGenerate: (text: string, style: StylePreference, referenceImage?: string, selectedEngine?: "gemini" | "openai" | "ollama") => void;
  isGenerating: boolean;
  scriptText: string;
  setScriptText: (text: string) => void;
  selectedStyle: StylePreference;
  setSelectedStyle: (style: StylePreference) => void;
  scriptReferenceImage?: string;
  setScriptReferenceImage: (img?: string) => void;
  hasScenes?: boolean;
  useOpenAiForPrompts?: boolean;
  openAiKey?: string;
  onGoToSettings?: () => void;
  artisticStyles: ArtisticStyle[];
}

export default function ScriptInputArea({
  onGenerate,
  isGenerating,
  scriptText,
  setScriptText,
  selectedStyle,
  setSelectedStyle,
  scriptReferenceImage,
  setScriptReferenceImage,
  hasScenes = false,
  useOpenAiForPrompts = false,
  openAiKey = "",
  onGoToSettings,
  artisticStyles,
}: ScriptInputAreaProps) {
  const [isDragActive, setIsDragActive] = React.useState(false);
  const [localScriptText, setLocalScriptText] = React.useState(scriptText);
  const [showNewProjectForm, setShowNewProjectForm] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [selectedEngine, setSelectedEngine] = React.useState<"gemini" | "openai" | "ollama">("gemini");

  React.useEffect(() => {
    setLocalScriptText(scriptText);
  }, [scriptText]);

  // Sync with global settings when props change
  React.useEffect(() => {
    if (selectedEngine !== "ollama") {
      setSelectedEngine(useOpenAiForPrompts && openAiKey ? "openai" : "gemini");
    }
  }, [useOpenAiForPrompts, openAiKey]);

  // Reset new project form toggle if project becomes empty
  React.useEffect(() => {
    if (!hasScenes) {
      setShowNewProjectForm(false);
    }
  }, [hasScenes]);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  const handleFile = async (file: File) => {
    if (file && file.type.startsWith("image/")) {
      try {
        const compressedBase64 = await resizeAndCompressImage(file, 800, 0.75);
        setScriptReferenceImage(compressedBase64);
      } catch (err) {
        console.error("Erro ao processar imagem de referência:", err);
      }
    }
  };

  const onButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleClearImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScriptReferenceImage(undefined);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const [showConfirmReset, setShowConfirmReset] = React.useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (localScriptText.trim()) {
      if (hasScenes) {
        setShowConfirmReset(true);
      } else {
        setScriptText(localScriptText);
        onGenerate(localScriptText, selectedStyle, scriptReferenceImage, selectedEngine);
      }
    }
  };

  const handleConfirmNewProject = () => {
    setShowConfirmReset(false);
    setScriptText(localScriptText);
    onGenerate(localScriptText, selectedStyle, scriptReferenceImage, selectedEngine);
  };

  // 1. Read-only view for active projects (scenes present)
  if (hasScenes && !showNewProjectForm) {
    return (
      <div id="script-input-section" className="bg-[#161616] border border-[#D4AF37]/25 rounded-lg shadow-2xl p-6 text-[#E0D8D0] relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-5 pointer-events-none">
          <Film size={200} className="text-[#D4AF37]" />
        </div>

        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded bg-[#D4AF37]/10 text-[#D4AF37]">
              <FileText size={18} />
            </div>
            <h2 id="script-input-title" className="text-sm font-serif tracking-widest uppercase text-[#D4AF37] font-semibold">
              Roteiro do Projeto Ativo
            </h2>
          </div>
          <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded border border-emerald-400/20 uppercase tracking-wider">
            Iniciado
          </span>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.2em] mb-2 font-mono">
              Texto Completo do Roteiro
            </label>
            <div className="w-full h-64 bg-[#0a0a0a] border border-[#222] rounded p-4 text-xs text-slate-300 font-sans leading-relaxed overflow-y-auto whitespace-pre-wrap select-text selection:bg-[#D4AF37]/30">
              {scriptText || "Nenhum roteiro carregado neste projeto ativo."}
            </div>
          </div>

          {scriptReferenceImage && (
            <div>
              <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.2em] mb-2 font-mono">
                Estilo / Imagem de Referência
              </label>
              <div className="relative w-36 h-20 rounded overflow-hidden border border-[#333]">
                <img src={scriptReferenceImage} alt="Estilo Referência" className="w-full h-full object-cover" />
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-[#222] grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setShowNewProjectForm(true)}
              className="py-3 px-4 bg-zinc-900 border border-zinc-800 hover:bg-zinc-850 hover:border-zinc-750 text-slate-300 font-bold uppercase tracking-[0.12em] text-[10px] rounded transition-all cursor-pointer text-center font-mono flex items-center justify-center gap-1.5"
            >
              <span>🆕 Novo Roteiro / Iniciar Outro</span>
            </button>
            {onGoToSettings && (
              <button
                type="button"
                onClick={onGoToSettings}
                className="py-3 px-4 bg-[#D4AF37]/10 border border-[#D4AF37]/30 hover:bg-[#D4AF37]/25 hover:border-[#D4AF37] text-[#D4AF37] font-bold uppercase tracking-[0.12em] text-[10px] rounded transition-all cursor-pointer text-center font-mono flex items-center justify-center gap-1.5"
              >
                <Settings size={12} />
                <span>Configurações</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 2. New project setup / edit script form
  return (
    <div id="script-input-section" className="bg-[#161616] border border-[#D4AF37]/25 rounded-lg shadow-2xl p-6 text-[#E0D8D0] relative overflow-hidden">
      <div className="absolute top-0 right-0 p-8 opacity-5 pointer-events-none">
        <Film size={200} className="text-[#D4AF37]" />
      </div>

      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded bg-[#D4AF37]/10 text-[#D4AF37]">
            <FileText size={18} />
          </div>
          <h2 id="script-input-title" className="text-sm font-serif tracking-widest uppercase text-[#D4AF37] font-semibold">
            Configurar Novo Projeto
          </h2>
        </div>
        {hasScenes && (
          <button
            type="button"
            onClick={() => setShowNewProjectForm(false)}
            className="text-[10px] font-mono text-slate-400 hover:text-white transition-colors cursor-pointer uppercase tracking-wider"
          >
            ← Voltar ao Roteiro
          </button>
        )}
      </div>

      {showConfirmReset && (
        <div className="bg-amber-950/40 border border-amber-500/30 rounded p-4 mb-5 space-y-3 animate-fadeIn">
          <div className="flex items-start gap-2.5">
            <AlertCircle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="text-xs font-bold font-mono text-amber-400 uppercase tracking-wider">Substituir Storyboard Atual?</h4>
              <p className="text-[11px] text-amber-250 leading-relaxed text-slate-300">
                Você já tem um storyboard com cenas geradas. Ao prosseguir, o projeto atual será reiniciado e novas cenas serão estruturadas. Esta ação não pode ser desfeita.
              </p>
            </div>
          </div>
          <div className="flex gap-2.5 justify-end">
            <button
              type="button"
              onClick={() => setShowConfirmReset(false)}
              className="px-3 py-1.5 rounded bg-[#222] hover:bg-[#333] border border-[#444] text-[10px] font-mono font-bold text-slate-300 uppercase tracking-wider transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirmNewProject}
              className="px-3 py-1.5 rounded bg-amber-500 text-black hover:bg-amber-400 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer"
            >
              Sim, Substituir e Gerar
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
          {/* Narrative script input (12 cols) */}
          <div className="md:col-span-12">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <label htmlFor="raw-script-area" className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.2em] font-mono">
                Roteiro / Instruções de Roteiro
              </label>
            </div>
            <textarea
              id="raw-script-area"
              value={localScriptText}
              onChange={(e) => setLocalScriptText(e.target.value)}
              onBlur={() => setScriptText(localScriptText)}
              placeholder="Digite ou cole aqui seu roteiro de meditação ou instruções de criação..."
              className="w-full h-56 bg-[#0a0a0a] border border-[#333] rounded p-4 text-xs text-[#E0D8D0] placeholder-slate-600 focus:outline-none focus:border-[#D4AF37]/50 font-sans leading-relaxed resize-y"
              required
              disabled={isGenerating}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end pt-2">
          {/* Style Preference Selector */}
          <div>
            <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.2em] mb-2 font-mono flex items-center gap-1">
              <Sparkles size={11} className="text-[#D4AF37]" />
              Diretriz Artística (Mecanismo IA)
            </label>
            <div className="flex flex-wrap gap-1 bg-[#0A0A0A] p-1 border border-[#333] rounded max-h-[100px] overflow-y-auto">
              <button
                type="button"
                onClick={() => setSelectedStyle("auto")}
                className={`text-[9px] py-1.5 px-2 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer ${
                  selectedStyle === "auto"
                    ? "bg-[#D4AF37]/20 border border-[#D4AF37]/45 text-[#D4AF37] shadow-sm"
                    : "text-slate-400 hover:text-[#E0D8D0] hover:bg-[#161616]"
                }`}
              >
                Auto Detect
              </button>
              {artisticStyles && artisticStyles.map((style) => (
                <button
                  key={style.id}
                  type="button"
                  onClick={() => setSelectedStyle(style.id)}
                  className={`text-[9px] py-1.5 px-2 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer ${
                    selectedStyle === style.id
                      ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] shadow-sm"
                      : "text-slate-400 hover:text-[#E0D8D0] hover:bg-[#161616]"
                  }`}
                  title={style.name}
                >
                  {style.name}
                </button>
              ))}
            </div>
          </div>

          {/* AI Engine Selector for Segmenter */}
          <div>
            <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.2em] mb-2 font-mono flex items-center gap-1">
              <Sparkles size={11} className="text-[#D4AF37]" />
              Motor de IA (Segmentação)
            </label>
            <div className="grid grid-cols-3 gap-1.5 bg-[#0A0A0A] p-1 border border-[#333] rounded">
              <button
                type="button"
                onClick={() => setSelectedEngine("gemini")}
                className={`text-[9px] py-2 px-1 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer text-center truncate ${
                  selectedEngine === "gemini"
                    ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] shadow-sm"
                    : "text-slate-400 hover:text-[#E0D8D0] hover:bg-[#161616]"
                }`}
                title="Usar Gemini 3.5 Flash para processar o roteiro (Altamente Recomendado)"
              >
                Gemini 3.5
              </button>
              <button
                type="button"
                onClick={() => setSelectedEngine("openai")}
                className={`text-[9px] py-2 px-1 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer text-center truncate ${
                  selectedEngine === "openai"
                    ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] shadow-sm"
                    : "text-slate-400 hover:text-[#E0D8D0] hover:bg-[#161616]"
                }`}
                title="Usar OpenAI ChatGPT para processar o roteiro"
              >
                ChatGPT
              </button>
              <button
                type="button"
                onClick={() => setSelectedEngine("ollama")}
                className={`text-[9px] py-2 px-1 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer text-center truncate ${
                  selectedEngine === "ollama"
                    ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] shadow-sm"
                    : "text-slate-400 hover:text-[#E0D8D0] hover:bg-[#161616]"
                }`}
                title="Usar Ollama Local para processar o roteiro offline"
              >
                Ollama
              </button>
            </div>
            {selectedEngine === "openai" && !openAiKey && (
              <p className="text-[8px] text-rose-400 mt-1 font-mono absolute">
                ⚠️ Chave OpenAI ausente em Conexões!
              </p>
            )}
          </div>

          <div>
            <button
              type="submit"
              disabled={isGenerating || !localScriptText.trim()}
              id="generate-storyboard-submit"
              className={`w-full py-3.5 px-4 rounded font-bold uppercase tracking-[0.2em] text-xs transition-all flex items-center justify-center gap-2 relative shadow-2xl ${
                isGenerating
                  ? "bg-[#222] border border-[#333] text-slate-500 cursor-not-allowed"
                  : "bg-[#D4AF37] text-[#0F0F0F] hover:bg-[#f6d55c] active:scale-[0.98] cursor-pointer"
              }`}
            >
              {isGenerating ? (
                <>
                  <div className="w-3 h-3 border-2 border-slate-600 border-t-[#D4AF37] rounded-full animate-spin"></div>
                  <span className="animate-pulse">Criando Storyboard...</span>
                </>
              ) : (
                <>
                  <Sparkles size={14} className="text-[#0F0F0F]" />
                  <span>Gerar Storyboard</span>
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
