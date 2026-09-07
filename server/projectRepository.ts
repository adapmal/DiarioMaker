import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { storeProjectImage } from "./imageStore";

export class ProjectError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface ProjectLocation { id: string; root: string; fileName: string; name: string; revision: number; legacyFolder?: string }
interface Asset { path: string; mime: string; hash: string; size: number }
interface Document { format: "diariomaker"; version: 2; id: string; name: string; revision: number; updatedAt: string; assets: Record<string, Asset>; state: any; operationId?: string }
interface Registry { current?: string; documents: Record<string, ProjectLocation> }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const mediaKeys = new Set(["url", "imageUrl", "generatedImageUrl", "visualInstructionImage", "scriptReferenceImage", "audioNarrationUrl", "audioUrl", "currentImageUrl"]);
const secretKeys = /^(customGeminiKey|customOpenAiKey|openAiKey|customApiKey|apiKey|geminiApiKey|openaiApiKey|secrets|secret)$/i;
const mimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac" };

export function projectName(value: unknown): string {
  if (typeof value !== "string") throw new ProjectError("Informe o nome do projeto.");
  const name = value.trim().replace(/\.dmproj$/i, "");
  if (!name || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new ProjectError("Nome inválido para um arquivo de projeto no Windows.");
  return name;
}
function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
export async function confinedFile(root: string, relative: string) {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new ProjectError(`Pasta não encontrada: ${root}`, 404);
    throw err;
  }
  const target = path.resolve(realRoot, relative);
  if (!within(realRoot, target) || target === realRoot) throw new ProjectError("Arquivo fora da pasta autorizada.", 403);
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new ProjectError(`Arquivo não encontrado: ${relative}`, 404);
    throw err;
  }
  if (!within(realRoot, real) || !(await fs.stat(real)).isFile()) throw new ProjectError("Arquivo fora da pasta autorizada.", 403);
  return real;
}
export async function atomicJson(target: string, data: unknown) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp-" + randomUUID();
  try {
    const file = await fs.open(tmp, "wx");
    try { await file.writeFile(JSON.stringify(data, null, 2), "utf8"); await file.sync(); } finally { await file.close(); }
    await fs.rename(tmp, target);
  } finally { await fs.unlink(tmp).catch(err => { if (err.code !== "ENOENT") throw err; }); }
}
async function exists(file: string) { try { await fs.stat(file); return true; } catch (err: any) { if (err.code === "ENOENT") return false; throw err; } }
async function walk(root: string, dir = ""): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new ProjectError("A pasta contém um link/junction. Use uma pasta de projeto com arquivos locais.");
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await walk(root, relative));
    else if (entry.isFile()) { await confinedFile(root, relative); results.push(relative); }
  }
  return results;
}

