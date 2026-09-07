import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";

test("selecting a version restores its metadata, saves, and preserves Undo/Redo; edits still add history", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const handleUpdateScene =");
  const end = source.indexOf("  // State and Ref for sequential image rendering queue", start);
  const helpers = source.slice(source.indexOf("export const getCanonicalImageKey"), source.indexOf("interface ModelPriceInfo")).replace(/^export /gm, "");
  const versions = [
    { id: "a", url: "/projects/demo/imagens/a.png", prompt: "prompt A", description: "A", letter: "A" },
    { id: "b", url: "/projects/demo/imagens/b.png", prompt: "prompt B", description: "B", letter: "B" },
  ];
  const state: any = {
    scenes: [{ id: "scene", generatedImageUrl: versions[0].url, prompt: "prompt A", description: "A", imageVersions: versions, imageCount: 2, renderStatus: "completed" }],
    history: ["previous edit"], redo: ["undone edit"], saves: 0, archive: [],
    activeStudioSceneIdRef: { current: "scene" },
    getLetterFromIndex: (i: number) => String.fromCharCode(65 + i),
    addFloatingNotification() {}, setTimeout: (fn: any) => fn(),
  };
  state.pushToHistory = () => { state.history.push("edit"); state.redo = []; };
  state.setScenes = (fn: any) => state.scenes = fn(state.scenes);
  state.setSessionImageArchive = (fn: any) => state.archive = fn(state.archive);
  state.triggerAutosave = () => state.saves++;
  const context = vm.createContext(state);
  vm.runInContext(transformSync(helpers + source.slice(start, end), { loader: "ts" }).code, context);
  vm.runInContext('handleSelectSceneImage("scene", { generatedImageUrl: "/projects/demo/imagens/b.png", prompt: "prompt B", description: "B" })', context);
  assert.equal(state.history.length, 1);
  assert.equal(state.redo.length, 1);
  assert.equal(state.scenes[0].prompt, "prompt B");
  assert.equal(state.scenes[0].generatedImageUrl, versions[1].url);
  assert.equal(state.scenes[0].isPromptModified, false);
  assert.equal(state.scenes[0].imageVersions.length, 2);
  assert.equal(state.saves, 1);
  vm.runInContext('handleUpdateScene("scene", { prompt: "edited manually" })', context);
  assert.equal(state.history.length, 2);
  assert.equal(state.redo.length, 0);
  assert.equal(state.scenes[0].isPromptModified, true);
});
