import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, ChevronDown } from "lucide-react";

export default function ProjectOpenMenu({ disabled, onOpen, onImport }: {
  disabled: boolean;
  onOpen: () => void;
  onImport: React.ChangeEventHandler<HTMLInputElement>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const itemClass = "block w-full rounded-lg px-3 py-2 text-left hover:bg-zinc-800/80 focus:bg-zinc-800/80 transition-colors font-sans cursor-pointer";
  return <div ref={root} className="relative" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
      }}
      className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-mono font-bold text-slate-400 hover:text-[#D4AF37] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
      <FolderOpen size={10} className="text-[#D4AF37]/70" /> Abrir <ChevronDown size={12} />
    </button>
    {open && !disabled && <div ref={menu} role="menu" aria-label="Abrir projeto"
      className="absolute left-0 top-full mt-2 z-[100] w-64 rounded-xl border border-[#D4AF37]/35 bg-[#121212] p-1.5 shadow-2xl text-xs text-stone-100"
      onKeyDown={event => {
        const items = Array.from((event.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        }
      }}>
      <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); onOpen(); }}>
        Abrir projeto…
        <span className="block mt-0.5 text-[10px] text-zinc-500">.dmproj</span>
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => {
        close();
        if (input.current) { input.current.value = ""; input.current.click(); }
      }}>
        Importar projeto antigo…
        <span className="block mt-0.5 text-[10px] text-zinc-500">.dmaker, .diariomaker, .json</span>
      </button>
    </div>}
    <input ref={input} type="file" accept=".dmaker,.diariomaker,.json" className="hidden" disabled={disabled} onChange={onImport} />
  </div>;
}
