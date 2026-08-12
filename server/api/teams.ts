import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Effect, Schema } from "effect";
import type { LexaApi } from "./http";
import { AuthIdentity } from "./auth";
import { Forbidden } from "./errors";
import { respond } from "./http-helpers";
import { TeamsService } from "../services/teams.service";
import { AuthorizationService } from "../services/authorization.service";

const TeamSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  createdAt: Schema.String,
});

const TeamMemberRoleSchema = Schema.Literal("owner", "admin", "member");

const TeamMemberSchema = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: TeamMemberRoleSchema,
  createdAt: Schema.String,
});

const CreateTeamInput = Schema.Struct({
  name: Schema.String,
  slug: Schema.optional(Schema.String),
});

const AddTeamMemberInput = Schema.Struct({
  email: Schema.String,
  role: TeamMemberRoleSchema,
});

const SetMemberRoleInput = Schema.Struct({
  role: TeamMemberRoleSchema,
});

const TeamIdPath = Schema.Struct({ teamId: Schema.String });
const MemberPath = Schema.Struct({ teamId: Schema.String, userId: Schema.String });

export const teamsGroup = HttpApiGroup.make("teams")
  .add(HttpApiEndpoint.get("listTeams", "/teams").addSuccess(Schema.Struct({ data: Schema.Array(TeamSchema) })))
  .add(HttpApiEndpoint.post("createTeam", "/teams").setPayload(CreateTeamInput).addSuccess(TeamSchema, { status: 201 }))
  .add(HttpApiEndpoint.del("deleteTeam", "/teams/:teamId").setPath(TeamIdPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.get("listTeamMembers", "/teams/:teamId/members").setPath(TeamIdPath).addSuccess(Schema.Struct({ data: Schema.Array(TeamMemberSchema) })))
  .add(HttpApiEndpoint.post("addTeamMember", "/teams/:teamId/members").setPath(TeamIdPath).setPayload(AddTeamMemberInput).addSuccess(TeamMemberSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("setTeamMemberRole", "/teams/:teamId/members/:userId").setPath(MemberPath).setPayload(SetMemberRoleInput).addSuccess(TeamMemberSchema))
  .add(HttpApiEndpoint.del("removeTeamMember", "/teams/:teamId/members/:userId").setPath(MemberPath).addSuccess(Schema.Void, { status: 204 }));

// Team-management authority: keys + superadmin sessions are full access
// (identity.role "admin"); other sessions need org owner/admin on that team.
const requireTeamManager = (identity: { role: string; userId: string | null }, teamId: string) =>
  Effect.gen(function* () {
    if (identity.role === "admin") return;
    if (!identity.userId) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
    const authz = yield* AuthorizationService;
    const ok = yield* authz.canManageTeam(identity.userId, teamId);
    if (!ok) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
  });

// Superadmin-only gate: keys (identity.role "admin") + superadmin sessions.
const requireSuperadmin = (identity: { role: string }) =>
  identity.role === "admin" ? Effect.void : Effect.fail(new Forbidden({ message: "Admin role required" }));

export const createTeamsLive = (api: typeof LexaApi) =>
  HttpApiBuilder.group(api, "teams", (handlers) =>
    handlers
      .handle("listTeams", () =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          const teams = yield* TeamsService;
          if (identity.role === "admin") {
            const all = yield* teams.listAll();
            return { data: all };
          }
          if (!identity.userId) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
          const own = yield* teams.listForUser(identity.userId);
          return { data: own };
        }))
      )
      .handle("createTeam", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          if (!identity.userId) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
          const teams = yield* TeamsService;
          const team = yield* teams.create(req.payload.name, req.payload.slug, identity.userId);
          return team;
        }))
      )
      .handle("deleteTeam", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireSuperadmin(identity);
          const teams = yield* TeamsService;
          yield* teams.remove(req.path.teamId);
        }))
      )
      .handle("listTeamMembers", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireTeamManager(identity, req.path.teamId);
          const teams = yield* TeamsService;
          const members = yield* teams.members(req.path.teamId);
          return { data: members };
        }))
      )
      .handle("addTeamMember", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireTeamManager(identity, req.path.teamId);
          const teams = yield* TeamsService;
          const member = yield* teams.addMember(req.path.teamId, req.payload.email, req.payload.role);
          return member;
        }))
      )
      .handle("setTeamMemberRole", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireTeamManager(identity, req.path.teamId);
          const teams = yield* TeamsService;
          const member = yield* teams.setMemberRole(req.path.teamId, req.path.userId, req.payload.role);
          return member;
        }))
      )
      .handle("removeTeamMember", (req) =>
        respond(Effect.gen(function* () {
          const identity = yield* AuthIdentity;
          yield* requireTeamManager(identity, req.path.teamId);
          const teams = yield* TeamsService;
          yield* teams.removeMember(req.path.teamId, req.path.userId);
        }))
      )
  );
