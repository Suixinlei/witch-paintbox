export interface Illustration {
  at: string;
  offset: number;
  size?: string;
  summary: string;
  prompt: string;
}
export interface Source {
  character: string;
  chat: string;
  characterId: string;
  chatId: string;
  characterIndex: number;
  chatIndex: number;
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
  chats: Chat[];
}
export interface OutputEvent {
  char: Character;
  chat: Chat;
  characterIndex: number;
  chatIndex: number;
  messageIndex: number;
}
export type JobState =
  | "pending"
  | "preparing"
  | "ready"
  | "submitting"
  | "uncertain"
  | "complete"
  | "error";
export interface ImageFile {
  filename: string;
  subfolder: string;
  type: string;
}
export interface GenerationJob {
  id: string;
  eventKey: string;
  manual: boolean;
  retryOf?: string;
  createdAt: number;
  state: JobState;
  source: Source;
  pair: Pair;
  messageIndex: number;
  messageId: string;
  illustration?: Illustration;
  illustrationBatch?: string;
  illustrationOrder?: number;
  noIllustrations?: boolean;
  replacesImageId?: string;
  replaceReplyImages?: boolean;
  files: ImageFile[];
  serviceImageId?: string;
  modelRequestState?: "started" | "complete";
  modelCallCount?: number;
  error?: string;
  completedAt?: number;
  attachmentState?: string;
  awaitingClick?: boolean;
  summaryAttached?: boolean;
  attachmentError?: string;
  attachedAt?: number;
  imageAssets?: string[];
  supersededBy?: string;
  replacementCleanupError?: string;
}
export interface GenerationState {
  paintboxConnection?: { url: string; token: string };
  /** Mirror of the service's automatic-illustration switch. */
  enabled: boolean;
  jobs: GenerationJob[];
  working: boolean;
  composing: boolean;
  painting: boolean;
  busy: boolean;
  preview: { illustrations: Illustration[] } | null;
  inlineWorking: Set<string>;
  enqueueWrites: Promise<unknown>;
  autoWrites: Promise<void>;
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
