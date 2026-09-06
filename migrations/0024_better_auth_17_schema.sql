-- better-auth 1.7 startup schema check mandates these, even though Lexa
-- never uses them: the organization plugin requires an `invitation` table
-- (team membership stays direct member-row insertion, no email invites),
-- and the admin plugin adds `session.impersonatedBy`.
CREATE TABLE invitation (
  id             TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  role           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  teamId         TEXT,
  inviterId      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expiresAt      TEXT NOT NULL,
  createdAt      TEXT NOT NULL
);

CREATE INDEX invitation_organizationId_idx ON invitation(organizationId);
CREATE INDEX invitation_email_idx ON invitation(email);

ALTER TABLE session ADD COLUMN impersonatedBy TEXT;
