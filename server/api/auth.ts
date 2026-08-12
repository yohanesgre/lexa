import { Context } from "effect";
import type { Actor } from "../../shared/types";

// Caller identity behind a validated API key or session cookie, resolved once
// per request by the API middleware and consumed by gated handlers. role is
// "admin" for key callers (unbound keys are admin; key-owned users map
// superadmin→admin) and for session superadmins; "member" for member
// sessions/keys. The legacy x-lxk-user header is gone — attribution comes
// from the session user or the key name.
export interface AuthIdentityShape {
  keyId: string;
  keyName: string;
  userId: string | null;
  userName: string | null;
  role: "admin" | "member";
}
export class AuthIdentity extends Context.Tag("Lexa/AuthIdentity")<AuthIdentity, AuthIdentityShape>() {}

// Build the activity-timeline actor for a resolved identity: session users
// (and key-bound users) attribute as 'user', bare API keys as 'agent' with
// the key name as label.
export function actorFromIdentity(identity: AuthIdentityShape): Actor {
  return {
    kind: identity.userId ? "user" : "agent",
    label: identity.userName ?? identity.keyName,
    userId: identity.userId,
  };
}
