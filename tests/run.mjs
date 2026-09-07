import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Compile tests without tsx's OS-account lookup (unavailable in some Windows sandboxes).
const scratch = path.resolve("scratch");
await fs.mkdir(scratch, { recursive: true });
const directory = await fs.mkdtemp(path.join(scratch, "image-tests-"));
const outputs = [];
try {
  for (const file of (await fs.readdir("tests")).filter(name => name.endsWith(".test.ts"))) {
    const entry = path.resolve("tests", file);
    const outfile = path.join(directory, file.replace(/\.ts$/, ".mjs"));
    outputs.push(outfile);
    await build({
      entryPoints: [entry], outfile, bundle: true, packages: "external", platform: "node", format: "esm",
      define: { "import.meta.url": JSON.stringify(pathToFileURL(entry).href) },
    });
  }
  const result = spawnSync(process.execPath, ["--test", ...outputs], { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const outfile of outputs) await fs.unlink(outfile).catch(err => { if (err.code !== "ENOENT") throw err; });
  await fs.rmdir(directory);
}
