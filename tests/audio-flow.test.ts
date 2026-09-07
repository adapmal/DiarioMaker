import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { buildTranscriptionForm } from "../server/audioTranscription";

test("Whisper requests real timestamps; GPT requests JSON without unsupported parameters", () => {
  const whisper = buildTranscriptionForm(new Uint8Array([1]), "voice.wav", "whisper-1");
  assert.equal(whisper.get("response_format"), "verbose_json");
  assert.deepEqual(whisper.getAll("timestamp_granularities[]"), ["word", "segment"]);
  const gpt = buildTranscriptionForm(new Uint8Array([1]), "voice.wav", "gpt-transcribe");
  assert.equal(gpt.get("model"), "gpt-transcribe");
  assert.equal(gpt.get("response_format"), "json");
  assert.deepEqual(gpt.getAll("timestamp_granularities[]"), []);
});

test("engine defaults do not lock uncontrolled engine buttons", () => {
  const source = fs.readFileSync("src/components/ScriptInputArea.tsx", "utf8");
  const code = source.slice(source.indexOf("  const [localSelectedEngine"), source.indexOf("  const [localOpenAiAudioModel"));
  const values: any[] = [];
  let cursor = 0;
  const context: any = {
    useOpenAiForPrompts: true, preferredEngine: "gemini", preferredTranscriptionEngine: "openai",
    onPreferredEngineChange: undefined, onPreferredTranscriptionEngineChange: undefined,
    React: { useState: (initial: any) => {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (next: any) => { values[index] = next; }];
    } }
  };
  const render = () => {
    cursor = 0;
    return vm.runInNewContext(transformSync("(() => {" + code + "\nreturn { selectedEngine, transcriptionEngine, selectEngine, selectTranscriptionEngine }; })()", { loader: "ts" }).code, context);
  };
  const initial = render();
  assert.equal(initial.selectedEngine, "gemini");
  initial.selectEngine("ollama");
  initial.selectTranscriptionEngine("gemini");
  const changed = render();
  assert.equal(changed.selectedEngine, "ollama");
  assert.equal(changed.transcriptionEngine, "gemini");
});

test("late FileReader callback cannot restore cleared or replaced audio", () => {
  const source = fs.readFileSync("src/components/ScriptInputArea.tsx", "utf8");
  const code = source.slice(source.indexOf("  const audioSelectionVersion"), source.indexOf("  const executeGeneration"));
  const readers: any[] = [];
  let base64: any;
  const context: any = {
    React: { useRef: (current: any) => ({ current }), useEffect: () => {} },
    FileReader: class { onload: any; aborted = false; constructor() { readers.push(this); } abort() { this.aborted = true; } readAsDataURL() {} },
    setAudioBase64: (value: any) => { base64 = value; },
    setAudioFile() {}, setAudioFileName() {}, setAudioMimeType() {}, setAudioPath() {},
    audioInputRef: { current: { value: "" } }
  };
  vm.runInNewContext(transformSync(code + "\n globalThis.select = handleAudioFileChange; globalThis.clear = handleClearAudio;", { loader: "ts" }).code, context);
  const select = () => context.select({ target: { files: [{ name: "a.wav", size: 10, type: "audio/wav" }] } });
  select();
  context.clear();
  readers[0].onload({ target: { result: "stale" } });
  assert.equal(base64, undefined);
  assert.equal(readers[0].aborted, true);
  select(); select();
  readers[1].onload({ target: { result: "old file" } });
  assert.equal(base64, undefined);
  readers[2].onload({ target: { result: "new file" } });
  assert.equal(base64, "new file");
});

