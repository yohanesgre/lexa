import { Effect } from "effect";
import { UserService } from "../../services/user.service";

export const tool = {
  name: "list_users",
  description: "List all users. Admin only.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const userService = yield* UserService;
      const users = yield* userService.list();
      return {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          createdAt: u.created_at,
          lastSeen: u.last_seen,
        })),
      };
    }),
};
