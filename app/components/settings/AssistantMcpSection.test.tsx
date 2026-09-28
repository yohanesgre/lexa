// @vitest-environment jsdom
// Wireframe admin-assistant-providers.html §MCP Clients: remote HTTP/SSE
// registry with the accurate empty state ("No MCP clients yet"), a
// two-option transport select defaulting to http, one-line field hints, and
// the test-result states (ok counts / MCP_CONNECT_FAILED).
// Secret source: the mode select (Reference | Managed), the write-only masked
// token input, the hasSecret-only masked chip, Clear secret → pending clear,
// and the disabled managed option when the server has no master key. The
// capability is tri-state: the warning names the env var only when the server
// has actually said the key is absent — an unanswered request claims nothing.
// No section subtitle, no notice panel, no stdio/command/args controls,
// no MCP_STDIO_UNAVAILABLE.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  servers: [] as unknown[],
  isLoading: false,
  // The server's real capability, reported on the list response. `undefined`
  // is the in-flight state the section must claim nothing about — no notice,
  // no disabled state beyond the select.
  managedSecrets: true as boolean | undefined,
  testResult: null as unknown,
  created: [] as unknown[],
  updated: [] as unknown[],
  deleted: [] as unknown[],
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useMcpServers: () => ({ data: h.servers, isLoading: h.isLoading }),
  useMcpManagedSecrets: () => ({ data: h.managedSecrets }),
  useCreateMcpServer: () => ({ mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.created.push(input); opts?.onSuccess?.(); }, isPending: false }),
  useUpdateMcpServer: () => ({ mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.updated.push(input); opts?.onSuccess?.(); }, isPending: false }),
  useDeleteMcpServer: () => ({ mutate: (id: string, opts?: { onSuccess?: () => void }) => { h.deleted.push(id); opts?.onSuccess?.(); }, isPending: false }),
  useTestMcpServer: () => ({ mutate: (_id: string, opts?: { onSuccess?: (res: unknown) => void }) => { opts?.onSuccess?.(h.testResult); }, isPending: false }),
}));

import { AssistantMcpSection } from "./AssistantMcpSection";
import type { McpServer, McpSecretSource } from "../../lib/api";

const TOKEN = "lin_api_3f9c1d7b2e";

function server(over: Partial<McpServer> & { id: string; label: string; hasSecret: boolean; secretSource: McpSecretSource }): McpServer {
  return {
    transportType: "http",
    url: "https://mcp.linear.example/mcp",
    command: null,
    args: [],
    enabled: true,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

const LINEAR: McpServer = server({ id: "linear", label: "Linear", hasSecret: true, secretSource: "reference" });
const MANAGED: McpServer = server({ id: "linear", label: "Linear", hasSecret: true, secretSource: "managed" });
const SECRETLESS: McpServer = server({ id: "linear", label: "Linear", hasSecret: false, secretSource: "none" });

function row(name: RegExp): HTMLElement {
  return screen.getByRole("row", { name });
}

async function openEdit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(row(/Linear/)).getByRole("button", { name: "Edit MCP client" }));
  return screen.findByLabelText("Secret source");
}

beforeEach(() => {
  h.servers = [LINEAR];
  h.isLoading = false;
  h.managedSecrets = true;
  h.testResult = null;
  h.created = [];
  h.updated = [];
  h.deleted = [];
});

