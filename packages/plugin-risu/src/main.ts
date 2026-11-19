import { bootstrap } from "./app/bootstrap";

void bootstrap(risuai).catch((error: unknown) => {
  console.error("global-comfy-image startup failed", error);
  void risuai.alert(
    "全局生图启动失败：" +
      (error instanceof Error ? error.message : String(error)),
  );
});
