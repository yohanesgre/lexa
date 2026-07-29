import { Effect } from "effect";
import { ApiKeyService } from "../../services/api-key.service";

export const tool = {
  name: "delete_api_key",
  description: "Delete an API key. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "API key ID" },
    },
    required: ["id"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const apiKeyService = yield* ApiKeyService;
      yield* apiKeyService.delete(args.id);
      return { deleted: true };
    }),
};
