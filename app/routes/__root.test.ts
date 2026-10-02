import { describe, expect, test } from "vitest";
import { Route } from "./__root";

describe("root document head", () => {
  test("declares the SVG favicon", () => {
    const head = Route.options.head?.({} as never) as {
      links?: Array<Record<string, unknown>>;
    };
    expect(head.links).toContainEqual({
      rel: "icon",
      type: "image/svg+xml",
      href: "/favicon.svg",
    });
  });
});
