import { useEffect, useRef, useState } from "react";
import { getCachedImage, setCachedImage, deleteCachedImage } from "./cacheStore";

export interface DocumentLocation { id: string; root: string; fileName: string; name: string; revision: number }
export interface DocumentResult { location: DocumentLocation; data: any; updatedAt: string; warning?: string; cancelled?: boolean }
const assetKeys = new Set(["url", "imageUrl", "generatedImageUrl", "visualInstructionImage", "scriptReferenceImage", "audioNarrationUrl", "audioUrl", "currentImageUrl"]);
export async function documentRequest(url: string, payload?: any) {
  const response = await fetch(url, payload === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Falha ao salvar (HTTP ${response.status}).`);
  return data;
}
async function resolveBrowserMedia(value: any, key = ""): Promise<any> {
  if (typeof value === "string" && assetKeys.has(key)) {
    if (value.startsWith("idb://")) {
      const cached = await getCachedImage(value.slice(6));
      if (!cached) throw new Error("Uma imagem não foi encontrada no cache. Recupere a mídia antes de salvar.");
      return cached;
    }
    if (value.startsWith("blob:")) {
      const response = await fetch(value); if (!response.ok) throw new Error("Não foi possível ler uma mídia temporária.");
      const blob = await response.blob();
      return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
    }
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => resolveBrowserMedia(item)));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveBrowserMedia(v, k)])));
  return value;
}

export function useProjectPersistence(snapshot: any, enabled: boolean, legacyFolder: string) {
  const [location, setLocation] = useState<DocumentLocation | null>(null);
  const [status, setStatus] = useState("Alterações não salvas");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const statusRef = useRef(status); statusRef.current = status;
  const doc = useRef<DocumentLocation | null>(null);
  const latest = useRef(snapshot); latest.current = snapshot;
  const folder = useRef(legacyFolder); folder.current = legacyFolder;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const tail = useRef<Promise<any>>(Promise.resolve());
  const sequence = useRef(0);
  const generation = useRef(0);
  const locked = useRef(false);
  const mounted = useRef(true);
  const migrationFolder = useRef<string | undefined>(undefined);
  const targetDirectory = useRef<string | undefined>(undefined);
  const draftTail = useRef<Promise<any>>(Promise.resolve());
  const adopt = (result: DocumentResult) => {
    generation.current++; doc.current = result.location; setLocation(result.location);
    setFailure(null); setStatus(`Salvo às ${new Date(result.updatedAt).toLocaleTimeString()}`);
  };
  const draft = (state: any, baseRevision?: number) => {
    const key = `draft_document_${doc.current?.id || "unsaved"}`;
    const data = JSON.stringify({ state, baseRevision: baseRevision ?? doc.current?.revision ?? 0, savedAt: Date.now() });
    draftTail.current = draftTail.current.catch(() => {}).then(() => setCachedImage(key, data));
    return draftTail.current;
  };
  const save = (): Promise<DocumentResult> => {
    clearTimeout(timer.current);
    const state = latest.current; const version = sequence.current; const epoch = generation.current;
    const run = async () => {
      if (epoch !== generation.current) throw new Error("O documento ativo mudou. Salve novamente.");
      setStatus("Salvando…");
      try {
        await draft(state);
        const resolved = await resolveBrowserMedia(state);
        const current = doc.current;
        const result: DocumentResult = current
          ? await documentRequest(`/api/project-documents/${current.id}/save`, { state: resolved, baseRevision: current.revision, operationId: crypto.randomUUID() })
          : await documentRequest("/api/project-documents/create", { state: resolved, legacyFolder: migrationFolder.current ?? folder.current, targetDirectory: targetDirectory.current });
        if (epoch !== generation.current) return result;
        doc.current = result.location;
        if (mounted.current) { setLocation(result.location); setFailure(null); }
        if (version === sequence.current) {
          await draftTail.current;
          await deleteCachedImage(`draft_document_${current?.id || "unsaved"}`);
          if (mounted.current) setStatus(`Salvo às ${new Date(result.updatedAt).toLocaleTimeString()}`);
        } else {
          await draft(latest.current, result.location.revision);
          if (mounted.current) setStatus("Alterações não salvas");
        }
        return result;
      } catch (err: any) {
        if (mounted.current) { setFailure(err.message); setStatus("Falha ao salvar — alterações preservadas"); }
        throw err;
      }
    };
    const result = tail.current.catch(() => {}).then(run); tail.current = result;
    return result;
  };
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => {
    if (!enabled || locked.current) return;
    sequence.current++; setStatus("Alterações não salvas");
    void draft(snapshot).catch(() => {});
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveRef.current().catch(() => {}); }, 1000);
    return () => clearTimeout(timer.current);
  }, [snapshot, enabled]);
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!statusRef.current.startsWith("Salvo às")) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { mounted.current = false; clearTimeout(timer.current); window.removeEventListener("beforeunload", beforeUnload); };
  }, []);
  const exclusive = async <T,>(work: (result: DocumentResult) => Promise<T>): Promise<T> => {
    if (locked.current) throw new Error("Aguarde a operação atual.");
    locked.current = true; setBusy(true);
    try { const result = await save(); return await work(result); }
    finally { locked.current = false; setBusy(false); }
  };
  return {
    location, status, failure, busy, adopt, save,
    currentLocation: () => doc.current,
    async saveAs(name: string) {
      // Save As can preserve a conflicted local version without overwriting the original.
      if (locked.current) throw new Error("Aguarde a operação atual.");
      locked.current = true; setBusy(true); clearTimeout(timer.current);
      try {
        await tail.current.catch(() => {});
        if (!doc.current) await save();
        const result = await documentRequest(`/api/project-documents/${doc.current!.id}/save-as`, { name, state: await resolveBrowserMedia(latest.current) });
        adopt(result); return result as DocumentResult;
      } finally { locked.current = false; setBusy(false); }
    },
    transfer(mode: "move" | "copy") {
      return exclusive(async saved => {
        const destination = await documentRequest("/api/project-documents/choose-folder", {});
        if (destination.cancelled) return null;
        setStatus(mode === "move" ? "Movendo e verificando arquivos…" : "Copiando e verificando arquivos…");
        const result = await documentRequest(`/api/project-documents/${saved.location.id}/transfer`, { token: destination.token, mode });
        if (mode === "move") adopt(result);
        else setStatus(`Salvo às ${new Date(saved.updatedAt).toLocaleTimeString()}`);
        return result as DocumentResult;
      }).catch(err => { setFailure(err.message); setStatus("Transferência não concluída — confira a origem"); throw err; });
    },
    reveal() {
      if (doc.current) {
        return documentRequest(`/api/project-documents/${doc.current.id}/reveal`, {});
      }
      return exclusive(async saved => { await documentRequest(`/api/project-documents/${saved.location.id}/reveal`, {}); });
    },
    async open() {
      if (locked.current) throw new Error("Aguarde a operação atual.");
      locked.current = true; setBusy(true); clearTimeout(timer.current);
      try {
      if (enabled) await save();
      const result = await documentRequest("/api/project-documents/open", {});
      if (result.cancelled) return null;
      adopt(result); return result as DocumentResult;
      } finally { locked.current = false; setBusy(false); }
    },
    async startNew(newLocation?: DocumentLocation, newDoc?: DocumentResult, newFolder?: string, newTargetDirectory?: string) {
      if (enabled) await save();
      clearTimeout(timer.current); generation.current++; doc.current = null; setLocation(null);
      migrationFolder.current = newFolder || "";
      targetDirectory.current = newTargetDirectory || "";
      setStatus("Alterações não salvas"); setFailure(null);
    },
    async recoverDraft(state: any, draftKey?: string) {
      clearTimeout(timer.current);
      const original = doc.current?.id || "unsaved";
      const name = `${(doc.current?.name || state.projectName || "Projeto").slice(0, 65)} - recuperado ${Date.now()}`;
      const resolved = await resolveBrowserMedia(state);
      const result = doc.current
        ? await documentRequest(`/api/project-documents/${doc.current.id}/save-as`, { name, state: resolved })
        : await documentRequest("/api/project-documents/create", { state: { ...resolved, projectName: name } });
      await deleteCachedImage(draftKey || `draft_document_${original}`);
      adopt(result); return result as DocumentResult;
    },
    async discardDraft(draftKey?: string) { await deleteCachedImage(draftKey || `draft_document_${doc.current?.id || "unsaved"}`); },
    async recovery(id: string) {
      for (const draftKey of new Set([`draft_document_${id}`, "draft_document_unsaved"])) {
        const raw = await getCachedImage(draftKey);
        if (raw) { try { return { ...JSON.parse(raw), draftKey }; } catch {} }
      }
      return null;
    },
  };
}
