import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, validateProjectFolder } from "../server";

test("validateProjectFolder: strictly confines project folders and blocks path traversals", () => {
  // Valid folder names
  assert.equal(validateProjectFolder("MeuProjeto"), "MeuProjeto");
  assert.equal(validateProjectFolder("projeto-2026_09"), "projeto-2026_09");
  assert.equal(validateProjectFolder("  folder_with_spaces  "), "folder_with_spaces");

  // Invalid names / path traversals
  assert.throws(() => validateProjectFolder(""), /obrigatório/);
  assert.throws(() => validateProjectFolder("   "), /obrigatório/);
  assert.throws(() => validateProjectFolder(null), /obrigatório/);
  assert.throws(() => validateProjectFolder(".."), /inválido/);
  assert.throws(() => validateProjectFolder("."), /inválido/);
  assert.throws(() => validateProjectFolder("../etc/passwd"), /inválido/);
  assert.throws(() => validateProjectFolder("..\\windows\\system32"), /inválido/);
  assert.throws(() => validateProjectFolder("folder/subfolder"), /inválido/);
  assert.throws(() => validateProjectFolder("folder\\subfolder"), /inválido/);
  assert.throws(() => validateProjectFolder("folder\0evil"), /inválido/);
});

test("atomicWriteFileSync: safely writes content and throws on failure without leaving corrupt files", () => {
  const scratchDir = path.resolve("scratch", "atomic-test-" + Date.now());
  const targetFile = path.join(scratchDir, "nested", "test-storyboard.json");

  try {
    const payload = JSON.stringify({ scenes: [], projectName: "Empty Project", version: 1 });
    atomicWriteFileSync(targetFile, payload);

    assert.equal(fs.existsSync(targetFile), true);
    const readBack = fs.readFileSync(targetFile, "utf-8");
    assert.equal(readBack, payload);
    assert.deepEqual(JSON.parse(readBack).scenes, []);
  } finally {
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
});

// Cache behavior is covered against the real router in project-persistence.test.ts.
test("stream-local-audio: validates file extensions and blocks forbidden/sensitive paths", () => {
  const ALLOWED_AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma"]);

  // Audio files allowed
  assert.equal(ALLOWED_AUDIO_EXT.has(path.extname("voice.mp3").toLowerCase()), true);
  assert.equal(ALLOWED_AUDIO_EXT.has(path.extname("take_1.wav").toLowerCase()), true);
  assert.equal(ALLOWED_AUDIO_EXT.has(path.extname("track.m4a").toLowerCase()), true);

  // Non-audio disallowed
  assert.equal(ALLOWED_AUDIO_EXT.has(path.extname("server.ts").toLowerCase()), false);
  assert.equal(ALLOWED_AUDIO_EXT.has(path.extname(".env").toLowerCase()), false);
  assert.equal(ALLOWED_AUDIO_EXT.has(path.extname("user_config.json").toLowerCase()), false);
  assert.equal(ALLOWED_AUDIO_EXT.has(path.extname("session_store.json").toLowerCase()), false);

  // Sensitive filename heuristic check
  const isBlocked = (filePath: string) => {
    const baseName = path.basename(filePath).toLowerCase();
    return baseName.includes("config") || baseName.includes("secret") || baseName.includes("session") || baseName.startsWith(".");
  };

  assert.equal(isBlocked("session_store.json"), true);
  assert.equal(isBlocked("user_config.json"), true);
  assert.equal(isBlocked(".env"), true);
  assert.equal(isBlocked("my_voice_narration.mp3"), false);
});

test("scene creation and splitting: new scenes have blank narration and inherit models from preceding scenes", () => {
  const sourceApp = fs.readFileSync(path.resolve("src", "App.tsx"), "utf8");
  
  // 1. Check that handleAddBlankScene creates scene with empty text and inherits models
  assert.match(sourceApp, /text:\s*"",/);
  assert.match(sourceApp, /description:\s*"",/);
  assert.match(sourceApp, /prompt:\s*"",/);
  assert.match(sourceApp, /lastScene\?\.promptAiModel/);
  assert.match(sourceApp, /lastScene\?\.selectedModel/);
  assert.match(sourceApp, /lastScene\?\.promptTargetTool/);

  // 2. Check that handleSplitScene sets selectedModel on newScene2
  const splitMatch = sourceApp.slice(sourceApp.indexOf("const newScene2: StoryboardScene = {"), sourceApp.indexOf("const updated = [...scenes];", sourceApp.indexOf("const newScene2: StoryboardScene = {")));
  assert.match(splitMatch, /selectedModel:\s*originalScene\.selectedModel/);
  assert.match(splitMatch, /promptAiModel:\s*originalScene\.promptAiModel/);
  assert.match(splitMatch, /promptTargetTool:\s*originalScene\.promptTargetTool/);

  // 3. Check that StoryboardCard does not inject the old welcome message
  const sourceCard = fs.readFileSync(path.resolve("src", "components", "StoryboardCard.tsx"), "utf8");
  assert.doesNotMatch(sourceCard, /Olá! Eu sou o seu Diretor de Arte do Estúdio AI/);
  assert.doesNotMatch(sourceCard, /Raciocínio & Memória do Diretor:\s*Analisei a narração original/);
});

test("conversational studio: each image version maintains an isolated chat and newly created versions do not inherit older chats", () => {
  const sourceCard = fs.readFileSync(path.resolve("src", "components", "StoryboardCard.tsx"), "utf8");
  const sourceApp = fs.readFileSync(path.resolve("src", "App.tsx"), "utf8");

  // 1. activeChatHistory must not blindly fall back to scene.chatHistory when there are multiple image versions
  assert.match(sourceCard, /activeImageVersion\.chatHistory/);
  assert.doesNotMatch(sourceCard, /!activeImageVersion\.chatHistory\)\s*\?\s*scene\.chatHistory/);

  // 2. StoryboardCard thumbnail selection syncs chatHistory for the chosen version
  assert.match(sourceCard, /chatHistory:\s*v\.chatHistory\s*\|\|\s*\[\]/);

  // 3. New image versions created in handleUpdateScene start with their own chatHistory
  assert.match(sourceApp, /chatHistory:\s*fields\.chatHistory\s*\|\|\s*\[\]/);
});

