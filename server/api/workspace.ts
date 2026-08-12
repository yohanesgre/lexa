import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Effect, Schema } from "effect";
import type { LexaApi } from "./http";
import { AuthIdentity } from "./auth";
import { Forbidden, CannotDeleteSelf } from "./errors";
import { respond } from "./http-helpers";
import { WorkspaceService, WorkspaceUserNotFound } from "../services/workspace.service";
import { InviteAlreadyPending } from "../services/workspace-invites.service";
import { PasswordLinkIssueFailed } from "../services/password-links.service";
import { RowNotFound } from "../db/database";
import type { TeamMemberRole } from "../../shared/types";

const WorkspaceMemberSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.Literal("superadmin", "member"),
  createdAt: Schema.String,
  lastSeen: Schema.NullOr(Schema.String),
  teams: Schema.Array(
    Schema.Struct({
      teamId: Schema.String,
      teamName: Schema.String,
      role: Schema.Literal("owner", "admin", "member"),
    })
  ),
});

const WorkspaceUserSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.Literal("superadmin", "member"),
  createdAt: Schema.String,
  lastSeen: Schema.NullOr(Schema.String),
});

const SetActiveInput = Schema.Struct({ action: Schema.Literal("deactivate", "reactivate") });
const EmailInput = Schema.Struct({ email: Schema.String });
const LinkResponse = Schema.Struct({ link: Schema.String });
const UserIdPath = Schema.Struct({ userId: Schema.String });
const InviteIdPath = Schema.Struct({ inviteId: Schema.String });
// Pending invites only (accepted ones are stamped accepted_at and dropped) —
// the Members UI renders the revoke list from this.
const PendingInviteSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  expiresAt: Schema.String,
});

export const workspaceGroup = HttpApiGroup.make("workspace")
  .add(HttpApiEndpoint.get("listMembers", "/workspace/members").addSuccess(Schema.Struct({ data: Schema.Array(WorkspaceMemberSchema) })))
  .add(HttpApiEndpoint.patch("setMemberActive", "/workspace/members/:userId").setPath(UserIdPath).setPayload(SetActiveInput).addSuccess(WorkspaceUserSchema))
  .add(HttpApiEndpoint.del("removeMember", "/workspace/members/:userId").setPath(UserIdPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.get("listInvites", "/workspace/invites").addSuccess(Schema.Struct({ data: Schema.Array(PendingInviteSchema) })))
  .add(HttpApiEndpoint.post("createInvite", "/workspace/invites").setPayload(EmailInput).addSuccess(LinkResponse, { status: 201 }))
  .add(HttpApiEndpoint.del("revokeInvite", "/workspace/invites/:inviteId").setPath(InviteIdPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("issuePasswordLink", "/workspace/members/:userId/set-password-link").setPath(UserIdPath).addSuccess(LinkResponse, { status: 201 }));

const requireSuperadmin = (identity: { role: string }) =>
  identity.role === "admin" ? Effect.void : Effect.fail(new Forbidden({ message: "Admin role required" }));

export const createWorkspaceLive = (api: typeof LexaApi) =>
  HttpApiBuilder.group(api, "workspace", (handlers) =>
    handlers
      .handle("listMembers", () =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          const workspace = yield* WorkspaceService;
          const members = yield* workspace.listMembers();
          return { data: members };
        }))
      )
      .handle("setMemberActive", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          if (identity.userId === req.path.userId) {
            return yield* Effect.fail(new CannotDeleteSelf());
          }
          const workspace = yield* WorkspaceService;
          const user = yield* workspace.setActive(req.path.userId, req.payload.action === "reactivate");
          return user;
        }))
      )
      .handle("removeMember", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          if (identity.userId === req.path.userId) {
            return yield* Effect.fail(new CannotDeleteSelf());
          }
          const workspace = yield* WorkspaceService;
          yield* workspace.removeUser(req.path.userId);
        }))
      )
      .handle("createInvite", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          const workspace = yield* WorkspaceService;
          if (!identity.userId) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
          const { link } = yield* workspace.createInvite(req.payload.email, identity.userId);
          return { link };
        }))
      )
      .handle("revokeInvite", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          const workspace = yield* WorkspaceService;
          yield* workspace.revokeInvite(req.path.inviteId);
        }))
      )
      .handle("listInvites", () =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          const workspace = yield* WorkspaceService;
          const invites = yield* workspace.listInvites();
          const pending = invites.filter((i) => i.acceptedAt === null).map((i) => ({ id: i.id, email: i.email, expiresAt: i.expiresAt }));
          return { data: pending };
        }))
      )
      .handle("issuePasswordLink", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          const workspace = yield* WorkspaceService;
          const { link } = yield* workspace.issuePasswordLink(req.path.userId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new WorkspaceUserNotFound({ userId: req.path.userId })))
          );
          return { link };
        }))
      )
  );

// Re-exported so the http.ts error map can reach these tags.
export { WorkspaceUserNotFound, InviteAlreadyPending, PasswordLinkIssueFailed };
export type { TeamMemberRole };
