import { createFileRoute } from "@tanstack/react-router";
import { DeviceLoginPage } from "../components/device-login/page";

// /device-login — approve surface for lexa-cli pairing (wireframes/src/device-login.html).
// The verifyUrl carries request id + token; approval needs session + token both.
export const Route = createFileRoute("/device-login")({
  validateSearch: (search: Record<string, unknown>): { request?: string | undefined; token?: string | undefined } => ({
    request: typeof search.request === "string" && search.request ? search.request : undefined,
    token: typeof search.token === "string" && search.token ? search.token : undefined,
  }),
  ssr: false,
  component: DeviceLoginPage,
});