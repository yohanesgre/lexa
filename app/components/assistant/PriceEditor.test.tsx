// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper, createTestQueryClient } from "../../test-utils";
import { PriceEditor } from "./PriceEditor";

const wrapper = () => createQueryWrapper(createTestQueryClient());

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

  it("keeps the prices table and shows the loading state inside it", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const { container } = render(<PriceEditor byModel={[]} />, { wrapper: wrapper() });
    expect(container.querySelector("table.settings-table--assistant-prices")).toBeTruthy();
    expect(screen.getByText("Loading prices…")).toBeTruthy();
    expect(screen.queryByText("No models yet")).toBeNull();
  });

  it("renders a missing model's inputs blank, never 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
    render(<PriceEditor byModel={[{ model: "m2", tokens: 0, costCents: 0, costUsd: 0, avgLatencyMs: null, calls: 0, errorRate: 0 }]} />, { wrapper: wrapper() });
    const input = await screen.findByLabelText("prompt_price for m2");
    expect((input as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("completion_price for m2") as HTMLInputElement).value).toBe("");
  });

  it("rejects an empty price and never PUTs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => prices });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PriceEditor byModel={[]} />, { wrapper: wrapper() });
    const input = await screen.findByLabelText("prompt_price for m1");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Enter a price/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects exponent notation and never PUTs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => prices });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PriceEditor byModel={[]} />, { wrapper: wrapper() });
    const input = await screen.findByLabelText("prompt_price for m1");
    await user.clear(input);
    await user.type(input, "1e3");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Enter a price/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("formats an exponent-formatted stored default without exponent and saves it unchanged", async () => {
    const tinyPrices = { data: [{ model: "m1", prompt_price: 5e-7, completion_price: 0, cached_read_price: 0, cached_write_price: 0, updated_at: "t" }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => tinyPrices })
      .mockResolvedValueOnce({ ok: true, json: async () => tinyPrices.data[0] });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PriceEditor byModel={[]} />, { wrapper: wrapper() });
    const input = await screen.findByLabelText("prompt_price for m1") as HTMLInputElement;
    expect(input.value).toBe("0.0000005");
    expect(input.value).not.toContain("e");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.prompt_price).toBe(5e-7);
  });

  it("surfaces a server error on the row it failed for", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => prices })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: { message: "Server rejected", code: "ERR" } }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PriceEditor byModel={[]} />, { wrapper: wrapper() });
    await screen.findByLabelText("completion_price for m1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Server rejected")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks Save and makes inputs read-only when the prices query errored", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: "nope", code: "ERR" } }) }));
    render(<PriceEditor byModel={[{ model: "m1", tokens: 0, costCents: 0, costUsd: 0, avgLatencyMs: null, calls: 0, errorRate: 0 }]} />, { wrapper: wrapper() });
    const input = await screen.findByLabelText("prompt_price for m1");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(true));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
