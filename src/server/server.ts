import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "./app.ts";

export type RunningServer = { url: string; close: () => Promise<void> };

export function startServer(deps: AppDeps & { port: number }): Promise<RunningServer> {
  const app = createApp(deps);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: deps.port }, (info: AddressInfo) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