test("scene generation respects explicit Gemini despite global OpenAI and returns Ollama scenes", async () => {
  const source = fs.readFileSync("src/App.tsx", "utf8");
  const code = source.slice(source.indexOf("  const handleGenerateStoryboard ="), source.indexOf("  // Regenerate prompts and description for a single Scene"));
  for (const engine of ["gemini", "openai", "ollama"]) {
    let request: any;
    const responseData = { scenes: [{ text: "Narration", prompt: "Scene" }] };
    const context: any = {
      pushToHistory() {}, setIsGenerating() {}, setError(message: string | null) { if (message) throw new Error(message); },
      setStylePreference() {}, setActiveView() {}, setScenes() {}, setNotification() {},
      openAiKey: "fake-key", openAiModel: "global-model", useOpenAiForPrompts: true,
      customApiKey: "", artisticStyles: [], ollamaUrl: "http://local", ollamaModel: "local-model",
      detectStylePreference: () => "auto",
      safeParseResponse: async () => responseData,
      fetch: async (_url: string, options: any) => {
        request = options;
        return { ok: true, json: async () => ({ response: JSON.stringify(responseData) }) };
      }, console,
    };
    vm.runInNewContext(transformSync(code + "\n globalThis.run = handleGenerateStoryboard;", { loader: "ts" }).code, context);
    const result = await context.run("Narration", "auto", undefined, engine, "chosen-model");
    assert.equal(result.length, 1);
    if (engine !== "ollama") {
      assert.equal(Boolean(request.headers["x-use-openai"]), engine === "openai");
      if (engine === "openai") assert.equal(request.headers["x-openai-model"], "chosen-model");
    }
  }
});

test("panel scroll continues at inner boundary without scrolling background", () => {
  const source = fs.readFileSync("src/App.tsx", "utf8");
  const start = source.indexOf("    const handlePanelWheel =");
  const code = source.slice(start, source.indexOf('    panel.addEventListener("wheel"', start));
  const panel: any = { scrollHeight: 1000, clientHeight: 300, scrollTop: 0, parentElement: {}, tagName: "DIV" };
  const inner: any = { scrollHeight: 200, clientHeight: 100, scrollTop: 100, parentElement: panel, tagName: "DIV" };
  const context: any = { panel, window: { getComputedStyle: () => ({ overflowY: "auto" }) } };
  vm.runInNewContext(transformSync(code + "\n globalThis.wheel = handlePanelWheel;", { loader: "ts" }).code, context);
  let prevented = false, stopped = false;
  context.wheel({ target: inner, deltaY: 30, deltaMode: 0, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(inner.scrollTop, 100);
  assert.equal(panel.scrollTop, 30);
  assert.ok(prevented && stopped);
});

test("audio-only generation uses separate transcription and scene engines and the chosen text model", async () => {
  const source = fs.readFileSync("src/App.tsx", "utf8");
  const code = source.slice(source.indexOf("  const handleGenerateStoryboardWithAudio"), source.indexOf("  // Handle mid-project audio upload"));
  for (const transcriptionEngine of ["gemini", "openai"]) {
    let request: any;
    let generatedArgs: any;
    let aligned = false;
    const context: any = {
      openAiAudioModel: "whisper-1", openAiModel: "global-model",
      useOpenAiForPrompts: true, openAiKey: "fake-test-key", customApiKey: "",
      projectName: "Test", persistence: { currentLocation: () => null },
      setIsGenerating() {}, setNotification() {}, setActiveView() {}, setShowScriptModal() {},
      setScriptText() {}, setScenes() {}, setAudioNarrationUrl() {}, setError(message: string) { throw new Error(message); },
      fetch: async (_url: string, options: any) => {
        request = options;
        return { ok: true, json: async () => ({ fullScript: "Texto narrado.", timedWords: [], scenes: [{ text: "Texto narrado." }] }) };
      },
      handleGenerateStoryboard: async (...args: any[]) => { generatedArgs = args; return [{ id: "generated", prompt: "real prompt" }]; },
      alignAudioToExistingScenes() { aligned = true; },
      console,
    };
    vm.runInNewContext(transformSync(code + "\n globalThis.run = handleGenerateStoryboardWithAudio;", { loader: "ts" }).code, context);
    await context.run({ text: "", style: "auto", audioBase64: "data:audio/wav;base64,AA==", selectedEngine: "ollama", transcriptionEngine, openAiTextModel: "chosen-model" });
    assert.equal(JSON.parse(request.body).engine, transcriptionEngine);
    assert.equal(Boolean(request.headers["x-use-openai"]), transcriptionEngine === "openai");
    assert.deepEqual(Array.from(generatedArgs), ["Texto narrado.", "auto", undefined, "ollama", "chosen-model"]);
    assert.equal(aligned, false, "no fabricated alignment when words are absent");
  }
});
