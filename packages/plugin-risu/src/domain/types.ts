export interface Illustration {
  at: string;
  offset: number;
  size?: string;
  warnings?: string[];
  summary: string;
  prompt: string;
  characters: { positive: string; negative: string }[];
}

export type ModelMode = "model" | "submodel";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface LibraryEntry {
  [key: string]: Json | undefined;
  id?: string;
  name: string;
  appearance?: string;
  description?: string;
}
export interface LibraryData {
  people: LibraryEntry[];
  backgrounds: LibraryEntry[];
  sharedOutfits?: Outfit[];
}
export interface Outfit {
  id: string;
  name: string;
  description: string;
}
export interface OutfitTestSettings {
  negative: string;
}
export interface OutfitTestRun {
  prompt: string;
  settings: OutfitTestSettings;
  state:
    | "preview"
    | "submitting"
    | "waiting"
    | "complete"
    | "error"
    | "uncertain";
  promptId?: string;
  images: { url: string; file: ImageFile }[];
  error?: string;
}
export type OutfitChoice =
  | { mode: "reference"; id: string }
  | { mode: "custom"; description: string };
export interface Source {
  character: string;
  chat: string;
  characterId: string;
  chatId: string;
  characterIndex: number;
  chatIndex: number;
}
export interface Library extends LibraryData {
  revision: number;
  updatedAt?: number;
  source?: Source;
  lastExtraction?: {
    loreCount: number;
    recentCount: number;
    modelMode: ModelMode;
    lastPrompt: string;
  };
}
export interface LibraryReader {
  load(source: Source): Promise<Library>;
}
export interface Pair {
  userMessage: string;
  assistantMessage: string;
  /** Original committed reply, before statusData is removed. */
  rawAssistantMessage?: string;
}
export interface Message {
  role: string;
  data: string;
  chatId?: string;
  name?: string;
  disabled?: boolean;
  isComment?: boolean;
}
export interface Chat {
  id: string;
  name: string;
  message: Message[];
}
export interface Character {
  chaId: string;
  name: string;
  desc?: string;
  description?: string;
  personality?: string;
  chats: Chat[];
}
export interface OutputEvent {
  char: Character;
  chat: Chat;
  characterIndex: number;
  chatIndex: number;
  messageIndex: number;
}
export interface ActiveContext {
  char: Character;
  chat: Chat;
  source: Source;
}
export interface LoreEntry {
  disabled?: boolean;
  content: string;
  mode?: string;
  key?: string;
  comment?: string;
  alwaysActive?: boolean;
  secondkey?: string;
  selective?: boolean;
  useRegex?: boolean;
  extentions?: { risu_case_sensitive?: boolean };
}
export interface ManualSettings {
  url: string;
  workflow: string;
  auto: boolean;
  recent: number;
  timeout: number;
  loreLimit: number;
  keywordLore: boolean;
  style: string;
  extractionSystem: string;
  extractionInputTemplate: string;
  sceneTemplate: string;
  personTemplate: string;
  negative: string;
  instructions: string;
  extractionModel: ModelMode;
}
export interface GenerationSettings {
  protocolVersion: 3;
  execution?: "paintbox" | "legacy";
  useNovelAI?: boolean;
  planningModel?: ModelMode | "lm-studio";
  maxIllustrations?: number;
  dynamicImageSize?: boolean;
  artistPrompt?: string;
  mainModelPrompt?: boolean;
  useLmStudio?: boolean;
  lmStudioModel?: string;
  viewpointGuidance: string;
  enabled: boolean;
  system: string;
  inputTemplate: string;
  additionalPrompt: string;
  style: string;
  maxInputChars: number;
  modelTimeoutSec: number;
  maxTokens: number;
  url: string;
  workflow: string;
  negative: string;
  timeout: number;
  promptPrefix: string;
  finalPromptTemplate: string;
  characterPromptTemplate: string;
}
export interface ExtractionDraft {
  source: Source;
  baseRevision: number;
  patch: LibraryData;
  raw: string;
  loreCount: number;
  recentCount: number;
  modelMode: ModelMode;
  lastPrompt: string;
}
export interface ExtractionState {
  outfits?: { id: string; name: string; description: string }[];
  debug?: {
    source: Source;
    revision: number;
    messages: ModelMessage[];
    modelMode: ModelMode;
    loreCount: number;
    recentCount: number;
    raw?: string;
    error?: string;
    durationMs?: number;
    usage?: Usage | null;
    validated?: LibraryData;
  };
  config: ManualSettings;
  busy: boolean;
  scope: Source | null;
  library: Library | null;
  draft: ExtractionDraft | null;
  finalInstruction: string;
  loadingScope: number;
}
export interface Usage {
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number;
  totalTokens?: number;
}
export interface ModelMessage {
  role: string;
  content: string;
}
export interface ModelDetails {
  raw: string;
  usage: Usage | null;
}
export interface Attempt extends ModelDetails {
  modelDurationMs: number;
  validationError?: string;
  systemPrefixSha256?: string;
}
export interface ScenePlan {
  view: {
    mode: "first_person" | "third_person";
    observerName: string;
    reason: string;
    visibleBodyParts: string;
  };
  scene: {
    backgroundId: string | null;
    referenceMatch: "exact" | "nearby" | "none";
    name: string;
    description: string;
  };
  composition: string;
  characters: {
    id: string | null;
    name: string;
    action: string;
    state?: string;
    outfit?: OutfitChoice;
  }[];
  objects: { name: string; description: string }[];
}
export interface CompiledPlan {
  plan: ScenePlan;
  warnings: string[];
  prompt: string;
}
export interface UserIdentity {
  name: string;
  persona: string;
}
export interface PlanningJob {
  id?: string;
  settings: GenerationSettings;
  savedLibrary: LibraryData;
  pair: Pair;
  userIdentity?: UserIdentity;
  worldbook?: { title: string; content: string; relevance?: number }[];
  worldbookOmitted?: number;
  plan?: ScenePlan;
  raw?: string;
}
export type JobState =
  | "pending"
  | "preparing"
  | "ready"
  | "submitting"
  | "queued"
  | "waiting"
  | "uncertain"
  | "complete"
  | "error"
  | "draft";
