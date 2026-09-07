import React, { useEffect, useRef, useState } from "react";
import { Save, ChevronDown, Loader2, X } from "lucide-react";

export default function ProjectSaveMenu({ disabled, busy, name, onSave, onSaveAs, onTransfer, openSaveAsTrigger }: {
  disabled: boolean; busy: boolean; name: string;
  onSave: () => Promise<void>; onSaveAs: (name: string) => Promise<void>;
  onTransfer: (mode: "move" | "copy") => Promise<void>;
  openSaveAsTrigger?: number;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"name" | "move" | "copy" | null>(null);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const lastTrigger = useRef(0);

  useEffect(() => {
    if (openSaveAsTrigger && openSaveAsTrigger !== lastTrigger.current && !busy && !disabled) {
      lastTrigger.current = openSaveAsTrigger;
      setDraft(name);
      setError("");
      setDialog("name");
      setOpen(false);
    }
  }, [openSaveAsTrigger, name, busy, disabled]);

  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !running && !busy) { setOpen(false); setDialog(null); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [running, busy]);
  const execute = async (action: () => Promise<void>) => {
    setError(""); setRunning(true);
    try { await action(); setDialog(null); setOpen(false); }
    catch (err: any) { setError(err.message); }
    finally { setRunning(false); }
  };
  return <div className="relative" ref={root}>
    <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy || running}
      onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[10px] uppercase font-mono font-bold text-slate-300 hover:text-[#D4AF37] disabled:opacity-40">
      {busy || running ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Salvar <ChevronDown size={12} />
    </button>
    {open && <div role="menu" aria-label="Salvar projeto" className="absolute left-0 top-full mt-2 z-[100] w-64 rounded-xl border border-[#D4AF37]/35 bg-[#121212] p-1.5 shadow-2xl text-xs text-stone-100 backdrop-blur-md animate-fadeIn"
      onKeyDown={e => {
        const items = Array.from((e.currentTarget as HTMLDivElement).querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus(); }
      }}>
      <button role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-zinc-800/80 transition-colors font-sans cursor-pointer" onClick={() => void execute(onSave)}>Salvar <span className="float-right text-zinc-500 font-mono text-[10px]">Ctrl+S</span></button>
      <button role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-zinc-800/80 transition-colors font-sans cursor-pointer" onClick={() => { setDraft(name); setError(""); setDialog("name"); setOpen(false); }}>Salvar como…</button>
      <div className="my-1 border-t border-zinc-850" />
      <button role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-zinc-800/80 transition-colors font-sans cursor-pointer" onClick={() => { setError(""); setDialog("move"); setOpen(false); }}>Mover projeto para…</button>
      <button role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-zinc-800/80 transition-colors font-sans cursor-pointer" onClick={() => { setError(""); setDialog("copy"); setOpen(false); }}>Copiar projeto para…</button>
      {error && <p role="alert" className="p-2 text-xs text-rose-300">{error}</p>}
    </div>}
    {dialog && <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="project-operation-title">
      <form className="w-full max-w-lg rounded-xl border border-[#D4AF37]/45 bg-[#121212] p-6 text-stone-100 shadow-2xl flex flex-col space-y-4 animate-scaleUp" onSubmit={e => { e.preventDefault(); void execute(() => dialog === "name" ? onSaveAs(draft.trim()) : onTransfer(dialog)); }}>
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <h2 id="project-operation-title" className="text-sm sm:text-base font-serif tracking-widest uppercase text-white font-semibold">
            {dialog === "name" ? "Salvar como" : dialog === "move" ? "Mover projeto para" : "Copiar projeto para"}
          </h2>
          <button type="button" aria-label="Fechar" disabled={running || busy} onClick={() => setDialog(null)} className="text-slate-400 hover:text-white transition-colors cursor-pointer">
            <X size={18}/>
          </button>
        </div>
        {dialog === "name" ? <>
          <label className="block text-xs font-mono uppercase tracking-wider text-slate-300">
            Nome do projeto
            <input autoFocus value={draft} disabled={running || busy} onChange={e => setDraft(e.target.value)} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900/90 px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[#D4AF37]" />
          </label>
          <p className="text-xs text-zinc-400 leading-relaxed font-sans">O novo arquivo .dmproj será salvo nesta pasta, reutilizando as mídias. O arquivo anterior será preservado intacto.</p>
        </> : <p className="text-xs leading-relaxed text-zinc-300 font-sans bg-zinc-900/70 p-3.5 rounded-lg border border-zinc-800">Escolha uma pasta vazia. Todos os arquivos da pasta do projeto serão {dialog === "move" ? "movidos" : "copiados"}, incluindo imagens, áudio, cache, backups e projetos salvos com outros nomes. {dialog === "move" ? "A origem só será removida depois da verificação completa. O projeto continuará aberto no destino." : "Você continuará trabalhando no projeto original."}</p>}
        {error && <p role="alert" className="p-2.5 rounded bg-rose-950/60 border border-rose-900/60 text-xs text-rose-200">{error}</p>}
        <div className="mt-4 flex justify-end gap-3 pt-2">
          <button type="button" disabled={running || busy} onClick={() => setDialog(null)} className="rounded-lg border border-zinc-700 bg-transparent hover:bg-zinc-800/80 px-4 py-2 text-xs uppercase font-mono tracking-wider text-slate-400 hover:text-white transition-all cursor-pointer">Cancelar</button>
          <button type="submit" disabled={running || busy || (dialog === "name" && !draft.trim())} className="rounded-lg bg-[#D4AF37] hover:bg-[#c49f30] px-5 py-2 text-xs uppercase font-mono tracking-wider font-semibold text-black disabled:opacity-40 transition-all cursor-pointer">{running || busy ? "Aguarde…" : dialog === "name" ? "Salvar novo arquivo" : "Escolher pasta…"}</button>
        </div>
      </form>
    </div>}
  </div>;
}
