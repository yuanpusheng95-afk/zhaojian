import type { Server } from "node:http";
import http from "node:http";

import { createApp, type AppDeps } from "@/api/app";

export function createApiServer(dependencies: AppDeps): Server {
  const app = createApp({ ...dependencies, logger: dependencies.logger ?? console });
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    try {
      const honoResponse = await app.fetch(new Request(requestUrl, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method ?? "") ? undefined : request,
        duplex: "half",
      } as RequestInit));
      response.writeHead(honoResponse.status, Object.fromEntries(honoResponse.headers));
      if (honoResponse.body) {
        for await (const chunk of honoResponse.body) response.write(chunk);
      }
      response.end();
    } catch (error) {
      dependencies.logger?.error?.("Unhandled error:", error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }));
    }
  });
}