describe("AssistantMcpSection — literal copy", () => {
  it("names the registry MCP Clients and never MCP Servers", () => {
    render(<AssistantMcpSection />);
    expect(screen.getByRole("heading", { name: "MCP Clients" })).toBeInTheDocument();
    // "MCP server" survives only in protocol-correct phrases ("remote MCP servers");
    // never as a user-facing label.
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
    expect(screen.queryByText("MCP servers")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /MCP server/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save server" })).not.toBeInTheDocument();
  });

  it("carries no section subtitle and no verbose notice copy", () => {
    render(<AssistantMcpSection />);
    expect(screen.queryByText(/connect to remote MCP servers over HTTP or SSE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/read-only-annotated tools/)).not.toBeInTheDocument();
    expect(screen.queryByText("Only read-only tools are exposed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Connects Lexa's MCP client to a remote MCP server/)).not.toBeInTheDocument();
  });

  it("has no stdio, command, args, seeded or local-process copy anywhere", () => {
    render(<AssistantMcpSection />);
    expect(screen.queryByText(/stdio/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/child process|spawn|same host/i)).not.toBeInTheDocument();
    expect(screen.queryByText("seeded")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Command")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Args/)).not.toBeInTheDocument();
  });

  it("labels the table columns Client / Endpoint", () => {
    render(<AssistantMcpSection />);
    expect(screen.getByRole("columnheader", { name: "Client" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Endpoint" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Server" })).not.toBeInTheDocument();
  });
});

describe("AssistantMcpSection — empty state", () => {
  it("renders the wireframe empty state verbatim", () => {
    h.servers = [];
    render(<AssistantMcpSection />);
    expect(screen.getByText("No MCP clients yet")).toBeInTheDocument();
    expect(screen.getByText("Add a remote MCP client below. No clients are pre-seeded.")).toBeInTheDocument();
  });

  it("shows a table-shaped skeleton while loading", () => {
    h.isLoading = true;
    render(<AssistantMcpSection />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("No MCP clients yet")).not.toBeInTheDocument();
  });
});

describe("AssistantMcpSection — transport form", () => {
  it("offers only the two remote transports and defaults to http", () => {
    render(<AssistantMcpSection />);
    const select = screen.getByLabelText("Transport") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["http", "sse"]);
    expect(select.value).toBe("http");
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
  });

  it("keeps the URL field across both transports", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.selectOptions(screen.getByLabelText("Transport"), "sse");
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
  });

  it("keeps one line hints for the URL and secret reference fields", () => {
    render(<AssistantMcpSection />);
    expect(screen.getByText(/http\(s\) only · no userinfo · SSRF-checked against the URL allowlist at save and connect/)).toBeInTheDocument();
    expect(screen.getByText(/Bearer token reference, never the token itself/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("env:NAME or file:/abs/path")).toBeInTheDocument();
  });

  it("saves a client with label + url and no command/args", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.type(screen.getByLabelText("Label"), "Linear");
    await user.type(screen.getByLabelText("URL"), "https://mcp.linear.example/mcp");
    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(h.created).toEqual([{ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp" }]);
  });
});

describe("AssistantMcpSection — secret source select", () => {
  it("offers exactly Reference | Managed token and defaults to Reference", () => {
    render(<AssistantMcpSection />);
    const select = screen.getByLabelText("Secret source") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Reference (env: / file:)",
      "Managed token (stored encrypted)",
    ]);
    expect(select.value).toBe("reference");
  });

  it("states the one-source guarantee under the select", () => {
    render(<AssistantMcpSection />);
    expect(screen.getByText(/One Bearer secret per client\. Pick where it comes from — either way the value is write-only and never shown back\./)).toBeInTheDocument();
  });

  it("renders the reference branch by default and the token branch on switch — never both", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    expect(screen.getByLabelText("Secret reference")).toBeInTheDocument();
    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Secret source"), "managed");
    expect(screen.getByLabelText("Bearer token")).toBeInTheDocument();
    expect(screen.queryByLabelText("Secret reference")).not.toBeInTheDocument();
  });

  it("drops the other branch's value locally when the mode switches", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.type(screen.getByLabelText("Label"), "Linear");
    await user.type(screen.getByLabelText("URL"), "https://mcp.linear.example/mcp");
    await user.type(screen.getByLabelText("Secret reference"), "env:LINEAR_MCP_TOKEN");
    await user.selectOptions(screen.getByLabelText("Secret source"), "managed");
    await user.type(screen.getByLabelText("Bearer token"), TOKEN);
    await user.selectOptions(screen.getByLabelText("Secret source"), "reference");

    expect(screen.getByLabelText("Secret reference")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(h.created[0]).not.toHaveProperty("secret");
    expect(h.created[0]).not.toHaveProperty("secretRef");
  });

  it("prefills the mode select from secretSource when editing", async () => {
    const user = userEvent.setup();
    h.servers = [MANAGED];
    render(<AssistantMcpSection />);
    const select = await openEdit(user);
    expect(select).toHaveValue("managed");
    expect(screen.getByLabelText("Bearer token")).toBeInTheDocument();
    expect(screen.queryByLabelText("Secret reference")).not.toBeInTheDocument();
  });

  it("secretSource 'none' falls back to the Reference branch with no chip", async () => {
    const user = userEvent.setup();
    h.servers = [SECRETLESS];
    render(<AssistantMcpSection />);
    const select = await openEdit(user);
    expect(select).toHaveValue("reference");
    expect(screen.getByLabelText("Secret reference")).toBeInTheDocument();
    expect(screen.queryByText(/Saved/, { selector: ".chip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear secret/ })).not.toBeInTheDocument();
  });
});

describe("AssistantMcpSection — masked chip", () => {
  it("marks a stored secret as saved with a fixed-width mask — no value, name, path or prefix", async () => {
    const user = userEvent.setup();
    h.servers = [MANAGED];
    render(<AssistantMcpSection />);
    await openEdit(user);
    const chip = await screen.findByText(/Saved/, { selector: ".chip" });
    expect(chip).toHaveTextContent("Saved · ••••••••");
    expect(chip.textContent).not.toContain("env");
    expect(chip.textContent).not.toContain("file:");
    expect(chip.textContent).not.toContain(TOKEN);
    expect(chip.textContent).not.toContain("manag");
  });

  it("never prefills a secret field with a stored value", async () => {
    const user = userEvent.setup();
    h.servers = [MANAGED];
    render(<AssistantMcpSection />);
    await openEdit(user);
    expect(screen.getByLabelText("Bearer token")).toHaveValue("");
    expect(screen.getByLabelText("Bearer token")).toHaveAttribute("type", "password");
  });

  it("renders no chip for a secret-less client", async () => {
    const user = userEvent.setup();
    h.servers = [SECRETLESS];
    render(<AssistantMcpSection />);
    await openEdit(user);
    expect(screen.queryByText(/Saved/, { selector: ".chip" })).not.toBeInTheDocument();
  });
});

describe("AssistantMcpSection — managed token input", () => {
  it("is masked, write-only, and never echoes the typed value anywhere", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.type(screen.getByLabelText("Label"), "Linear");
    await user.type(screen.getByLabelText("URL"), "https://mcp.linear.example/mcp");
    await user.selectOptions(screen.getByLabelText("Secret source"), "managed");

    const field = screen.getByLabelText("Bearer token") as HTMLInputElement;
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("placeholder", "Paste the Bearer token");
    await user.type(field, TOKEN);

    // A password input is not in the accessible text, and the surrounding
    // surface must not carry the value either.
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.queryByText(new RegExp(TOKEN))).not.toBeInTheDocument();
  });

  it("carries the managed token in the write payload as `secret` and never as `secretRef`", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.type(screen.getByLabelText("Label"), "Linear");
    await user.type(screen.getByLabelText("URL"), "https://mcp.linear.example/mcp");
    await user.selectOptions(screen.getByLabelText("Secret source"), "managed");
    await user.type(screen.getByLabelText("Bearer token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save client" }));

    expect(h.created).toEqual([{ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", secret: TOKEN }]);
    const body = JSON.stringify(h.created);
    expect(body).not.toContain("secretRef");
  });

  it("saving an empty managed field stores a legal secret-less client", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.type(screen.getByLabelText("Label"), "Linear");
    await user.type(screen.getByLabelText("URL"), "https://mcp.linear.example/mcp");
    await user.selectOptions(screen.getByLabelText("Secret source"), "managed");
    await user.click(screen.getByRole("button", { name: "Save client" }));

    expect(h.created).toEqual([{ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp" }]);
    expect(h.created[0]).not.toHaveProperty("secret");
    expect(h.created[0]).not.toHaveProperty("secretRef");
    expect(h.created[0]).not.toHaveProperty("clearSecret");
  });

  it("shows the write-only marker and AES-GCM guidance in the unsaved managed branch", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.selectOptions(screen.getByLabelText("Secret source"), "managed");
    expect(screen.getByText("write-only")).toBeInTheDocument();
    expect(screen.getByText(/Encrypted with AES-256-GCM \(fresh 12-byte IV, bound to the client id\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Saved/, { selector: ".chip" })).not.toBeInTheDocument();
  });

  // Card 3 of the state catalog: a stored managed token gets its own readback
  // hint. "Empty keeps the stored token" is the load-bearing sentence — it is
  // why a masked field can never be a removal route.
  it("shows the card-3 readback hint when a managed token is stored, never the not-set-yet copy", async () => {
    const user = userEvent.setup();
    h.servers = [MANAGED];
    render(<AssistantMcpSection />);
    await openEdit(user);
    expect(screen.getByText(/Read back as/)).toBeInTheDocument();
    expect(screen.getByText(/Empty keeps the stored token; typing replaces it on Save\./)).toBeInTheDocument();
    expect(screen.queryByText(/Encrypted with AES-256-GCM \(fresh 12-byte IV, bound to the client id\)/)).not.toBeInTheDocument();
  });

  it("a pending clear outranks the managed hint in either branch — the clearPending copy wins", async () => {
    const user = userEvent.setup();
    h.servers = [MANAGED];
    render(<AssistantMcpSection />);
    await openEdit(user);
    await user.click(screen.getByRole("button", { name: /Clear secret/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear secret/ }));

    expect(screen.getByText(/Entering a value here cancels the pending clear/)).toBeInTheDocument();
    expect(screen.queryByText(/Encrypted with AES-256-GCM \(fresh 12-byte IV, bound to the client id\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Empty keeps the stored token/)).not.toBeInTheDocument();
  });
});

describe("AssistantMcpSection — clear secret", () => {
  it("opens the wireframe confirm, naming only the client id", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await openEdit(user);
    await user.click(screen.getByRole("button", { name: /Clear secret/ }));

    expect(screen.getByText("Clear secret?")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("linear");
    expect(dialog).toHaveTextContent(/connects with no Authorization header/);
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(dialog.textContent).not.toContain("env:");
    expect(dialog.textContent).not.toContain(TOKEN);
  });

  it("drops into the pending-clear state until Save, and never posts a blank secretRef", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await openEdit(user);
    await user.click(screen.getByRole("button", { name: /Clear secret/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear secret/ }));

    // Card 4: chip and trigger gone, field back to its placeholder, danger
    // notice held until Save writes clearSecret: true.
    expect(screen.queryByText(/Saved/, { selector: ".chip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear secret/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Secret reference")).toHaveAttribute("placeholder", "env:NAME or file:/abs/path");
    expect(screen.getByText("Secret will be removed on Save.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(h.updated).toEqual([{ id: "linear", label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", clearSecret: true }]);
    expect(h.updated[0]).not.toHaveProperty("secretRef");
    expect(h.updated[0]).not.toHaveProperty("secret");
  });

  it("cancelling the confirm keeps the secret and the chip", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await openEdit(user);
    await user.click(screen.getByRole("button", { name: /Clear secret/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Clear secret?")).not.toBeInTheDocument();
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();
    expect(screen.queryByText("Secret will be removed on Save.")).not.toBeInTheDocument();
  });

  it("typing into the field after a pending clear keeps the secret instead of clearing it", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await openEdit(user);
    await user.click(screen.getByRole("button", { name: /Clear secret/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear secret/ }));
    await user.type(screen.getByLabelText("Secret reference"), "env:LINEAR_MCP_TOKEN");

    expect(screen.queryByText("Secret will be removed on Save.")).not.toBeInTheDocument();
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(h.updated[0]).toMatchObject({ secretRef: "env:LINEAR_MCP_TOKEN" });
    expect(h.updated[0]).not.toHaveProperty("clearSecret");
  });

  it("clears a stored managed token through the same route", async () => {
    const user = userEvent.setup();
    h.servers = [MANAGED];
    render(<AssistantMcpSection />);
    await openEdit(user);
    await user.click(screen.getByRole("button", { name: /Clear secret/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Clear secret/ }));

    expect(screen.getByText("Secret will be removed on Save.")).toBeInTheDocument();
    expect(screen.getByLabelText("Bearer token")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(h.updated[0]).toMatchObject({ clearSecret: true });
    expect(h.updated[0]).not.toHaveProperty("secret");
  });

  it("a secret-less client offers no Clear trigger at all", async () => {
    const user = userEvent.setup();
    h.servers = [SECRETLESS];
    render(<AssistantMcpSection />);
    await openEdit(user);
    expect(screen.queryByRole("button", { name: /Clear secret/ })).not.toBeInTheDocument();
  });
});

// The capability comes from the list response (useMcpManagedSecrets), never a
// prop: the server owns whether a token can be encrypted, so the browser never
// assumes the feature exists. `undefined` is the in-flight answer.
describe("AssistantMcpSection — master key present", () => {
  it("shows no warning notice and leaves the managed option selectable", () => {
    render(<AssistantMcpSection />);
    expect(screen.queryByText(/Managed tokens are off/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Secret source")).getByRole("option", { name: "Managed token (stored encrypted)" })).toBeEnabled();
  });
});

describe("AssistantMcpSection — no master key", () => {
  beforeEach(() => {
    h.managedSecrets = false;
  });

  it("disables the managed option in the select, never hides it", () => {
    render(<AssistantMcpSection />);
    const select = screen.getByLabelText("Secret source") as HTMLSelectElement;
    const managed = within(select).getByRole("option", { name: "Managed token (stored encrypted)" }) as HTMLOptionElement;
    expect(managed).toBeInTheDocument();
    expect(managed).toBeDisabled();
    expect(within(select).getByRole("option", { name: "Reference (env: / file:)" })).toBeEnabled();
  });

  it("names the exact env var in a warning notice and keeps the reference branch working", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    expect(screen.getByText(/Managed tokens are off — this server has no/)).toBeInTheDocument();
    expect(screen.getByText("LXK_MCP_MASTER_KEY")).toBeInTheDocument();
    expect(screen.getByText(/References work exactly as they do today\./)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Label"), "Linear");
    await user.type(screen.getByLabelText("URL"), "https://mcp.linear.example/mcp");
    await user.type(screen.getByLabelText("Secret reference"), "env:LINEAR_MCP_TOKEN");
    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(h.created[0]).toMatchObject({ secretRef: "env:LINEAR_MCP_TOKEN" });
  });

  it("a missing key never hides a stored secret — the managed branch stays selected, masked and clearable", async () => {
    const user = userEvent.setup();
    h.servers = [MANAGED];
    render(<AssistantMcpSection />);
    const select = await openEdit(user);
    expect(select).toHaveValue("managed");
    expect(within(select).getByRole("option", { name: "Managed token (stored encrypted)" })).toBeDisabled();
    expect(screen.getByText(/Saved/, { selector: ".chip" })).toBeInTheDocument();
    expect(screen.getByLabelText("Bearer token")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /Clear secret/ })).toBeInTheDocument();
    expect(screen.getByText(/still decrypts on the next connect/)).toBeInTheDocument();
  });
});

// The capability is tri-state: true (key present), false (the server said the
// key is absent), undefined (the list request has not answered — in flight, or
// failed with retry: false). Only the second is a fact the warning may state.
describe("AssistantMcpSection — capability unknown (list in flight)", () => {
  beforeEach(() => {
    h.managedSecrets = undefined;
  });

  it("offers only the reference branch while the capability is unanswered", () => {
    render(<AssistantMcpSection />);
    const select = screen.getByLabelText("Secret source") as HTMLSelectElement;
    expect(select.value).toBe("reference");
    expect(within(select).getByRole("option", { name: "Managed token (stored encrypted)" })).toBeDisabled();
    expect(screen.getByLabelText("Secret reference")).toBeEnabled();
  });

  it("claims nothing: no notice, no env var named, no managed field offered", () => {
    render(<AssistantMcpSection />);
    expect(screen.queryByText(/Managed tokens are off/)).not.toBeInTheDocument();
    expect(screen.queryByText("LXK_MCP_MASTER_KEY")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();
  });

  it("speaks only once the server answers false → the notice and the disabled option", () => {
    h.managedSecrets = false;
    render(<AssistantMcpSection />);
    expect(screen.getByText(/Managed tokens are off — this server has no/)).toBeInTheDocument();
    expect(screen.getByText("LXK_MCP_MASTER_KEY")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Secret source")).getByRole("option", { name: "Managed token (stored encrypted)" })
    ).toBeDisabled();
  });
});

describe("AssistantMcpSection — test results", () => {
  it("shows OK tool counts in the row from the test response body", async () => {
    const user = userEvent.setup();
    h.testResult = { ok: true, toolCount: 12, readOnlyToolCount: 9, latencyMs: 412, error: null };
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Test" }));
    expect(await screen.findByText("12 total · 9 read-only")).toBeInTheDocument();
  });

  it("shows MCP_CONNECT_FAILED from a failed test body (HTTP 200)", async () => {
    const user = userEvent.setup();
    h.testResult = { ok: false, toolCount: 0, readOnlyToolCount: 0, latencyMs: 0, error: { code: "MCP_CONNECT_FAILED", message: "handshake failed" } };
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Test" }));
    expect(await screen.findByText("MCP_CONNECT_FAILED")).toBeInTheDocument();
  });

  it("shows MCP_INVALID_TRANSPORT_CONFIG when a test-endpoint transport check fails", async () => {
    const user = userEvent.setup();
    h.testResult = { ok: false, toolCount: 0, readOnlyToolCount: 0, latencyMs: 0, error: { code: "MCP_INVALID_TRANSPORT_CONFIG", message: "unsupported transport" } };
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Test" }));
    expect(await screen.findByText("MCP_INVALID_TRANSPORT_CONFIG")).toBeInTheDocument();
  });
});

describe("AssistantMcpSection — registry actions", () => {
  it("toggling enabled sends the inverted value", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Linear enabled" }));
    expect(h.updated).toEqual([{ id: "linear", enabled: false }]);
  });

  it("delete opens a confirm dialog and deletes by id", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Delete MCP client" }));
    expect(screen.getByText("Delete MCP client?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Delete client/ }));
    expect(h.deleted).toEqual(["linear"]);
  });
});
