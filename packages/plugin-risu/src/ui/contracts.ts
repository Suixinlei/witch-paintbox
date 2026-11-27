import type { GenerationService } from "../step2/service";
import type { Runtime } from "../shared/events";
export interface UiServices {
  generation: GenerationService;
  runtime: Runtime;
}
export type View = "connection" | "automatic";
