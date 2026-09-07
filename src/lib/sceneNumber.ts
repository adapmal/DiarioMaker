export function sceneDisplayNumber(scene: { sceneNumber?: string } | undefined, index: number, consecutive: boolean) {
  return consecutive ? String(index + 1).padStart(2, "0") : (scene?.sceneNumber || String(index + 1));
}
