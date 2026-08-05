import { Effect } from "effect";
import { UserService } from "../../services/user.service";

export const tool = {
  name: "update_user_role",
  description: "Promote a user to admin or demote to member. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User ID" },
      role: { type: "string", enum: ["admin", "member"], description: "New role" },
    },
    required: ["userId", "role"],
  },
  handler: (args: { userId: string; role: "admin" | "member" }, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const userService = yield* UserService;
      yield* userService.getById(args.userId);
      if (args.role === "admin") {
        yield* userService.promoteToAdmin(args.userId);
      } else {
        yield* userService.demoteToMember(args.userId, auth?.userId ?? "0");
      }
      const user = yield* userService.getById(args.userId);
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    }),
};
