import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { ProjectError, ProjectRepository, confinedFile } from "./projectRepository";
import { storeProjectImage } from "./imageStore";

const run = promisify(execFile);
export const projectRepository = new ProjectRepository(process.cwd());
async function nativePicker(kind: "folder" | "file") {
  if (process.platform !== "win32") throw new ProjectError("O seletor de arquivos é exclusivo do Windows.");
  const code = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ${kind === "folder"
    ? "$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Escolha uma pasta vazia para o projeto'; if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.SelectedPath)}"
    : "$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='Projeto DiarioMaker (*.dmproj)|*.dmproj'; if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.FileName)}"}`;
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { windowsHide: true, timeout: 120000, encoding: "utf8" });
    return stdout.trim();
  } catch (err: any) {
    if (err.killed || err.code === "ETIMEDOUT") {
      return "";
    }
    throw err;
  }
}

export function projectRoutes(repository = projectRepository, picker = nativePicker) {
  const router = express.Router();
  const grants = new Map<string, { path: string; expires: number }>();
  const endpoint = (work: (req: express.Request, res: express.Response) => Promise<any>): express.RequestHandler => (req, res) => {
    work(req, res).catch((err: any) => res.status(err instanceof ProjectError ? err.status : 500).json({ error: err.message || "Falha na operação do projeto." }));
  };
  router.get("/api/project-documents/current", endpoint(async (_, res) => res.json(await repository.current())));
  router.get("/api/project-documents", endpoint(async (_, res) => res.json(await repository.list())));
  router.post("/api/project-documents/create", endpoint(async (req, res) => res.json(await repository.create(req.body.state, req.body.legacyFolder, req.body.targetDirectory))));
  router.get("/api/project-documents/:id", endpoint(async (req, res) => res.json(await repository.load(req.params.id))));
  router.post("/api/project-documents/:id/save", endpoint(async (req, res) => res.json(await repository.save(req.params.id, req.body.state, req.body.baseRevision, req.body.operationId))));
  router.post("/api/project-documents/:id/save-as", endpoint(async (req, res) => res.json(await repository.saveAs(req.params.id, req.body.name, req.body.state))));
  router.post("/api/project-documents/choose-folder", endpoint(async (_, res) => {
    const selected = await picker("folder");
    if (!selected) return res.json({ cancelled: true });
    const token = randomUUID();
    grants.set(token, { path: await fs.realpath(selected), expires: Date.now() + 600000 });
    res.json({ token, path: selected });
  }));
  router.post("/api/project-documents/open", endpoint(async (_, res) => {
    const selected = await picker("file");
    res.json(selected ? await repository.open(selected) : { cancelled: true });
  }));
  router.post("/api/project-documents/:id/transfer", endpoint(async (req, res) => {
    if (!["copy", "move"].includes(req.body.mode)) throw new ProjectError("Operação inválida.");
    const grant = grants.get(req.body.token);
    if (!grant || grant.expires < Date.now()) throw new ProjectError("Escolha novamente a pasta de destino.");
    const result = await repository.transfer(req.params.id, grant.path, req.body.mode);
    grants.delete(req.body.token); res.json(result);
  }));
  router.post("/api/project-documents/:id/reveal", endpoint(async (req, res) => {
    const root = await fs.realpath(await repository.root(req.params.id));
    if (process.platform !== "win32") throw new ProjectError("Explorer está disponível somente no Windows.");
    await new Promise<void>((resolve, reject) => {
      const child = execFile("explorer.exe", [root], () => {});
      child.once("spawn", () => resolve()); child.once("error", reject);
    });
    res.json({ success: true });
  }));
  router.get("/api/project-documents/:id/assets/:key", endpoint(async (req, res) => {
    const item = await repository.asset(req.params.id, req.params.key);
    res.type(item.mime).sendFile(item.file);
  }));
  router.get("/api/project-documents/:id/files", endpoint(async (req, res) => {
    const relative = String(req.query.path || "");
    if (!/^(imagens\/|midias\/|narration\.)/.test(relative) || !/\.(png|jpe?g|webp|svg|gif|mp3|wav|m4a|aac|ogg|flac)$/i.test(relative)) throw new ProjectError("Mídia inválida.", 403);
    res.sendFile(await confinedFile(await repository.root(req.params.id), relative));
  }));
  // Both legacy and new clients use this route. All identical bytes are stored once.
  router.post("/api/storyboard/projects/save-image", endpoint(async (req, res) => {
    const folder = String(req.body.folder || "");
    if (!folder || folder === "." || folder === "..") throw new ProjectError("Pasta inválida.");
    let root: string; let registered = false;
    try { root = await repository.root(folder); registered = true; }
    catch (err) {
      if (!(err instanceof ProjectError) || err.status !== 404) throw err;
      if (path.isAbsolute(folder)) {
        root = path.resolve(folder);
      } else if (!/[\\/:\x00]/.test(folder)) {
        root = path.join(repository.workspace, "projects", folder);
      } else {
        throw new ProjectError("Pasta inválida.");
      }
    }
    let bytes: Buffer; let mime: string;
    const image = String(req.body.imageUrl || "");
    if (image.startsWith("data:")) {
      const match = /^data:(image\/[\w+.-]+);base64,([\s\S]+)$/.exec(image);
      if (!match) throw new ProjectError("Imagem inválida.");
      mime = match[1]; bytes = Buffer.from(match[2], "base64");
    } else {
      if (!/^https?:\/\//.test(image)) throw new ProjectError("Imagem inválida.");
      const response = await fetch(image, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new ProjectError("Não foi possível baixar a imagem.");
      mime = response.headers.get("content-type")?.split(";")[0] || ""; bytes = Buffer.from(await response.arrayBuffer());
    }
    const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg" };
    const ext = extensions[mime]; if (!ext) throw new ProjectError("Formato de imagem não suportado.");
    await fs.mkdir(root, { recursive: true });
    const mediaFolder = registered ? "midias/imagens" : "imagens";
    const images = path.join(root, mediaFolder); await fs.mkdir(images, { recursive: true });
    if (path.relative(await fs.realpath(root), await fs.realpath(images)) !== path.normalize(mediaFolder)) throw new ProjectError("Pasta de imagens não autorizada.", 403);
    const filename = await storeProjectImage(images, bytes, ext);
    res.json({ success: true, url: registered ? `/api/project-documents/${folder}/files?path=${encodeURIComponent(mediaFolder + "/" + filename)}` : `/projects/${encodeURIComponent(folder)}/imagens/${encodeURIComponent(filename)}` });
  }));
  router.post("/api/storyboard/projects/clear-cache", endpoint(async (req, res) => {
    const folder = String(req.body.folder || "");
    if (!folder || folder === "." || folder === "..") throw new ProjectError("Pasta inválida.");
    let root: string;
    try { root = await repository.root(folder); } catch (err) {
      if (!(err instanceof ProjectError) || err.status !== 404) throw err;
      if (path.isAbsolute(folder)) {
        root = path.resolve(folder);
      } else if (!/[\\/:\x00]/.test(folder)) {
        root = path.join(repository.workspace, "projects", folder);
      } else {
        throw new ProjectError("Pasta inválida.");
      }
    }
    const cache = path.join(root, "cache"); await fs.mkdir(cache, { recursive: true });
    if (path.relative(await fs.realpath(root), await fs.realpath(cache)) !== "cache") throw new ProjectError("Cache fora da pasta autorizada.");
    let deletedCount = 0;
    const clear = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new ProjectError("Link encontrado no cache; limpeza interrompida.");
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) { await clear(target); await fs.rmdir(target); }
        else { await confinedFile(cache, path.relative(cache, target)); await fs.unlink(target); deletedCount++; }
      }
    };
    await clear(cache); res.json({ success: true, deletedCount });
  }));
  // Old URLs remain usable by older documents after an authorized move.
  router.get(/^\/projects\/([^/]+)\/(.+)$/, endpoint(async (req, res) => {
    const folder = req.params[0];
    if (/[\\/:\x00]/.test(folder) || folder === "." || folder === "..") throw new ProjectError("Pasta inválida.", 403);
    const root = await repository.legacyRoot(folder);
    if (!root) return res.sendFile(await confinedFile(path.join(repository.workspace, "projects", folder), req.params[1]));
    res.sendFile(await confinedFile(root, req.params[1]));
  }));
  return router;
}
