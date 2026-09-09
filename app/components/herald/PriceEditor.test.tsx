// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PriceEditor } from "./PriceEditor";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const prices = {
  data: [
    { model: "m1", prompt_price: 3, completion_price: 15, cached_read_price: 0.3, cached_write_price: 3.75, updated_at: "t" },
  ],
};

describe("PriceEditor", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders 4 price inputs per model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => prices }));
    render(<PriceEditor byModel={[]} />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByLabelText("prompt_price for m1")).toBeTruthy());
    expect(screen.getByLabelText("completion_price for m1")).toBeTruthy();
    expect(screen.getByLabelText("cached_read_price for m1")).toBeTruthy();
    expect(screen.getByLabelText("cached_write_price for m1")).toBeTruthy();
    expect(screen.getByText("cached read")).toBeTruthy();
    expect(screen.getByText("cached write")).toBeTruthy();
  });

  it("Save PUTs 4 fields including cached prices", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => prices })
      .mockResolvedValueOnce({ ok: true, json: async () => prices.data[0] });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PriceEditor byModel={[]} />, { wrapper: wrapper() });
    await screen.findByLabelText("cached_read_price for m1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1]!;
    expect((init as RequestInit).method).toBe("PUT");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "m1", prompt_price: 3, completion_price: 15, cached_read_price: 0.3, cached_write_price: 3.75 });
  });
});
