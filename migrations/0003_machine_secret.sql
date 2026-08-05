-- Machine→host binding secret (F1 closure, 2026-08-06): each machine row
-- carries a per-machine secret minted at first registration. The claim
-- surface (install events delivering fresh daemon keys) requires it, closing
-- the machine-id spoofing → install-event hijack. Legacy rows keep '' and
-- must be removed + re-registered (never minted in place).

ALTER TABLE machines ADD COLUMN secret TEXT NOT NULL DEFAULT '';
