import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const pending = new Map<string, Promise<string>>();
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Reuse identical bytes within this project, including files created by older versions. */
export async function storeProjectImage(imagesDir: string, buffer: Buffer, ext: string): Promise<string> {
  if (!/^\.(png|jpg|webp|svg)$/.test(ext)) throw new Error("Extensão de imagem inválida.");
  const hash = digest(buffer);
  const key = `${path.resolve(imagesDir)}:${hash}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = (async () => {
    await fs.mkdir(imagesDir, { recursive: true });
    const filename = `imagem_${hash}${ext}`;
    const entries = await fs.readdir(imagesDir, { withFileTypes: true });
    // Check the stable filename first; scan legacy files only when needed.
    entries.sort((a, b) => Number(b.name === filename) - Number(a.name === filename) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(png|jpe?g|webp|svg)$/i.test(entry.name)) continue;
      const candidate = path.join(imagesDir, entry.name);
      try {
        if ((await fs.stat(candidate)).size === buffer.length && digest(await fs.readFile(candidate)) === hash) {
          return entry.name;
        }
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    const temporary = path.join(imagesDir, `.image-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, buffer, { flag: "wx" });
      await fs.rename(temporary, path.join(imagesDir, filename));
    } finally {
      await fs.unlink(temporary).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    return filename;
  })();
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}
