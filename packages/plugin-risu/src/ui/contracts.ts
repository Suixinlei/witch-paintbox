import type { ExtractionService } from "../step1/service";
import type { GenerationService } from "../step2/service";
import type { Runtime } from "../shared/events";
import type { OutfitTestService } from "../step1/outfitTest";
export interface UiServices {
  outfitTest: OutfitTestService;
  extraction: ExtractionService;
  generation: GenerationService;
  runtime: Runtime;
  image(jobId: string, index: number, legacy: boolean): Promise<string | null>;
}
export type View =
  | "connection"
  | "library"
  | "outfits"
  | "automatic"
  | "settings"
  | "history";
