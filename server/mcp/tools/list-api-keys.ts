import { Effect } from "effect";
import { ApiKeyService } from "../../services/api-key.service";

export const tool = {
  name: "list_api_keys",
  description: "List all API keys. Admin only. Key hashes are not returned — only metadata.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: (_args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const apiKeyService = yield* ApiKeyService;
      const keys = yield* apiKeyService.list();
      return { data: keys.map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })) };
    }),
};
