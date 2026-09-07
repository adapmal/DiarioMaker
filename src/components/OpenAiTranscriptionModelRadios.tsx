import { useId } from "react";

export type OpenAiTranscriptionModel = "gpt-transcribe" | "whisper-1";

interface OpenAiTranscriptionModelRadiosProps {
  value: string;
  onChange: (model: OpenAiTranscriptionModel) => void;
  compact?: boolean;
}

const MODEL_OPTIONS: Array<{
  id: OpenAiTranscriptionModel;
  name: string;
  badge: string;
  description: string;
}> = [
  {
    id: "gpt-transcribe",
    name: "GPT Transcribe",
    badge: "Melhor texto",
    description: "Transcrição textual sem marcações de tempo por palavra. Para sincronizar cenas, escolha Whisper-1."
  },
  {
    id: "whisper-1",
    name: "Whisper-1",
    badge: "Foco em timecodes",
    description: "Marcação clássica por palavra e segmento, ideal para sincronização."
  }
];

export function normalizeOpenAiTranscriptionChoice(model?: string): OpenAiTranscriptionModel {
  const m = String(model || "").trim().toLowerCase();
  if (m.includes("gpt")) return "gpt-transcribe";
  if (m.includes("whisper")) return "whisper-1";
  return "whisper-1";
}

export default function OpenAiTranscriptionModelRadios({
  value,
  onChange,
  compact = false
}: OpenAiTranscriptionModelRadiosProps) {
  const groupName = useId();
  const selectedModel = normalizeOpenAiTranscriptionChoice(value);

  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[9px] font-bold uppercase tracking-[0.12em] text-zinc-400 font-mono">
        Modelo OpenAI para transcrição
      </legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {MODEL_OPTIONS.map((option) => {
          const isSelected = selectedModel === option.id;
          return (
            <label
              key={option.id}
              className={`flex items-start gap-2 rounded border cursor-pointer transition-colors select-none ${
                compact ? "p-2" : "p-2.5"
              } ${
                isSelected
                  ? "border-[#D4AF37] bg-[#D4AF37]/10 text-white"
                  : "border-[#333] bg-[#111] text-zinc-400 hover:border-zinc-500"
              }`}
            >
              <input
                type="radio"
                name={groupName}
                value={option.id}
                checked={isSelected}
                onChange={() => onChange(option.id)}
                className="mt-0.5 shrink-0 accent-[#D4AF37] cursor-pointer"
              />
              <span className="min-w-0 pointer-events-none">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-bold font-mono">{option.name}</span>
                  <span className={`text-[8px] uppercase tracking-wide font-bold ${option.id === "whisper-1" ? "text-emerald-400" : "text-[#D4AF37]"}`}>
                    {option.badge}
                  </span>
                </span>
                <span className="block mt-0.5 text-[8.5px] leading-snug text-zinc-500">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