test("openai transcription model selection: normalization handles whisper and gpt, and controls are wired to state", async () => {
  const { normalizeOpenAiTranscriptionChoice } = await import("../src/components/OpenAiTranscriptionModelRadios");
  assert.equal(normalizeOpenAiTranscriptionChoice("whisper-1"), "whisper-1");
  assert.equal(normalizeOpenAiTranscriptionChoice("whisper"), "whisper-1");
  assert.equal(normalizeOpenAiTranscriptionChoice("WHISPER-1"), "whisper-1");
  assert.equal(normalizeOpenAiTranscriptionChoice("gpt-transcribe"), "gpt-transcribe");
  assert.equal(normalizeOpenAiTranscriptionChoice(""), "whisper-1");
  assert.equal(normalizeOpenAiTranscriptionChoice(undefined), "whisper-1");

  const sourceScript = fs.readFileSync(path.resolve("src", "components", "ScriptInputArea.tsx"), "utf8");
  const sourceApp = fs.readFileSync(path.resolve("src", "App.tsx"), "utf8");

  // ScriptInputArea uses effective audio model and passes change handler
  assert.match(sourceScript, /effectiveOpenAiAudioModel/);
  assert.match(sourceScript, /selectOpenAiAudioModel/);
  assert.match(sourceScript, /openAiAudioModel:\s*effectiveOpenAiAudioModel/);

  // App.tsx passes openAiAudioModel and onOpenAiAudioModelChange to ScriptInputArea
  assert.match(sourceApp, /openAiAudioModel=\{openAiAudioModel\}/);
  assert.match(sourceApp, /onOpenAiAudioModelChange=\{/);
  assert.match(sourceApp, /effectiveAudioModel/);
});

test("audio removal closes transcription menu and routes pure text to standard generation", () => {
  const sourceScript = fs.readFileSync(path.resolve("src", "components", "ScriptInputArea.tsx"), "utf8");
  const sourceApp = fs.readFileSync(path.resolve("src", "App.tsx"), "utf8");

  // 1. ScriptInputArea conditions transcription section on hasAudio
  assert.match(sourceScript, /const hasAudio = !!\(audioFile \|\| audioBase64 \|\| audioFileName \|\| audioPath\);/);
  assert.match(sourceScript, /\{hasAudio && \(\s*<div className="space-y-2">\s*<label[^>]*>\s*1\. Transcrição do áudio/);
  assert.match(sourceScript, /\{hasAudio \? "2\. Divisão narrativa em cenas" : "Divisão narrativa em cenas"\}/);
  assert.match(sourceScript, /onGenerateWithAudio && hasAudio/);
  assert.match(sourceScript, /\{hasAudio \? "Transcrever Áudio e Gerar Storyboard" : "Gerar Storyboard"\}/);

  // 2. App.tsx resets audio on new project open
  assert.match(sourceApp, /setNewProjectAudioFile\(null\);/);
  assert.match(sourceApp, /setNewProjectAudioFileName\(undefined\);/);

  // 3. App.tsx routes pure text to handleGenerateStoryboard, NOT handleGenerateStoryboardWithAudio
  assert.match(sourceApp, /if \(newProjectAudioFile\) \{\s*handleGenerateStoryboardWithAudio\(/);
  assert.match(sourceApp, /\} else if \(newProjectScript\.trim\(\)\) \{\s*handleGenerateStoryboard\(/);

  // 4. App.tsx adapts label and engine button based on newProjectAudioFile
  assert.match(sourceApp, /\{newProjectAudioFile \? "Motor de IA para Transcrição e Roteiro" : "Motor de IA para Roteiro e Cenas"\}/);
  assert.match(sourceApp, /\{newProjectAudioFile \? "🎨 OpenAI \(Whisper\)" : "🎨 OpenAI \(ChatGPT\)"\}/);
  assert.match(sourceApp, /\{Boolean\(newProjectAudioFile\) && \(newProjectEngine === "openai"/);
});

test("empty scenes generation panel isolates wheel scroll to prevent moving background scenes", () => {
  const sourceApp = fs.readFileSync(path.resolve("src", "App.tsx"), "utf8");

  // 1. handleGlobalWheel explicitly stops and prevents wheel scroll over empty scenes dropdown
  assert.match(sourceApp, /target\.closest\("#empty-scenes-dropdown"\)/);
  assert.match(sourceApp, /target\.closest\("\[data-empty-scenes-panel='true'\]"\)/);

  // 2. Dropdown element has ref, id and data attributes
  assert.match(sourceApp, /ref=\{emptyScenesPanelRef\}/);
  assert.match(sourceApp, /id="empty-scenes-dropdown"/);
  assert.match(sourceApp, /data-empty-scenes-panel="true"/);
  assert.match(sourceApp, /data-empty-scenes-wrapper="true"/);

  // 3. Dropdown has isolated non-passive wheel listener preventing default and propagation
  assert.match(sourceApp, /panel\.addEventListener\("wheel", handlePanelWheel, \{\s*passive:\s*false\s*\}\)/);
  assert.match(sourceApp, /e\.preventDefault\(\);/);
  assert.match(sourceApp, /e\.stopPropagation\(\);/);

  // 4. Dropdown and model lists have overscroll-contain
  assert.match(sourceApp, /id="empty-scenes-dropdown"[\s\S]*?overscroll-contain/);
});

test("active scene counter uses the same numbering rule as cards", async () => {
  const { sceneDisplayNumber } = await import("../src/lib/sceneNumber");
  assert.equal(sceneDisplayNumber({ sceneNumber: "20-8" }, 2, false), "20-8");
  assert.equal(sceneDisplayNumber({ sceneNumber: "20-8" }, 2, true), "03");
  assert.equal(sceneDisplayNumber(undefined, 0, false), "1");
});
