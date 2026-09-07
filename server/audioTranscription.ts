/** Whisper alone supports the word/segment timestamp request used by this app. */
export function buildTranscriptionForm(audio: Uint8Array, filename: string, model: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: filename.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg" }), filename || "narration.mp3");
  form.append("model", model);
  form.append("response_format", model === "whisper-1" ? "verbose_json" : "json");
  if (model === "whisper-1") {
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
  }
  form.append("language", "pt");
  return form;
}