export interface ImageFile {
  filename: string;
  subfolder: string;
  type: string;
}
export interface ImageJob {
  id: string;
  createdAt: number;
  state: JobState;
  source: Partial<Source> & Pick<Source, "character" | "chat">;
  files: ImageFile[];
  promptId?: string;
  baseUrl?: string;
  timeout?: number;
  prompt?: string;
  raw?: string;
  error?: string;
  completedAt?: number;
}
export interface GenerationJob extends ImageJob, PlanningJob {
  id: string;
  source: Source;
  eventKey: string;
  manual: boolean;
  retryOf?: string;
  illustration?: Illustration;
  illustrationBatch?: string;
  illustrationOrder?: number;
  serviceImageId?: string;
  serviceScene?: boolean;
  noIllustrations?: boolean;
  replacesImageId?: string;
  replaceReplyImages?: boolean;
  messageIndex: number;
  messageId: string;
  libraryRevision: number;
  compositionAttempts?: Attempt[];
  modelRequestState?: "started" | "complete" | "failed";
  modelCallCount?: number;
  modelName?: string;
  sourceModelId?: string;
  finishReason?: string;
  /** Legacy records are displayed without invoking any model. */
  appearanceResolution?: unknown;
  appearanceResolutionAttempts?: Attempt[];
  usage?: Usage | null;
  modelDurationMs?: number;
  systemPrefixSha256?: string;
  validationWarnings?: string[];
  responseKind?: string;
  attachmentState?: string;
  awaitingClick?: boolean;
  summaryAttached?: boolean;
  attachmentError?: string;
  attachedAt?: number;
  imageAssets?: string[];
  supersededBy?: string;
  replacementCleanupError?: string;
}
export interface Preview extends CompiledPlan {
  stats: {
    people: number;
    backgrounds: number;
    prefixChars: number;
    turnChars: number;
    libraryChars: number;
    usage: Usage | null;
    modelDurationMs: number;
    systemPrefixSha256: string;
  };
}
export interface GenerationState {
  paintboxConnection?: { url: string; token: string };
  connectionInfo: { configured: boolean; name: string; model: string };
  settings: GenerationSettings;
  jobs: GenerationJob[];
  history: ImageJob[];
  working: boolean;
  composing: boolean;
  painting: boolean;
  busy: boolean;
  preview: {
    illustrations: Illustration[];
    usage: Usage | null;
    worldbookOmitted?: number;
  } | null;
  selected: string | null;
  inlineWorking: Set<string>;
  enqueueWrites: Promise<unknown>;
  autoWrites: Promise<void>;
  writes: Promise<unknown>;
}
export interface CapturedReply {
  source: Source;
  pair: Pair;
  index: number;
  messageId: string;
  mode?: string;
  imageId?: string;
}
export interface ImageRequest {
  source: Source;
  pair: Pair;
  messageIndex: number;
  messageId: string;
  mode?: string;
  imageId?: string;
}
export interface Accepted {
  accepted: boolean;
  jobId?: string;
  reason?: string;
}
export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, Json>;
}
export type Workflow = Record<string, WorkflowNode>;
export interface ComfyHistoryItem {
  outputs?: Record<string, { images?: ImageFile[] }>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: [string, { timestamp?: number }][];
  };
  prompt?: [unknown, unknown, Workflow];
}
export type ComfyHistory = Record<string, ComfyHistoryItem>;
