import React from "react";
import { StylePreference, ArtisticStyle } from "../types";
import { Sparkles, FileText, Film, MessageSquareCode, Upload, X, Image as ImageIcon, AlertCircle, Settings } from "lucide-react";
import { resizeAndCompressImage } from "../utils";
import OpenAiTranscriptionModelRadios from "./OpenAiTranscriptionModelRadios";

import { Mic, Volume2 } from "lucide-react";

interface ScriptInputAreaProps {
  onGenerate: (text: string, style: StylePreference, referenceImage?: string, selectedEngine?: "gemini" | "openai" | "ollama") => void;
  onGenerateWithAudio?: (params: { text: string; style: StylePreference; referenceImage?: string; selectedEngine?: "gemini" | "openai" | "ollama"; transcriptionEngine?: "gemini" | "openai"; audioFile?: File | null; audioBase64?: string; audioMimeType?: string; audioFileName?: string; audioPath?: string; openAiAudioModel?: string; openAiTextModel?: string }) => void;
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
  preferredEngine?: "gemini" | "openai" | "ollama";
  onPreferredEngineChange?: (engine: "gemini" | "openai" | "ollama") => void;
  preferredTranscriptionEngine?: "gemini" | "openai";
  onPreferredTranscriptionEngineChange?: (engine: "gemini" | "openai") => void;
  openAiAudioModel?: string;
  onOpenAiAudioModelChange?: (model: string) => void;
  openAiTextModel?: string;
  onOpenAiTextModelChange?: (model: string) => void;
  availableOpenAiTextModels?: string[];
  onGoToSettings?: () => void;
  artisticStyles: ArtisticStyle[];
}

