export interface StudioChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  imageUrl?: string;
  model?: string;
  promptUsed?: string;
  descriptionUsed?: string;
  timestamp: string;
}

export interface ImageVersion {
  id: string;
  url: string;
  model?: string;
  timestamp: string;
  prompt?: string;
  description?: string;
  engineName?: string;
  renderTimeSeconds?: number;
  letter?: string;
}

export interface StoryboardScene {
  id: string;
  text: string;
  description: string;
  prompt: string;
  isEditing?: boolean;
  isLoading?: boolean;
  generatedImageUrl?: string;
  selectedModel?: string;
  engineName?: string;
  renderTimeSeconds?: number;
  generationGuidelines?: string;
  sceneStylePreference?: StylePreference;
  promptAiModel?: string;
  promptAiModelUsed?: string;
  promptTargetTool?: string;
  renderStatus?: "idle" | "queued" | "rendering" | "completed" | "failed";
  promptQueueStatus?: "idle" | "queued" | "generating" | "completed" | "failed";
  generateImageAfterPrompt?: boolean;
  renderError?: string;
  promptError?: string;
  isPromptModified?: boolean;
  sceneNumber?: string;
  chatHistory?: StudioChatMessage[];
  imageVersions?: ImageVersion[];
  visualInstructionImage?: string;
  connectionGroupId?: string;
  imageCount?: number;
  startTime?: number;
  endTime?: number;
  duration?: number;
  wordStartIndex?: number;
  wordEndIndex?: number;
  timedWords?: { word: string; start: number; end: number }[];
}

export type Scene = StoryboardScene;

export interface StoryboardProject {
  id: string;
  name: string;
  scenes: StoryboardScene[];
  connectionGroups?: ConnectionGroup[];
  archivedImages?: ArchivedImage[];
  stylePreference?: StylePreference;
  promptAiModel?: string;
  promptTargetTool?: string;
  audioNarrationUrl?: string;
  audioNarrationPath?: string;
  totalAudioDuration?: number;
  fps?: number;
  updatedAt?: string;
}

export interface ConnectionGroup {
  id: string;
  name: string;
  color: string;
  description?: string;
}

export type StylePreference = "auto" | "caravaggio" | "urban_realism" | string;

export interface ArtisticStyle {
  id: string;
  name: string;
  prompt: string;
  autoDetectKeywords: string;
}

export interface ArchivedImage {
  id: string;
  url: string;
  timestamp: string;
  sceneId: string;
  originalSceneNumber: string;
  prompt: string;
  text: string;
  model?: string;
  engineName?: string;
  renderTimeSeconds?: number;
  letter?: string;
}

