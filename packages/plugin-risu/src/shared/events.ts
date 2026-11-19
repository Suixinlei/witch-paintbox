export interface Runtime {
  disposed: boolean;
  status: string;
  notify(render?: boolean): void;
}
export function createRuntime() {
  const subscribers = new Set<(render: boolean) => void>();
  return {
    disposed: false,
    status: "就绪",
    notify(render = true) {
      for (const subscriber of subscribers) subscriber(render);
    },
    subscribe(listener: (render: boolean) => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };
}