export default function ScriptInputArea({
  onGenerate,
  onGenerateWithAudio,
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
  preferredEngine,
  onPreferredEngineChange,
  preferredTranscriptionEngine,
  onPreferredTranscriptionEngineChange,
  openAiAudioModel = "whisper-1",
  onOpenAiAudioModelChange,
  openAiTextModel = "gpt-4o",
  onOpenAiTextModelChange,
  availableOpenAiTextModels = [],
  onGoToSettings,
  artisticStyles,
}: ScriptInputAreaProps) {
  const [isDragActive, setIsDragActive] = React.useState(false);
  const [localScriptText, setLocalScriptText] = React.useState(scriptText);
  const [showNewProjectForm, setShowNewProjectForm] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const audioInputRef = React.useRef<HTMLInputElement>(null);

  const [audioFile, setAudioFile] = React.useState<File | null>(null);
  const [audioBase64, setAudioBase64] = React.useState<string | undefined>();
  const [audioMimeType, setAudioMimeType] = React.useState<string | undefined>();
  const [audioFileName, setAudioFileName] = React.useState<string | undefined>();
  const [audioPath, setAudioPath] = React.useState<string | undefined>();
  const hasAudio = !!(audioFile || audioBase64 || audioFileName || audioPath);

  const [localSelectedEngine, setLocalSelectedEngine] = React.useState<"gemini" | "openai" | "ollama">(
    useOpenAiForPrompts ? "openai" : "gemini"
  );
  const selectedEngine = preferredEngine ?? localSelectedEngine;
  const selectEngine = (engine: "gemini" | "openai" | "ollama") => {
    setLocalSelectedEngine(engine);
    onPreferredEngineChange?.(engine);
  };
  const [localTranscriptionEngine, setLocalTranscriptionEngine] = React.useState<"gemini" | "openai">(
    useOpenAiForPrompts ? "openai" : "gemini"
  );
  const transcriptionEngine = preferredTranscriptionEngine ?? localTranscriptionEngine;
  const selectTranscriptionEngine = (engine: "gemini" | "openai") => {
    setLocalTranscriptionEngine(engine);
    onPreferredTranscriptionEngineChange?.(engine);
  };

  const [localOpenAiAudioModel, setLocalOpenAiAudioModel] = React.useState<string>(openAiAudioModel || "whisper-1");
  const effectiveOpenAiAudioModel = onOpenAiAudioModelChange ? openAiAudioModel : localOpenAiAudioModel;
  const selectOpenAiAudioModel = (model: string) => {
    setLocalOpenAiAudioModel(model);
    onOpenAiAudioModelChange?.(model);
  };
  React.useEffect(() => {
    if (openAiAudioModel) setLocalOpenAiAudioModel(openAiAudioModel);
  }, [openAiAudioModel]);

  const [localOpenAiTextModel, setLocalOpenAiTextModel] = React.useState<string>(openAiTextModel || "gpt-4o");
  const effectiveOpenAiTextModel = onOpenAiTextModelChange ? openAiTextModel : localOpenAiTextModel;
  const selectOpenAiTextModel = (model: string) => {
    setLocalOpenAiTextModel(model);
    onOpenAiTextModelChange?.(model);
  };
  React.useEffect(() => {
    if (openAiTextModel) setLocalOpenAiTextModel(openAiTextModel);
  }, [openAiTextModel]);

  React.useEffect(() => {
    setLocalScriptText(scriptText);
  }, [scriptText]);

  // Sync with global settings when props change
  React.useEffect(() => {
    if (preferredEngine === undefined && localSelectedEngine !== "ollama") {
      setLocalSelectedEngine(useOpenAiForPrompts ? "openai" : "gemini");
    }
  }, [useOpenAiForPrompts, preferredEngine]);

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

  const handleAudioFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setAudioFile(file);
      setAudioFileName(file.name);
      setAudioMimeType(file.type || "audio/mp3");
      setAudioPath(undefined);

      // Only convert small audio files (<5MB) to data URL for inline preview, avoid memory crash on large WAVs
      if (file.size < 5 * 1024 * 1024) {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
            setAudioBase64(event.target.result as string);
          }
        };
        reader.readAsDataURL(file);
      } else {
        setAudioBase64(undefined);
      }
    }
  };

  const handleBrowseAudioFile = async () => {
    try {
      const response = await fetch("/api/storyboard/browse-audio-file", { method: "POST" });
      const data = await response.json();
      if (data.success && data.filePath) {
        setAudioPath(data.filePath);
        setAudioFileName(data.fileName);
        setAudioFile(null);
        setAudioBase64(undefined);
        const ext = data.fileName.toLowerCase();
        if (ext.endsWith(".wav")) setAudioMimeType("audio/wav");
        else if (ext.endsWith(".mp3")) setAudioMimeType("audio/mp3");
        else if (ext.endsWith(".m4a")) setAudioMimeType("audio/mp4");
        else setAudioMimeType("audio/mp3");
      }
    } catch (err) {
      console.error("Erro ao abrir seletor nativo de áudio:", err);
    }
  };

  const handleClearAudio = () => {
    setAudioFile(null);
    setAudioBase64(undefined);
    setAudioMimeType(undefined);
    setAudioFileName(undefined);
    setAudioPath(undefined);
    if (audioInputRef.current) audioInputRef.current.value = "";
  };

  const executeGeneration = () => {
    if (onGenerateWithAudio && hasAudio) {
      onGenerateWithAudio({
        text: localScriptText.trim(),
        style: selectedStyle,
        referenceImage: scriptReferenceImage,
        selectedEngine,
        transcriptionEngine,
        audioFile,
        audioBase64,
        audioMimeType,
        audioFileName,
        audioPath,
        openAiAudioModel: effectiveOpenAiAudioModel,
        openAiTextModel: effectiveOpenAiTextModel
      });
    } else {
      onGenerate(localScriptText.trim(), selectedStyle, scriptReferenceImage, selectedEngine);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const hasText = !!localScriptText.trim();

    if (!hasAudio && !hasText) return;

    if (hasScenes) {
      setShowConfirmReset(true);
      const modalEl = document.getElementById("script-input-section");
      if (modalEl) {
        modalEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    executeGeneration();
  };

  const handleConfirmNewProject = () => {
    setShowConfirmReset(false);
    setShowNewProjectForm(false);
    executeGeneration();
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

          <div className={hasAudio ? "grid grid-cols-1 md:grid-cols-2 gap-3" : "grid grid-cols-1 gap-3"}>
            {hasAudio && (
              <div className="bg-[#0a0a0a] border border-[#222] p-3.5 rounded-lg space-y-2">
                <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.15em] font-mono">
                  1. Transcrição do áudio
                </label>
                <div className="grid grid-cols-2 gap-2 font-mono">
                  {(["openai", "gemini"] as const).map((engine) => (
                    <button
                      key={engine}
                      type="button"
                      onClick={() => selectTranscriptionEngine(engine)}
                      className={`py-2 rounded text-[10px] uppercase font-bold border cursor-pointer ${transcriptionEngine === engine ? "bg-[#D4AF37]/20 border-[#D4AF37] text-[#D4AF37]" : "border-[#333] text-zinc-400"}`}
                    >
                      {engine === "openai" ? "🎙️ OpenAI" : "♊ Gemini"}
                    </button>
                  ))}
                </div>
                {transcriptionEngine === "openai" && (
                  <OpenAiTranscriptionModelRadios
                    value={effectiveOpenAiAudioModel}
                    onChange={selectOpenAiAudioModel}
                    compact
                  />
                )}
              </div>
            )}

            <div className="bg-[#0a0a0a] border border-[#222] p-3.5 rounded-lg space-y-2">
              <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.15em] font-mono">
                {hasAudio ? "2. Divisão narrativa em cenas" : "Divisão narrativa em cenas"}
              </label>
              <div className="grid grid-cols-3 gap-2 font-mono">
                {(["openai", "gemini", "ollama"] as const).map((engine) => (
                  <button
                    key={engine}
                    type="button"
                    onClick={() => selectEngine(engine)}
                    className={`py-2 rounded text-[9px] uppercase font-bold border cursor-pointer ${selectedEngine === engine ? "bg-[#D4AF37]/20 border-[#D4AF37] text-[#D4AF37]" : "border-[#333] text-zinc-400"}`}
                  >
                    {engine}
                  </button>
                ))}
              </div>
              {selectedEngine === "openai" && (
                <select
                  value={effectiveOpenAiTextModel}
                  onChange={(e) => selectOpenAiTextModel(e.target.value)}
                  className="w-full bg-[#111] border border-[#333] rounded px-2 py-2 text-[10px] font-mono text-white"
                >
                  {Array.from(new Set([effectiveOpenAiTextModel, ...availableOpenAiTextModels])).map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              )}
            </div>
          </div>
          {(((hasAudio && transcriptionEngine === "openai") || selectedEngine === "openai") && !openAiKey) && (
            <p className="text-[9.5px] text-rose-400 font-mono">⚠️ Chave OpenAI ausente em Conexões.</p>
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
          {/* Narrative script input & Audio dropzone (12 cols) */}
          <div className="md:col-span-12">
            {/* Audio Upload Dropzone */}
            <div className="mb-3 p-3 bg-[#0a0a0a] border border-[#333] hover:border-[#D4AF37]/40 rounded-lg flex flex-col sm:flex-row items-center justify-between gap-3 transition-colors">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-full bg-[#D4AF37]/10 text-[#D4AF37]">
                  <Mic size={18} />
                </div>
                <div>
                  <span className="text-[11px] font-bold text-stone-200 block uppercase font-mono tracking-wider">
                    {audioFileName ? `🎙️ ${audioFileName}` : "Anexar Áudio da Narração (MP3 / WAV)"}
                  </span>
                  <span className="text-[9px] text-zinc-400 block font-sans">
                    {audioFileName
                      ? "Áudio carregado. O DiarioMaker vai transcrever e extrair os timecodes das cenas."
                      : "Opcional. Transcreve automaticamente o áudio e gera as cenas com timecodes sincronizados."}
                  </span>
                </div>
              </div>

              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={handleAudioFileChange}
              />

              {audioFileName ? (
                <button
                  type="button"
                  onClick={handleClearAudio}
                  className="px-3 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900 border border-rose-800 text-rose-300 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  <X size={12} />
                  <span>Remover Áudio</span>
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => audioInputRef.current?.click()}
                    className="px-3.5 py-2 rounded bg-[#222] hover:bg-[#333] border border-[#444] text-[#D4AF37] hover:border-[#D4AF37] text-[10px] font-mono font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shadow-md"
                    title="Fazer upload de um arquivo de áudio via navegador"
                  >
                    <Upload size={12} />
                    <span>Upload</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleBrowseAudioFile}
                    className="px-3.5 py-2 rounded bg-emerald-900/40 hover:bg-emerald-600 border border-emerald-500/60 text-emerald-400 hover:text-white text-[10px] font-mono font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shadow-md"
                    title="Modo NLE: Vincular arquivo de áudio direto do HD sem upload"
                  >
                    <FileText size={12} />
                    <span>Linkar Áudio (NLE)</span>
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <label htmlFor="raw-script-area" className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.2em] font-mono">
                Roteiro / Instruções de Roteiro {audioFileName ? "(Preenchimento automático se deixado em branco)" : ""}
              </label>
            </div>
            <textarea
              id="raw-script-area"
              value={localScriptText}
              onChange={(e) => setLocalScriptText(e.target.value)}
              onBlur={() => setScriptText(localScriptText)}
              placeholder={audioFileName ? "Deixe em branco para utilizar a transcrição automática do áudio, ou cole seu texto para guiar..." : "Digite ou cole aqui seu roteiro de meditação ou instruções de criação..."}
              className="w-full h-44 bg-[#0a0a0a] border border-[#333] rounded p-4 text-xs text-[#E0D8D0] placeholder-slate-600 focus:outline-none focus:border-[#D4AF37]/50 font-sans leading-relaxed resize-y"
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
          {hasAudio && (
            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.15em] font-mono">
                1. Transcrição do áudio
              </label>
              <div className="grid grid-cols-2 gap-1.5 bg-[#0A0A0A] p-1 border border-[#333] rounded">
                {(["openai", "gemini"] as const).map((engine) => (
                  <button
                    key={engine}
                    type="button"
                    onClick={() => selectTranscriptionEngine(engine)}
                    className={`text-[9px] py-2 rounded uppercase font-semibold cursor-pointer ${transcriptionEngine === engine ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37]" : "text-slate-400"}`}
                  >
                    {engine === "openai" ? "OpenAI" : "Gemini"}
                  </button>
                ))}
              </div>
              {transcriptionEngine === "openai" && (
                <OpenAiTranscriptionModelRadios
                  value={effectiveOpenAiAudioModel}
                  onChange={selectOpenAiAudioModel}
                  compact
                />
              )}
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-[10px] font-bold text-[#D4AF37] uppercase tracking-[0.2em] mb-2 font-mono flex items-center gap-1">
              <Sparkles size={11} className="text-[#D4AF37]" />
              {hasAudio ? "2. Divisão narrativa em cenas" : "Divisão narrativa em cenas"}
            </label>
            <div className="grid grid-cols-3 gap-1.5 bg-[#0A0A0A] p-1 border border-[#333] rounded">
              <button
                type="button"
                onClick={() => selectEngine("gemini")}
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
                onClick={() => selectEngine("openai")}
                className={`text-[9px] py-2 px-1 rounded uppercase tracking-wider font-semibold transition-all cursor-pointer text-center truncate ${
                  selectedEngine === "openai"
                    ? "bg-[#D4AF37]/20 border border-[#D4AF37] text-[#D4AF37] shadow-sm"
                    : "text-slate-400 hover:text-[#E0D8D0] hover:bg-[#161616]"
                }`}
                title="Usar ChatGPT para processar o roteiro"
              >
                ChatGPT
              </button>
              <button
                type="button"
                onClick={() => selectEngine("ollama")}
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
            {selectedEngine === "openai" && (
              <select
                value={effectiveOpenAiTextModel}
                onChange={(e) => selectOpenAiTextModel(e.target.value)}
                className="w-full bg-[#0A0A0A] border border-[#333] rounded px-2 py-1.5 text-[9px] font-mono text-white"
              >
                {Array.from(new Set([effectiveOpenAiTextModel, ...availableOpenAiTextModels])).map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            )}
            {selectedEngine === "openai" && !openAiKey && (
              <p className="text-[8px] text-rose-400 mt-1 font-mono absolute">
                ⚠️ Chave OpenAI ausente em Conexões!
              </p>
            )}
          </div>

          <div>
            <button
              type="submit"
              disabled={isGenerating || (!localScriptText.trim() && !hasAudio)}
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
                  <span>{hasAudio ? "Transcrever Áudio e Gerar Storyboard" : "Gerar Storyboard"}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
