// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  formatEntityAccessibilityLabel,
  formatEntityDescription,
  formatEntityTooltip,
  formatKindGroupAccessibilityLabel,
  formatKindGroupLabel,
  formatOverviewMessage,
  formatSearchResultDescription,
  formatSearchResultDetail,
  formatStatusBarText,
  formatStatusBarTooltip,
} from "../accessibility";

describe("accessibility strings", () => {
  const entity = {
    kind: "Function",
    name: "parseConfig",
    file: "src/config.ts",
    line: 42,
    signature: "fn parseConfig(path: &str) -> Config",
  };

  it("formats tree labels and screen-reader labels for kind groups", () => {
    expect(formatKindGroupLabel("Function", 3)).toBe("Function (3)");
    expect(formatKindGroupAccessibilityLabel("Function", 3)).toBe(
      "Function group with 3 entities"
    );
  });

  it("formats tree item descriptions and tooltips for entities", () => {
    expect(formatEntityDescription(entity)).toBe(
      "Function - src/config.ts:42"
    );
    expect(formatEntityTooltip(entity)).toBe(
      "fn parseConfig(path: &str) -> Config\nsrc/config.ts:42"
    );
    expect(formatEntityAccessibilityLabel(entity)).toBe(
      "Function parseConfig, src/config.ts line 42 fn parseConfig(path: &str) -> Config"
    );
  });

  it("formats quick-pick descriptions without icon syntax noise", () => {
    expect(formatSearchResultDescription(entity)).toBe(
      "Function - src/config.ts:42"
    );
    expect(formatSearchResultDetail(entity)).toBe(
      "fn parseConfig(path: &str) -> Config"
    );
  });

  it("formats status bar text and tooltip for initialized and unloaded states", () => {
    expect(
      formatStatusBarText({
        initialized: true,
        entityCount: 128,
        graphState: "ready",
      })
    ).toBe("$(graph) Kin: 128 entities");

    expect(
      formatStatusBarTooltip({
        initialized: true,
        entityCount: 128,
        graphState: "ready",
      })
    ).toContain("128 entities indexed");

    expect(
      formatStatusBarText({
        initialized: false,
        entityCount: 0,
        graphState: "unknown",
      })
    ).toBe("$(graph) Kin: not initialized");
  });

  it("formats overview messages consistently", () => {
    expect(
      formatOverviewMessage({
        entities: 10,
        edges: 7,
        files: 4,
        kinds: { Function: 6, Class: 4 },
      })
    ).toBe("Entities: 10 | Edges: 7 | Files: 4 | Kinds: Function(6), Class(4)");
  });
});
