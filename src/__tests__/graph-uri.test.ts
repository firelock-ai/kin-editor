// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  buildEntityUriParts,
  displaySegment,
  extensionForLanguage,
  parseEntityUriParts,
} from "../graph-uri";

describe("the kin:// URI shape", () => {
  it("addresses an entity by its graph id and shows its kind and name", () => {
    const parts = buildEntityUriParts({
      workspaceKey: "abc123",
      entityId: "6b1d5f2a-6d3c-4c6a-9a1f-0a2f5c4b7e10",
      kind: "Method",
      name: "KinClient::entitySource",
      language: "rust",
    });

    expect(parts.authority).toBe("abc123");
    expect(parts.path).toBe("/Method/KinClient::entitySource.rs");
    expect(parts.query).toBe("id=6b1d5f2a-6d3c-4c6a-9a1f-0a2f5c4b7e10");
  });

  it("resolves through the id alone, not through the displayed path", () => {
    // The entity was renamed after the tab was opened, so the path says one
    // thing and the graph another. The id is what answers.
    const address = parseEntityUriParts({
      authority: "abc123",
      path: "/Method/theOldName.rs",
      query: "id=6b1d5f2a-6d3c-4c6a-9a1f-0a2f5c4b7e10",
    });

    expect(address?.entityId).toBe("6b1d5f2a-6d3c-4c6a-9a1f-0a2f5c4b7e10");
    expect(address?.workspaceKey).toBe("abc123");
    expect(address?.displayName).toBe("theOldName");
  });

  it("refuses a URI that carries no entity id rather than guessing one", () => {
    // The failure this guards: reading the path segments back as a name and
    // looking the entity up by it, which is a file lookup wearing a scheme.
    expect(
      parseEntityUriParts({
        authority: "abc123",
        path: "/Method/KinClient::entitySource.rs",
        query: "",
      })
    ).toBeUndefined();
    expect(
      parseEntityUriParts({
        authority: "abc123",
        path: "/Method/x.rs",
        query: "kind=Method&name=x",
      })
    ).toBeUndefined();
  });

  it("round-trips an id that needs escaping", () => {
    const parts = buildEntityUriParts({
      workspaceKey: "k",
      entityId: "id with spaces & symbols",
      kind: "Function",
      name: "f",
    });
    expect(parts.query).toBe("id=id%20with%20spaces%20%26%20symbols");
    expect(parseEntityUriParts(parts)?.entityId).toBe("id with spaces & symbols");
  });

  it("keeps a name with a separator inside one path segment", () => {
    // A `/` in a display segment would otherwise mint a path segment nobody
    // asked for, and the last one is what the editor tab shows.
    const parts = buildEntityUriParts({
      workspaceKey: "k",
      entityId: "i",
      kind: "Module",
      name: "app/routes",
    });
    expect(parts.path).toBe("/Module/app·routes");
    expect(parts.path.split("/").filter(Boolean)).toHaveLength(2);
  });

  it("names an empty display segment rather than emitting an empty one", () => {
    expect(displaySegment("   ")).toBe("(unnamed)");
    expect(displaySegment("Vec<T>")).toBe("Vec<T>");
  });

  it("maps a known language to its extension and gives an unknown one none", () => {
    expect(extensionForLanguage("rust")).toBe(".rs");
    expect(extensionForLanguage("TypeScript")).toBe(".ts");
    // A guessed extension would make the editor assert a syntax the body does
    // not have, which reads as broken highlighting rather than as an unknown
    // language.
    expect(extensionForLanguage("brainfuck")).toBe("");
    expect(extensionForLanguage(undefined)).toBe("");
  });

  it("leaves a display name alone when it has no known extension to strip", () => {
    const address = parseEntityUriParts({
      authority: "k",
      path: "/Function/handler",
      query: "id=x",
    });
    expect(address?.displayName).toBe("handler");
    expect(address?.displayKind).toBe("Function");
  });
});
