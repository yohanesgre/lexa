import { Effect } from "effect";
import { ApiKeyService } from "../../services/api-key.service";

export const tool = {
  name: "create_api_key",
  description: "Create a new API key. Admin only. The raw key is shown once — save it immediately.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Human-readable name for this key" },
    },
    required: ["name"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const apiKeyService = yield* ApiKeyService;
      const result = yield* apiKeyService.create(args.name);
      return {
        key: { id: result.key.id, name: result.key.name, createdAt: result.key.createdAt },
        rawKey: result.rawKey,
      };
    }),
};