export class ProjectRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(public workspace: string) {}
  private get registryFile() { return path.join(this.workspace, "project_registry.json"); }
  private async registry(): Promise<Registry> {
    if (!await exists(this.registryFile)) return { documents: {} };
    return JSON.parse(await fs.readFile(this.registryFile, "utf8"));
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => {}); return result;
  }
  private async record(id: string) {
    const r = await this.registry(); const p = r.documents[id];
    if (!p) throw new ProjectError("Projeto não registrado. Abra o arquivo .dmproj novamente.", 404);
    return p;
  }
  private async document(p: ProjectLocation): Promise<Document> {
    const file = await confinedFile(p.root, p.fileName);
    const doc = JSON.parse(await fs.readFile(file, "utf8"));
    if (doc.format !== "diariomaker" || doc.version !== 2 || doc.id !== p.id || !Array.isArray(doc.state?.scenes)) throw new ProjectError("Arquivo de projeto inválido ou versão não suportada.");
    return doc;
  }
  private hydrate(doc: Document, id: string): any {
    const visit = (value: any): any => {
      if (typeof value === "string" && value.startsWith("asset://")) return `/api/project-documents/${id}/assets/${encodeURIComponent(value.slice(8))}`;
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]));
      return value;
    };
    return { ...visit(doc.state), projectName: doc.name };
  }
  private result(p: ProjectLocation, d: Document) { return { location: { ...p, name: d.name, revision: d.revision }, data: this.hydrate(d, p.id), updatedAt: d.updatedAt }; }
  async list() { return Object.values((await this.registry()).documents); }
  async current() { const r = await this.registry(); return r.current ? this.load(r.current) : null; }
  async load(id: string) { const p = await this.record(id); return this.result(p, await this.document(p)); }
  async root(id: string) { return (await this.record(id)).root; }
  async asset(id: string, key: string) {
    const p = await this.record(id); const d = await this.document(p); const asset = d.assets[key];
    if (!asset) throw new ProjectError("Mídia não encontrada.", 404);
    return { file: await confinedFile(p.root, asset.path), mime: asset.mime };
  }
  async legacyRoot(folder: string) {
    const r = await this.registry();
    return Object.values(r.documents).find(p => p.legacyFolder === folder)?.root;
  }
  private async readMedia(url: string, p: ProjectLocation, doc: Document): Promise<{ bytes: Buffer; mime: string }> {
    if (url.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
      if (!match || !/^(image|audio)\//.test(match[1])) throw new ProjectError("Mídia incorporada inválida.");
      return { bytes: Buffer.from(match[2], "base64"), mime: match[1] };
    }
    let source: string;
    const servedFile = /^\/api\/project-documents\/([^/]+)\/files\?path=(.+)$/.exec(url);
    if (servedFile) {
      source = await confinedFile(await this.root(decodeURIComponent(servedFile[1])), decodeURIComponent(servedFile[2]));
      const mime = mimeByExtension[path.extname(source).toLowerCase()];
      if (!mime) throw new ProjectError("Mídia inválida.");
      return { bytes: await fs.readFile(source), mime };
    }
    const served = /^\/api\/project-documents\/([^/]+)\/assets\/([^/?]+)$/.exec(url);
    if (served) { const item = await this.asset(decodeURIComponent(served[1]), decodeURIComponent(served[2])); return { bytes: await fs.readFile(item.file), mime: item.mime }; }
    if (url.startsWith("asset://")) {
      const a = doc.assets[url.slice(8)]; if (!a) throw new ProjectError("Referência de mídia ausente.");
      source = await confinedFile(p.root, a.path);
    } else if (url.startsWith("/projects/")) {
      const match = /^\/projects\/([^/]+)\/(.+)$/.exec(decodeURIComponent(url.split("?")[0]));
      if (!match || /[\\/:]/.test(match[1]) || match[1] === "..") throw new ProjectError("Caminho de mídia inválido.");
      const root = await this.legacyRoot(match[1]) || path.join(this.workspace, "projects", match[1]);
      source = await confinedFile(root, match[2]);
    } else if (url.startsWith("/api/storyboard/stream-local-audio?")) {
      source = new URL(url, "http://localhost").searchParams.get("path") || "";
      if (!path.isAbsolute(source) || !mimeByExtension[path.extname(source).toLowerCase()]?.startsWith("audio/")) throw new ProjectError("Áudio local inválido.");
      source = await fs.realpath(source);
    } else if (url.startsWith("/api/projects/")) {
      const match = /^\/api\/projects\/([^/]+)\/narration\.(\w+)$/.exec(decodeURIComponent(url));
      if (!match) throw new ProjectError("Referência de narração inválida.");
      const folder = match[1].replace(/[^a-zA-Z0-9_\-]/g, "_");
      source = await confinedFile(path.join(this.workspace, "projects", folder), `narration.${match[2]}`);
    } else if (/^https?:\/\//.test(url)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const mime = response.headers.get("content-type")?.split(";")[0] || "";
      if (!response.ok || !/^(image|audio)\//.test(mime)) throw new ProjectError("Não foi possível incorporar uma mídia remota. O projeto não foi marcado como salvo.");
      return { bytes: Buffer.from(await response.arrayBuffer()), mime };
    } else if (url.startsWith("idb://") || url.startsWith("blob:")) {
      throw new ProjectError("Há uma mídia no navegador que ainda não foi enviada ao disco.");
    } else {
      source = await confinedFile(p.root, url);
    }
    const mime = mimeByExtension[path.extname(source).toLowerCase()];
    if (!mime) throw new ProjectError("Formato de mídia desconhecido.");
    return { bytes: await fs.readFile(source), mime };
  }
  private async materialize(p: ProjectLocation, doc: Document, state: any) {
    const cache = new Map<string, Promise<string>>();
    const media = (url: string, key = ""): Promise<string> => {
      if (cache.has(url)) return cache.get(url)!;
      const work = (async () => {
        if (url.startsWith("asset://") && doc.assets[url.slice(8)]) {
          try {
            await confinedFile(p.root, doc.assets[url.slice(8)].path);
            return url;
          } catch {
            return url;
          }
        }
        const own = `/api/project-documents/${p.id}/assets/`;
        if (url.startsWith(own)) {
          const keyName = decodeURIComponent(url.slice(own.length));
          if (doc.assets[keyName]) {
            try {
              await confinedFile(p.root, doc.assets[keyName].path);
              return `asset://${keyName}`;
            } catch {
              return url;
            }
          }
        }
        let bytes: Buffer, mime: string;
        try {
          const res = await this.readMedia(url, p, doc);
          bytes = res.bytes;
          mime = res.mime;
        } catch (err: any) {
          if (key === "url" && err instanceof ProjectError && err.status === 404) {
            console.warn(`[ProjectRepository] Mídia secundária ausente ignorada durante salvamento: ${url}`);
            return url;
          }
          throw err;
        }
        const digest = hash(bytes);
        const ext = Object.keys(mimeByExtension).find(e => mimeByExtension[e] === mime);
        if (!ext) throw new ProjectError(`Formato de mídia não suportado: ${mime}`);
        const keyName = digest + ext;
        const relative = `midias/${mime.startsWith("audio/") ? "audio" : "imagens"}/${keyName}`;
        const target = path.join(p.root, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const realDirectory = await fs.realpath(path.dirname(target));
        if (!within(await fs.realpath(p.root), realDirectory)) throw new ProjectError("Pasta de mídia fora do projeto.", 403);
        if (mime.startsWith("image/") && ext !== ".gif") {
          const filename = await storeProjectImage(path.dirname(target), bytes, ext);
          doc.assets[keyName] = { path: `midias/imagens/${filename}`, mime, hash: digest, size: bytes.length };
          return `asset://${keyName}`;
        }
        if (!await exists(target)) {
          const temp = target + ".tmp-" + randomUUID();
          await fs.writeFile(temp, bytes, { flag: "wx" }); await fs.rename(temp, target);
        } else if (hash(await fs.readFile(await confinedFile(p.root, relative))) !== digest) throw new ProjectError("Arquivo de mídia corrompido no destino.");
        doc.assets[keyName] = { path: relative, mime, hash: digest, size: bytes.length };
        return `asset://${keyName}`;
      })();
      cache.set(url, work); return work;
    };
    const visit = async (value: any, key = ""): Promise<any> => {
      if (typeof value === "string" && value && mediaKeys.has(key)) return media(value, key);
      if (Array.isArray(value)) return Promise.all(value.map(v => visit(v, key)));
      if (value && typeof value === "object") {
        const entries = await Promise.all(Object.entries(value).filter(([k]) => !secretKeys.test(k)).map(async ([k, v]) => [k, await visit(v, k)]));
        return Object.fromEntries(entries);
      }
      return value;
    };
    return visit(state);
  }
  private async saveUnlocked(p: ProjectLocation, state: any, baseRevision: number, operationId: string, fresh?: Document) {
    if (!Array.isArray(state?.scenes)) throw new ProjectError("Projeto sem lista de cenas válida.");
    const d = fresh || await this.document(p);
    if (!fresh && operationId && d.operationId === operationId) return this.result(p, d);
    if (d.revision !== baseRevision) throw new ProjectError("Outra versão deste projeto foi salva. Reabra o arquivo ou use Salvar como para preservar suas alterações.", 409);
    const old = JSON.parse(JSON.stringify(d));
    d.state = await this.materialize(p, d, state);
    d.state.projectName = p.name; d.name = p.name;
    d.revision++; d.updatedAt = new Date().toISOString(); d.operationId = operationId;
    if (!fresh) await atomicJson(path.join(p.root, "backups", p.id, `r${old.revision}.dmproj`), old);
    await fs.mkdir(path.join(p.root, "cache", p.id), { recursive: true });
    await atomicJson(path.join(p.root, p.fileName), d);
    const registry = await this.registry();
    registry.current = p.id; registry.documents[p.id] = { ...p, revision: d.revision };
    await atomicJson(this.registryFile, registry);
    return this.result(registry.documents[p.id], d);
  }
  save(id: string, state: any, revision: number, operationId: string) { return this.serial(async () => this.saveUnlocked(await this.record(id), state, revision, operationId)); }
  create(state: any, folder?: string, targetDirectory?: string) {
    return this.serial(async () => {
      const name = projectName(state.projectName || "Meu projeto"); const id = randomUUID();
      let root: string;
      let legacyFolder: string | undefined;

      if (targetDirectory && typeof targetDirectory === "string" && targetDirectory.trim()) {
        root = path.resolve(targetDirectory.trim());
      } else if (folder && path.isAbsolute(folder)) {
        root = path.resolve(folder);
      } else {
        legacyFolder = folder && !/[\\/:\x00]/.test(folder) && folder !== "." && folder !== ".." ? folder : undefined;
        root = path.join(this.workspace, "projects", legacyFolder || `${name}-${id.slice(0, 8)}`);
      }
      await fs.mkdir(root, { recursive: true });
      const realRoot = await fs.realpath(root);
      let fileName = name + ".dmproj";
      if (await exists(path.join(root, fileName))) fileName = `${name}-${id.slice(0, 8)}.dmproj`;
      const p = { id, root: realRoot, fileName, name, revision: 0, legacyFolder };
      return this.saveUnlocked(p, state, 0, randomUUID(), { format: "diariomaker", version: 2, id, name, revision: 0, updatedAt: "", assets: {}, state: {} });
    });
  }
  saveAs(id: string, nameInput: string, state: any) {
    return this.serial(async () => {
      const p = await this.record(id); const name = projectName(nameInput);
      const fileName = name + ".dmproj";
      if (await exists(path.join(p.root, fileName))) throw new ProjectError("Já existe um projeto com esse nome nesta pasta. Escolha outro nome.", 409);
      const d = await this.document(p); const nextId = randomUUID();
      const next = { ...p, id: nextId, fileName, name, revision: 0 };
      return this.saveUnlocked(next, state, 0, randomUUID(), { ...d, id: nextId, name, revision: 0 });
    });
  }
  open(file: string) {
    return this.serial(async () => {
      const real = await fs.realpath(file);
      if (!real.toLowerCase().endsWith(".dmproj")) throw new ProjectError("Selecione um arquivo .dmproj.");
      const d: Document = JSON.parse(await fs.readFile(real, "utf8"));
      if (d.format !== "diariomaker" || d.version !== 2 || !Array.isArray(d.state?.scenes) || !/^[\w-]+$/.test(d.id)) throw new ProjectError("Arquivo de projeto inválido.");
      const p = { id: d.id, root: path.dirname(real), fileName: path.basename(real), name: d.name, revision: d.revision };
      for (const a of Object.values(d.assets)) await confinedFile(p.root, a.path);
      const r = await this.registry();
      if (r.documents[p.id] && r.documents[p.id].root !== p.root && await exists(path.join(r.documents[p.id].root, r.documents[p.id].fileName))) {
        throw new ProjectError("Este arquivo é uma cópia manual de um projeto ainda registrado. Use Copiar projeto para criar uma cópia independente.", 409);
      }
      r.documents[p.id] = p; r.current = p.id; await atomicJson(this.registryFile, r);
      return this.result(p, d);
    });
  }
  transfer(id: string, destination: string, mode: "copy" | "move") {
    return this.serial(async () => {
      const p = await this.record(id); const source = await fs.realpath(p.root); const target = await fs.realpath(destination);
      if (within(source, target) || within(target, source)) throw new ProjectError("Escolha uma pasta fora da origem, que não contenha o projeto atual.");
      if ((await fs.readdir(target)).length) throw new ProjectError("Escolha uma pasta vazia para evitar misturar ou sobrescrever arquivos.");
      const files = await walk(source);
      const operation = randomUUID(); const staging = path.join(target, `.transfer-${operation}`);
      await fs.mkdir(staging);
      const journalFile = path.join(this.workspace, "project-transfers", operation + ".json");
      await atomicJson(journalFile, { mode, source, target, staging, phase: "copying", files });
      // Never delete source until every file is copied and verified, including cache and old versions.
      const fingerprints = new Map<string, string>();
      for (const relative of files) {
        const src = await confinedFile(source, relative); const dst = path.join(staging, relative);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        const before = hash(await fs.readFile(src));
        await fs.copyFile(src, dst);
        if (hash(await fs.readFile(dst)) !== before) throw new ProjectError("Falha ao verificar cópia. A origem foi preservada.");
        fingerprints.set(relative, before);
      }
      // Empty cache directories also belong to the transferred project.
      await fs.mkdir(path.join(staging, "cache"), { recursive: true });
      const r = await this.registry(); const active = await this.document(p);
      let nextId = id;
      if (mode === "copy") {
        const ids = new Map<string, string>();
        for (const relative of files.filter(f => f.endsWith(".dmproj") && !f.startsWith("backups" + path.sep))) {
          const d = JSON.parse(await fs.readFile(path.join(staging, relative), "utf8"));
          if (d.format !== "diariomaker") continue;
          const old = d.id; d.id = randomUUID(); ids.set(old, d.id);
          if (old === id) nextId = d.id;
          await atomicJson(path.join(staging, relative), d);
        }
      }
      // Detect writes by other processes during copying before committing the destination.
      if (JSON.stringify((await walk(source)).sort()) !== JSON.stringify([...files].sort())) throw new ProjectError("A pasta mudou durante a transferência. A origem foi preservada.");
      for (const [relative, digest] of fingerprints) if (hash(await fs.readFile(await confinedFile(source, relative))) !== digest) throw new ProjectError("Um arquivo mudou durante a transferência. A origem foi preservada.");
      for (const entry of await fs.readdir(staging)) await fs.rename(path.join(staging, entry), path.join(target, entry));
      await fs.rmdir(staging);
      await atomicJson(journalFile, { mode, source, target, phase: "destination-ready", files });
      const next = { ...p, id: nextId, root: target, legacyFolder: mode === "move" ? p.legacyFolder : undefined };
      if (mode === "move") {
        for (const item of Object.values(r.documents)) if (item.root === source) item.root = target;
        r.current = id;
      }
      r.documents[nextId] = next;
      await atomicJson(this.registryFile, r);
      let warning: string | undefined;
      if (mode === "move") {
        // Remove only verified files inside the exact registered source root. No recursive rm.
        try {
          for (const [relative, digest] of fingerprints) {
            const file = await confinedFile(source, relative);
            if (hash(await fs.readFile(file)) !== digest) throw new Error("Arquivo alterado na origem; preservado.");
            await fs.unlink(file);
          }
          const removeEmpty = async (dir: string) => {
            if (!within(source, await fs.realpath(dir))) throw new Error("Diretório fora da origem.");
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await removeEmpty(path.join(dir, entry.name));
            await fs.rmdir(dir);
          };
          await removeEmpty(source);
        } catch { warning = "O destino está pronto, mas alguns arquivos permaneceram na origem. Não os remova sem verificar suas referências."; }
      }
      await atomicJson(journalFile, { mode, source, target, phase: warning ? "cleanup-pending" : "complete", warning });
      return { ...this.result(next, { ...active, id: nextId }), warning, copied: mode === "copy" };
    });
  }
}
