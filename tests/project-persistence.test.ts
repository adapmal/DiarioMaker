import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import { ProjectRepository } from "../server/projectRepository";
import { projectRoutes } from "../server/projectRoutes";
import { app as productionApp } from "../server";

test("production Express app mounts document and image routes", () => {
  const paths: string[] = [];
  const visit = (stack: any[]) => { for (const layer of stack) {
    if (layer.route) paths.push(layer.route.path);
    if (layer.handle.stack) visit(layer.handle.stack);
  } };
  visit(productionApp._router.stack);
  assert.ok(paths.includes("/api/project-documents/create"));
  assert.ok(paths.includes("/api/storyboard/projects/save-image"));
});

async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "diariomaker-project-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("diariomaker-project-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repository = new ProjectRepository(directory);
  return { directory, repository };
}
const image = "data:image/png;base64," + Buffer.from("test image").toString("base64");

test("missing registered media blocks save, copy and move before destination changes", async t => {
  const { directory, repository } = await fixture(t);
  const project = await repository.create(state());
  const documentPath = path.join(project.location.root, project.location.fileName);
  const original = await fs.readFile(documentPath, "utf8");
  const document = JSON.parse(original);
  const asset = Object.values(document.assets).find((a: any) => a.mime === "image/png") as any;
  await fs.unlink(path.join(project.location.root, asset.path));
  await assert.rejects(repository.save(project.location.id, project.data, 1, "missing"), /não encontrad/);
  assert.equal(await fs.readFile(documentPath, "utf8"), original);
  for (const mode of ["copy", "move"] as const) {
    const target = path.join(directory, mode);
    await fs.mkdir(target);
    await assert.rejects(repository.transfer(project.location.id, target, mode), /não encontrad/);
    assert.deepEqual(await fs.readdir(target), []);
    assert.equal(await fs.readFile(documentPath, "utf8"), original);
  }
});
const state = () => ({ projectName: "Original", scenes: [{ id: "scene", generatedImageUrl: image, imageVersions: [{ id: "v1", url: image }] }], sessionImageArchive: [{ url: image }], audioNarrationUrl: "data:audio/wav;base64," + Buffer.from("audio").toString("base64") });

test("documents save empty state, reject stale revisions and preserve last good file on missing media", async t => {
  const { repository } = await fixture(t);
  const a = await repository.create(state());
  const empty = await repository.save(a.location.id, { ...a.data, scenes: [] }, a.location.revision, "empty");
  assert.deepEqual((await repository.load(a.location.id)).data.scenes, []);
  assert.equal((await repository.save(a.location.id, state(), 1, "empty")).location.revision, empty.location.revision);
  await assert.rejects(repository.save(a.location.id, state(), 1, "stale"), /Outra versão/);
  await assert.rejects(repository.save(a.location.id, { ...empty.data, audioNarrationUrl: "missing.wav" }, empty.location.revision, "bad"));
  assert.equal((await repository.load(a.location.id)).location.revision, empty.location.revision);
  const withMissingVersion = {
    ...empty.data,
    scenes: [{
      id: "scene-1",
      imageVersions: [{ id: "v-old", url: "/projects/test/imagens/missing_old_version.png" }]
    }]
  };
  await assert.rejects(repository.save(a.location.id, withMissingVersion, empty.location.revision, "missing-ver"), /não encontrad/);
  assert.equal((await repository.load(a.location.id)).location.revision, empty.location.revision);
});

test("save as, full copy and move preserve media, archive, audio, cache and both documents", async t => {
  const { directory, repository } = await fixture(t);
  const a = await repository.create(state());
  const b = await repository.saveAs(a.location.id, "Montagem 2", a.data);
  assert.equal((await repository.load(a.location.id)).location.name, "Original");
  assert.equal((await fs.readdir(path.join(a.location.root, "midias/imagens"))).length, 1);
  await fs.writeFile(path.join(a.location.root, "cache", a.location.id, "preview.bin"), "cache");
  const destination = path.join(directory, "copy"); await fs.mkdir(destination);
  const copy = await repository.transfer(b.location.id, destination, "copy");
  assert.notEqual(copy.location.id, b.location.id);
  assert.equal((await repository.current())?.location.id, b.location.id);
  const reopened = await repository.open(path.join(destination, copy.location.fileName));
  assert.ok(reopened.data.audioNarrationUrl.startsWith("/api/project-documents/"));
  assert.equal(reopened.data.sessionImageArchive.length, 1);
  const movedTo = path.join(directory, "moved"); await fs.mkdir(movedTo);
  const moved = await repository.transfer(b.location.id, movedTo, "move");
  assert.equal(moved.warning, undefined);
  await assert.rejects(fs.stat(a.location.root));
  assert.equal(await repository.root(a.location.id), movedTo);
  assert.equal(await fs.readFile(path.join(movedTo, "cache", a.location.id, "preview.bin"), "utf8"), "cache");
  const key = moved.data.scenes[0].generatedImageUrl.split("/").pop();
  assert.equal(await fs.readFile((await repository.asset(b.location.id, key)).file, "utf8"), "test image");
});

