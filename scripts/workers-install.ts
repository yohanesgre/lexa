#!/usr/bin/env bun
// Workers deploy installer — runs from inside the release workers tarball
// (bun scripts/workers-install.ts) with no repo checkout. This is a thin bin:
// the provisioning core lives in scripts/lib/cf-deploy.ts (importable without
// executing a deploy); here it runs only when this file is the entry script.
//
// Usage:
//   bun workers-install.ts --name <deploy> \
//     [--cf-token <tok>]              # else CF_API_TOKEN / CLOUDFLARE_API_TOKEN
//     [--account <id>]                # else CLOUDFLARE_ACCOUNT_ID / prior config
//     [--domain lexa.example.com]     # custom domain; absent = workers.dev
//     [--dir <unpack dir>]            # default: cwd
//
// The CF token is read from --cf-token when present, otherwise from the
// CF_API_TOKEN / CLOUDFLARE_API_TOKEN environment (the installer passes it via
// the environment so it never appears in argv).
//
// The Cloudflare account is resolved BEFORE any resource is created: an
// explicit --account / CLOUDFLARE_ACCOUNT_ID, else the previous deploy's
// wrangler config (read before staging wipes it), else the token's account
// list (one → use it; several → TTY pick, headless die). A refusal here must
// create nothing — the incident this guards against used accounts[0] blindly
// and provisioned resources on the wrong account.
//
// Superadmin provisioning is NOT done here — the web /setup wizard owns it
// (owner decision: free-choice email + password at first install). API
// keys are minted post-setup (login → Settings → API Keys).

import { main } from "./lib/cf-deploy";

// Side effects (CF calls, file writes) only run as the entry script; importing
// this file — or the core — stays inert.
if (import.meta.main) {
  await main();
}
