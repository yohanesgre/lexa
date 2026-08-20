import { createRouter as createTanStackRouter, type Serializable } from "@tanstack/react-router";
import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";

export interface RouterContext {
  queryClient: QueryClient;
}

// Called once per SSR request on the server (createRequestHandler invokes
// getRouter() per request) and once per app on the client. The QueryClient
// therefore lives per-request on the server (no cross-request cache bleed) and
// is stable on the client.
export function getRouter() {
  const queryClient = new QueryClient();
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Queries-only dehydration: DehydratedState.mutations isn't Serializable
    // (mutationKey: unknown[]) and we never dehydrate mutations. The query
    // keys are plain serializable arrays by construction, so the cast is safe;
    // it also keeps the __TSR_DEHYDRATED__ payload lean (no mutations).
    dehydrate: () => {
      const state = dehydrate(queryClient, {
        shouldDehydrateMutation: () => false,
        // Loaders prefetch queries that aren't yet "observed" by a mounted
        // useQuery at dehydrate time — include them all so the client
        // hydrates the full cache instead of re-fetching on first paint.
        shouldDehydrateQuery: () => true,
      });
      return { queryClientState: { queries: state.queries } as unknown as Serializable };
    },
    hydrate: (payload) => {
      hydrate(queryClient, payload.queryClientState);
    },
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    context: RouterContext;
  }
}
