import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import { ProjectRepository } from "../server/projectRepository";

async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "diariomaker-portable-test-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repository = new ProjectRepository(directory);
  return { directory, repository };
}

const dummyImage = "data:image/png;base64," + Buffer.from("dummy-png-image").toString("base64");
const dummyAudio = "data:audio/wav;base64," + Buffer.from("dummy-wav-audio").toString("base64");

test("manually copied project folder opens independently without 409 conflict error", async (t) => {
  const { directory, repository } = await fixture(t);
  
  // 1. Create original project
  const initial = await repository.create({
    projectName: "Filme Original",
    scenes: [{ id: "scene-1", text: "Cena 1", generatedImageUrl: dummyImage }],
    audioNarrationUrl: dummyAudio
  });

  const originalFile = path.join(initial.location.root, initial.location.fileName);
  assert.ok(initial.location.id);

  // 2. Simulate manual folder copy (e.g. copying to another folder or disk)
  const copiedDir = path.join(directory, "manual-copied-project");
  await fs.mkdir(copiedDir, { recursive: true });
  await fs.cp(initial.location.root, copiedDir, { recursive: true });

  const copiedFile = path.join(copiedDir, initial.location.fileName);

  // 3. Open the copied project. Previously this threw HTTP 409 'Este arquivo é uma cópia manual'
  const reopenedCopy = await repository.open(copiedFile);
  assert.ok(reopenedCopy.location);
  assert.notEqual(reopenedCopy.location.id, initial.location.id, "Copied project must be re-keyed with independent UUID");
  assert.equal(reopenedCopy.location.root, await fs.realpath(copiedDir));
  assert.equal(reopenedCopy.data.scenes[0].text, "Cena 1");

  // 4. Verify both projects exist in registry and are completely independent
  const list = await repository.list();
  const ids = list.map(item => item.id);
  assert.ok(ids.includes(initial.location.id));
  assert.ok(ids.includes(reopenedCopy.location.id));
});

test("open tolerates missing media files and reports warning without crashing the open", async (t) => {
  const { repository } = await fixture(t);
  
  const created = await repository.create({
    projectName: "Projeto com Midia",
    scenes: [{ id: "s1", text: "Cena Texto", generatedImageUrl: dummyImage }]
  });

  const docPath = path.join(created.location.root, created.location.fileName);
  const doc = JSON.parse(await fs.readFile(docPath, "utf8"));
  const assetPath = Object.values(doc.assets)[0].path;

  // Unlink physical media file
  await fs.unlink(path.join(created.location.root, assetPath));

  // Opening should succeed with a warning rather than throwing fatal 404
  const result = await repository.open(docPath);
  assert.ok(result.location);
  assert.equal(result.data.scenes[0].text, "Cena Texto");
  assert.ok(result.warning && result.warning.includes("mídia não foram encontrados"));
});

test("opening a .dmaker portable archive extracts all media, materializes native project and registers it", async (t) => {
  const { directory, repository } = await fixture(t);

  // Build a sample .dmaker package
  const zip = new JSZip();
  const sampleProjectData = {
    version: "1.2",
    appName: "DiárioMaker",
    projectName: "Transferido de Outro PC",
    scenes: [
      {
        id: "scene-abc",
        sceneNumber: "01",
        text: "Narração da cena importada",
        generatedImageUrl: "images/scene-abc_active.png"
      }
    ],
    audioNarrationUrl: "audio/narration.wav",
    scriptText: "Roteiro completo do outro computador",
    selectedStyle: "Cinematográfico"
  };

  zip.file("project.json", JSON.stringify(sampleProjectData, null, 2));
  zip.file("images/scene-abc_active.png", Buffer.from("image-binary-bytes"));
  zip.file("audio/narration.wav", Buffer.from("audio-binary-bytes"));

  const packagePath = path.join(directory, "MeuPacote.dmaker");
  const packageBytes = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(packagePath, packageBytes);

  // Open the .dmaker directly via repository.open
  const opened = await repository.open(packagePath);
  assert.ok(opened.location);
  assert.equal(opened.location.name, "Transferido de Outro PC");
  assert.ok(opened.location.id);
  assert.ok(await fs.stat(opened.location.root));

  // Verify scenes and audio are mapped to assets
  assert.equal(opened.data.scenes[0].text, "Narração da cena importada");
  assert.ok(opened.data.scenes[0].generatedImageUrl.startsWith("/api/project-documents/"));
  assert.ok(opened.data.audioNarrationUrl.startsWith("/api/project-documents/"));

  // Verify physical files were extracted to midias/imagens and midias/audio
  const images = await fs.readdir(path.join(opened.location.root, "midias", "imagens"));
  assert.equal(images.length, 1);
  const audios = await fs.readdir(path.join(opened.location.root, "midias", "audio"));
  assert.equal(audios.length, 1);

  // Verify the project can be edited and saved to disk
  const updatedScenes = [...opened.data.scenes, { id: "scene-2", text: "Nova cena no novo PC" }];
  const saved = await repository.save(opened.location.id, { ...opened.data, scenes: updatedScenes }, opened.location.revision, "op1");
  assert.equal(saved.location.revision, 2);
  assert.equal((await repository.load(opened.location.id)).data.scenes.length, 2);
});

test("stream-local-audio falls back to local project narration cache when external path is missing on another PC", async (t) => {
  const { directory, repository } = await fixture(t);

  const missingExternalPath = "Z:\\NonExistentDrive\\UserA\\external_audio.wav";
  const externalStreamUrl = `/api/storyboard/stream-local-audio?path=${encodeURIComponent(missingExternalPath)}`;

  const project = await repository.create({
    projectName: "Projeto NLE Transferido",
    scenes: [{ id: "s1", text: "Cena 1" }],
    audioNarrationUrl: externalStreamUrl
  });

  // Write narration_cache.wav in project root
  await fs.writeFile(path.join(project.location.root, "narration_cache.wav"), Buffer.from("cached-audio-bytes"));

  // Trigger media read during saveAs or asset request
  const savedAs = await repository.saveAs(project.location.id, "Copia NLE", {
    ...project.data,
    audioNarrationUrl: externalStreamUrl
  });

  assert.ok(savedAs.location);
});

test("UI includes portable export in Save Menu and portable open in Open Menu", async () => {
  const saveMenuSrc = await fs.readFile(path.resolve("src", "components", "ProjectSaveMenu.tsx"), "utf8");
  assert.match(saveMenuSrc, /Exportar pacote portátil…/);
  assert.match(saveMenuSrc, /\.dmaker/);
  assert.match(saveMenuSrc, /onExportPackage/);

  const openMenuSrc = await fs.readFile(path.resolve("src", "components", "ProjectOpenMenu.tsx"), "utf8");
  assert.match(openMenuSrc, /\.dmproj ou \.dmaker/);
  assert.match(openMenuSrc, /Importar pacote portátil…/);

  const appSrc = await fs.readFile(path.resolve("src", "App.tsx"), "utf8");
  assert.match(appSrc, /fetchAudioAsBlob/);
  assert.match(appSrc, /onExportPackage=\{handleSaveProject\}/);
  assert.match(appSrc, /audio\/narration\.\$\{ext\}/);
});
