import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectRepository } from "../server/projectRepository";

test("NLE Mode: ProjectRepository materialization and transfer bypass stream-local-audio URLs without duplicating to midias", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nle-test-"));
  try {
    const repo = new ProjectRepository(path.join(tempDir, "projects"), path.join(tempDir, "meta.json"));
    
    // Create dummy 10MB audio file simulating external WAV on user disk
    const externalAudioPath = path.join(tempDir, "original_narration.wav");
    fs.writeFileSync(externalAudioPath, Buffer.alloc(1024 * 1024, 0x42));

    const externalStreamUrl = `/api/storyboard/stream-local-audio?path=${encodeURIComponent(externalAudioPath)}`;

    // Create a project document with the linked stream URL
    const docResult = await repo.create({
      scenes: [
        { id: "s1", text: "Cena 1", description: "Desc", prompt: "Prompt" }
      ],
      projectName: "Projeto NLE Teste",
      audioNarrationUrl: externalStreamUrl,
      originalAudioPath: externalAudioPath
    });

    assert.ok(docResult.location);
    assert.equal(docResult.data.audioNarrationUrl, externalStreamUrl);
    assert.equal(docResult.data.originalAudioPath, externalAudioPath);

    // Verify that NO copy of the external audio was written into midias/audios/
    const projectDir = docResult.location.root;
    const midiasAudioDir = path.join(projectDir, "midias", "audios");
    if (fs.existsSync(midiasAudioDir)) {
      const files = fs.readdirSync(midiasAudioDir);
      assert.equal(files.length, 0, "No audio files should be internalized in midias/audios for stream-local-audio");
    }

    // Verify transfer/copy works cleanly without throwing 'Mídia não incorporada'
    const targetCopyDir = path.join(tempDir, "copy");
    await fs.promises.mkdir(targetCopyDir);
    const copyResult = await repo.transfer(docResult.location.id, targetCopyDir, "copy");
    assert.ok(copyResult.location);
    assert.equal(copyResult.data.audioNarrationUrl, externalStreamUrl);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NLE Mode: App UI includes HD NLE link button, missing audio alert banner, and relink handlers", () => {
  const appSrc = fs.readFileSync(path.resolve("src", "App.tsx"), "utf8");

  // 1. Missing audio alert banner exists with Relink button
  assert.match(appSrc, /Arquivo de Áudio Original Não Encontrado/);
  assert.match(appSrc, /handleRelinkAudio/);
  assert.match(appSrc, /Localizar Áudio…/);

  // 2. New Project Modal includes 'Vincular do HD (NLE)'
  assert.match(appSrc, /Vincular do HD \(NLE\)/);
  assert.match(appSrc, /handleBrowseNewProjectAudio/);
  assert.match(appSrc, /newProjectAudioPath/);

  // 3. Audio stream local audio endpoint is used without browser-side WebAudio decode crash
  assert.match(appSrc, /\/api\/storyboard\/stream-local-audio\?path=/);
  assert.doesNotMatch(appSrc, /new\s+OfflineAudioContext\s*\(\s*1,\s*Math\.ceil\s*\(\s*duration/);
});