test("transfer rejects nested or occupied destination and preserves source", async t => {
  const { directory, repository } = await fixture(t);
  const a = await repository.create(state());
  await assert.rejects(repository.transfer(a.location.id, a.location.root, "move"), /fora da origem/);
  const occupied = path.join(directory, "occupied"); await fs.mkdir(occupied); await fs.writeFile(path.join(occupied, "keep"), "keep");
  await assert.rejects(repository.transfer(a.location.id, occupied, "move"), /vazia/);
  assert.equal((await repository.load(a.location.id)).location.revision, 1);
});

test("interrupted copy preserves original document and media", async t => {
  const { directory, repository } = await fixture(t);
  const a = await repository.create(state());
  const destination = path.join(directory, "failed-copy"); await fs.mkdir(destination);
  const originalCopy = fs.copyFile;
  let calls = 0;
  fs.copyFile = (async (...args: Parameters<typeof fs.copyFile>) => {
    if (++calls === 2) throw new Error("simulated disk full");
    return originalCopy(...args);
  }) as typeof fs.copyFile;
  try { await assert.rejects(repository.transfer(a.location.id, destination, "move"), /disk full/); }
  finally { fs.copyFile = originalCopy; }
  assert.equal((await repository.load(a.location.id)).data.scenes.length, 1);
  assert.equal(await repository.root(a.location.id), a.location.root);
  const key = a.data.scenes[0].generatedImageUrl.split("/").pop();
  assert.equal(await fs.readFile((await repository.asset(a.location.id, key)).file, "utf8"), "test image");
});

test("actual project router saves, serves deduplicated images and rejects missing grants", async t => {
  const { repository } = await fixture(t);
  const app = express(); app.use(express.json()); app.use(projectRoutes(repository));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (url: string, body: any) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await post("/api/project-documents/create", { state: state() }); assert.equal(created.status, 200);
  const a = await created.json();
  const savedImage = await post("/api/storyboard/projects/save-image", { folder: a.location.id, imageUrl: image }); assert.equal(savedImage.status, 200);
  const img = await savedImage.json(); assert.equal(await (await fetch(base + img.url)).text(), "test image");
  await fs.writeFile(path.join(a.location.root, "cache", a.location.id, "temporary.bin"), "temp");
  const cleared = await post("/api/storyboard/projects/clear-cache", { folder: a.location.id });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).deletedCount, 1);
  assert.equal(await (await fetch(base + img.url)).text(), "test image");
  assert.equal((await repository.load(a.location.id)).data.scenes.length, 1);
  assert.equal((await fs.readdir(path.join(a.location.root, "midias/imagens"))).length, 1);
  assert.equal((await post(`/api/project-documents/${a.location.id}/transfer`, { mode: "move", token: "invalid" })).status, 400);
  assert.equal((await post(`/api/project-documents/${a.location.id}/save`, { state: { scenes: [] }, baseRevision: 0 })).status, 409);
});

test("project creation with custom targetDirectory places project in chosen directory with inverted date subfolder", async t => {
  const { directory, repository } = await fixture(t);
  const app = express(); app.use(express.json()); app.use(projectRoutes(repository));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const customBase = path.join(directory, "external_drive");
  const customTarget = path.join(customBase, "260906");
  const res = await fetch(`${base}/api/project-documents/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: state(), legacyFolder: "260906", targetDirectory: customTarget })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(path.resolve(data.location.root), path.resolve(customTarget));
  assert.ok(await fs.stat(path.join(customTarget, data.location.fileName)));
  assert.ok(await fs.stat(path.join(customTarget, "midias", "imagens")));
});
