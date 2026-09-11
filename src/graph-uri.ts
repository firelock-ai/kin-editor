// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// The `kin://` URI shape, kept free of `vscode` so it can be asserted directly.
//
// An entity is addressed by its graph id and nothing else. The path segments
// carry the kind and the name so the editor tab, the breadcrumb and the window
// title read as an entity rather than as a file, but they are DISPLAY ONLY and
// nothing resolves through them: a renamed entity keeps answering on the same
// URI, and a name carrying a path separator is made safe for a segment without
// anyone having to parse it back.
//
// That split is the founder's "entities never paths" ruling made mechanical. A
// reader that resolved through the path would be a file lookup wearing a scheme,
// which is the drift the umbrella's zero-file-search rule exists to stop.

/** The URI scheme the entity viewer registers. */
export const KIN_SCHEME = "kin";

/** The query parameter carrying the graph entity id. The only resolution key. */
export const ENTITY_ID_PARAM = "id";

/** Everything needed to build a `kin://` URI for one entity. */
export interface EntityLocator {
  /** Stable key for the workspace folder whose graph holds the entity. */
  workspaceKey: string;
  /** The graph entity id. The one field resolution reads. */
  entityId: string;
  /** Entity kind, for display. */
  kind: string;
  /** Entity name, for display. */
  name: string;
  /** Kin language id, used only to pick a syntax-highlighting extension. */
  language?: string;
}

/** What a `kin://` URI resolves to: an id, plus what its path was displaying. */
export interface EntityAddress {
  workspaceKey: string;
  entityId: string;
  /** The kind the URI was built with. Display only; may be stale. */
  displayKind?: string;
  /** The name the URI was built with. Display only; may be stale. */
  displayName?: string;
}

/** The pieces of a URI this module builds and reads, free of any URI class. */
export interface UriParts {
  authority: string;
  path: string;
  query: string;
}

/**
 * Kin language id to file extension, so VS Code picks a tokenizer for the
 * document without the extension having to own a language-id mapping.
 *
 * Keys are the lowercase spellings `kin_model::ids::LanguageId` renders
 * (`typescript`, `rust`, `cpp`, `csharp`, …). A language absent here gets no
 * extension rather than a guessed one: plain text is a correct rendering of an
 * unknown language, and a wrong extension makes the editor assert a syntax the
 * body does not have.
 */
const EXTENSION_BY_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: ".ts",
  javascript: ".js",
  python: ".py",
  go: ".go",
  java: ".java",
  rust: ".rs",
  c: ".c",
  cpp: ".cpp",
  csharp: ".cs",
  ruby: ".rb",
  php: ".php",
  swift: ".swift",
  kotlin: ".kt",
  hcl: ".tf",
};

/** The extension for a Kin language id, or "" when there is no known one. */
export function extensionForLanguage(language?: string): string {
  if (!language) {
    return "";
  }
  return EXTENSION_BY_LANGUAGE[language.toLowerCase()] ?? "";
}

/**
 * Make one display segment safe to sit between path separators.
 *
 * Lossy on purpose, and safe to be lossy because nothing reads it back. A
 * generic name like `Vec<T>` and a Rust path like `a::b` survive intact; a
 * separator inside a name becomes a middle dot so the URI keeps the two
 * segments the caller asked for.
 */
export function displaySegment(value: string): string {
  const collapsed = value.replace(/[\\/]/g, "·").replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : "(unnamed)";
}

/** Build the parts of the `kin://` URI addressing one entity. */
export function buildEntityUriParts(locator: EntityLocator): UriParts {
  const extension = extensionForLanguage(locator.language);
  return {
    authority: locator.workspaceKey,
    path: `/${displaySegment(locator.kind)}/${displaySegment(locator.name)}${extension}`,
    query: `${ENTITY_ID_PARAM}=${encodeURIComponent(locator.entityId)}`,
  };
}

/**
 * Read a `kin://` URI back to the entity it addresses.
 *
 * Returns `undefined` when the URI carries no entity id, which is the only
 * refusal this needs: a URI without one addresses no entity, and guessing one
 * from the path is exactly the file lookup this scheme exists to avoid.
 */
export function parseEntityUriParts(parts: UriParts): EntityAddress | undefined {
  const entityId = readQueryParam(parts.query, ENTITY_ID_PARAM);
  if (!entityId) {
    return undefined;
  }
  const segments = parts.path.split("/").filter((segment) => segment.length > 0);
  const address: EntityAddress = {
    workspaceKey: parts.authority,
    entityId,
  };
  if (segments.length >= 2) {
    address.displayKind = segments[0];
    address.displayName = stripKnownExtension(segments[segments.length - 1]);
  }
  return address;
}

/**
 * Read one parameter out of a query string.
 *
 * Hand-rolled rather than routed through `URLSearchParams` because a VS Code
 * `Uri.query` is already the decoded query for some producers and the raw one
 * for others, and this only ever has to read the one key this module writes.
 */
function readQueryParam(query: string, key: string): string | undefined {
  for (const pair of query.split("&")) {
    if (pair.length === 0) {
      continue;
    }
    const separator = pair.indexOf("=");
    const name = separator === -1 ? pair : pair.slice(0, separator);
    if (name !== key) {
      continue;
    }
    const raw = separator === -1 ? "" : pair.slice(separator + 1);
    const value = safeDecode(raw);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not a reason to lose the id; the caller compares it
    // against the graph, which refuses an id the graph does not hold.
    return value;
  }
}

function stripKnownExtension(segment: string): string {
  for (const extension of Object.values(EXTENSION_BY_LANGUAGE)) {
    if (segment.length > extension.length && segment.endsWith(extension)) {
      return segment.slice(0, -extension.length);
    }
  }
  return segment;
}
