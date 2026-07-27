import { createFileRoute } from "@tanstack/react-router";
import { createApiHandler } from "../../../server/api/http";

let cachedHandler: ((req: Request) => Promise<Response>) | undefined;

function getHandler(): (req: Request) => Promise<Response> {
  if (!cachedHandler) {
    const app = createApiHandler() as unknown as { handler?: (req: Request) => Promise<Response> } | ((req: Request) => Promise<Response>);
    cachedHandler = typeof app === "function" ? app : app.handler;
  }
  return cachedHandler!;
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        ANY: async ({ request }) => {
          const handler = getHandler();
          const url = new URL(request.url);
          const proxyRequest = new Request(url.origin + url.pathname + url.search, {
            method: request.method,
            headers: request.headers,
            body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
          });
          return handler(proxyRequest);
        },
      }),
  },
});
