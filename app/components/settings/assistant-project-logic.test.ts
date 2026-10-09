// PUT /assistant/settings/:projectId is a full-row upsert: the server nulls any
// omitted masked field. savePayload must therefore carry search/allowlist/
// images/effort/write-tools forward, overriding only the provider fields the
// form owns (provider/model/fallbacks + the vision agent model).
import { describe, it, expect } from "vitest";
import { savePayload } from "./assistant-project-logic";

describe("savePayload — full-row preservation", () => {
  it("preserves every persisted masked field while overriding the provider fields", () => {
    const payload = savePayload(
      {
        searchProvider: "exa",
        urlAllowlist: "https://docs.example",
        primarySupportsImages: true,
        reasoningEffort: "high",
        writeTools: ["create_task", "update_task"],
      },
      "prov-1",
      "model-1",
      ["model-2"],
      "vision-1",
    );
    expect(payload).toEqual({
      searchProvider: "exa",
      urlAllowlist: "https://docs.example",
      primarySupportsImages: true,
      visionModel: "vision-1",
      reasoningEffort: "high",
      writeTools: ["create_task", "update_task"],
      providerId: "prov-1",
      modelId: "model-1",
      fallbackModelIds: ["model-2"],
    });
  });

  it("settles absent settings to safe defaults (never undefined)", () => {
    expect(savePayload(null, "prov-1", "model-1", [], "")).toEqual({
      searchProvider: null,
      urlAllowlist: null,
      primarySupportsImages: false,
      visionModel: null,
      reasoningEffort: null,
      writeTools: [],
      providerId: "prov-1",
      modelId: "model-1",
      fallbackModelIds: [],
    });
  });

  it("maps an empty provider/model to null, not an empty string", () => {
    const payload = savePayload(undefined, "", "", [], "");
    expect(payload.providerId).toBeNull();
    expect(payload.modelId).toBeNull();
    expect(payload.visionModel).toBeNull();
  });
});
