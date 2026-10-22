import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "./app.ts";
import type { BatchReport } from "./batch.ts";

export type RunningServer = {
  url: string;
  close: () => Promise<void>;
  // Runs the monthly batch now; tests call it rather than waiting for the schedule.
  runMonthlyBatch: () => Promise<BatchReport>;
};

export type ServerOptions = AppDeps & {
  port: number;
  // How often the monthly batch looks for ended periods to settle; off when not set.
  batchEveryMs?: number;
  onBatch?: (report: BatchReport) => void;
};

export function startServer({ batchEveryMs, onBatch = () => {}, ...deps }: ServerOptions): Promise<RunningServer> {
  const { app, runMonthlyBatch } = createApp(deps);
  const tick = () => runMonthlyBatch().then(onBatch, (err) => console.error("Monthly batch failed:", err));
  const timer = batchEveryMs ? setInterval(tick, batchEveryMs) : undefined;
  timer?.unref();
  if (timer) void tick();
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: deps.port }, (info: AddressInfo) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => {
          clearInterval(timer);
          return new Promise((done) => server.close(() => done()));
        },
        runMonthlyBatch,
      });
    });
  });
}
