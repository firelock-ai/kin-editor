// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { join } from "path";

class FakeFileSystemError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}

jest.mock(
  "vscode",
  () => {
    class EventEmitter {
      private handlers: Array<(value: unknown) => void> = [];
      event = (handler: (value: unknown) => void) => {
        this.handlers.push(handler);
        return { dispose: () => undefined };
      };
      fire = (value: unknown) => {
        for (const handler of this.handlers) {
          handler(value);
        }
      };
      dispose = () => undefined;
    }

    class Disposable {
      constructor(public callOnDispose: () => void) {}
      dispose() {
        this.callOnDispose();
      }
    }

    class Range {
      constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number
      ) {}
    }

    class Diagnostic {
      source: string | undefined;
      code: string | undefined;
      constructor(
        public range: Range,
        public message: string,
        public severity: number
      ) {}
    }

    const stringifyUri = (parts: {
      authority: string;
      path: string;
      query: string;
    }) =>
      `kin://${parts.authority}${parts.path}${parts.query ? `?${parts.query}` : ""}`;

    const makeUri = (parts: {
      scheme?: string;
      authority: string;
      path: string;
      query?: string;
    }) => ({
      scheme: parts.scheme ?? "kin",
      authority: parts.authority,
      path: parts.path,
      query: parts.query ?? "",
      toString: () =>
        stringifyUri({
          authority: parts.authority,
          path: parts.path,
          query: parts.query ?? "",
        }),
    });

    return {
      EventEmitter,
      Disposable,
      Range,
      Diagnostic,
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
      FileType: { Unknown: 0, File: 1, Directory: 2 },
      FileChangeType: { Changed: 0, Created: 1, Deleted: 2 },
      FilePermission: { Readonly: 1 },
      FileSystemError: {
        FileNotFound: (detail: unknown) =>
          new FakeFileSystemError("FileNotFound", String(detail)),
        FileNotADirectory: (detail: unknown) =>
          new FakeFileSystemError("FileNotADirectory", String(detail)),
        NoPermissions: (detail: unknown) =>
          new FakeFileSystemError("NoPermissions", String(detail)),
        Unavailable: (detail: unknown) =>
          new FakeFileSystemError("Unavailable", String(detail)),
      },
      Uri: {
        from: makeUri,
        parse: (value: string) => {
          const [head, query = ""] = value.split("?");
          const withoutScheme = head.replace(/^kin:\/\//, "");
          const slash = withoutScheme.indexOf("/");
          return makeUri({
            authority: withoutScheme.slice(0, slash),
            path: withoutScheme.slice(slash),
            query,
          });
        },
        file: (fsPath: string) => ({ fsPath }),
      },
      languages: {
        createDiagnosticCollection: () => ({
          set: jest.fn(),
          delete: jest.fn(),
          clear: jest.fn(),
          dispose: jest.fn(),
        }),
      },
      window: { createOutputChannel: () => ({ appendLine: jest.fn() }) },
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
    };
  },
  { virtual: true }
);

import * as vscode from "vscode";
import {
  KinEntityFileSystemProvider,
  WRITE_PATH_REFUSAL,
  entityUri,
  renderEntityContent,
  workspaceKeyFor,
} from "../entity-viewer";
import { GraphDiagnostics } from "../graph-diagnostics";
import { TRUNCATION_MARKER, readEntitySource } from "../graph-entity";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "mcp", "entity-source.json"), "utf8")
) as { payload: Record<string, unknown> };

const ENTITY_ID = String(fixture.payload.id);
const WORKSPACE = "/repo";
const KEY = workspaceKeyFor(WORKSPACE);

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    entitySource: jest.fn().mockResolvedValue({
      document: readEntitySource(JSON.stringify(fixture.payload)),
      findings: [],
    }),
    entityRelations: jest.fn().mockResolvedValue({
      neighborhood: { truncated: false, relations: [] },
      findings: [],
    }),
    graphStatusFindings: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function makeProvider(client: ReturnType<typeof makeClient>) {
  const collection = {
    set: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
  };
  const diagnostics = new GraphDiagnostics(collection as any);
  const provider = new KinEntityFileSystemProvider(diagnostics);
  provider.setWorkspaces([
    { key: KEY, workspacePath: WORKSPACE, client },
  ]);
  return { provider, collection };
}

const uri = () =>
  entityUri({
    workspaceKey: KEY,
    entityId: ENTITY_ID,
    kind: "Method",
    name: "KinClient::entitySource",
    language: "rust",
  });

describe("the kin:// entity document", () => {
  it("serves the entity's body from the graph, byte for byte", async () => {
    const client = makeClient();
    const { provider } = makeProvider(client);

    const bytes = await provider.readFile(uri());

    expect(Buffer.from(bytes).toString("utf8")).toBe(fixture.payload.body);
    expect(client.entitySource).toHaveBeenCalledWith(ENTITY_ID);
  });

  it("appends nothing to a body the daemon did not cut", () => {
    const document = readEntitySource(JSON.stringify(fixture.payload));
    expect(renderEntityContent(document)).toBe(document.body);
  });

  it("shows the truncation and the remedy when the daemon did cut one", () => {
    // The failure this guards: a clipped body rendered as the entity's source,
    // which reads as a complete function that simply ends early.
    const document = readEntitySource(
      JSON.stringify({
        ...fixture.payload,
        body: `fn head() {\n${TRUNCATION_MARKER}`,
      })
    );
    const content = renderEntityContent(document);

    expect(content).toContain("fn head() {");
    expect(content).toContain("TRUNCATED");
    expect(content).toContain("kin_artifact_read");
  });

  it("reports the document as readonly and sized to what it served", async () => {
    const { provider } = makeProvider(makeClient());

    const stat = await provider.stat(uri());

    expect(stat.type).toBe(vscode.FileType.File);
    expect(stat.permissions).toBe(vscode.FilePermission.Readonly);
    expect(stat.size).toBe(Buffer.byteLength(String(fixture.payload.body)));
  });

  it("reads each entity once for the stat and read pair the editor makes", async () => {
    const client = makeClient();
    const { provider } = makeProvider(client);

    await provider.stat(uri());
    await provider.readFile(uri());

    expect(client.entitySource).toHaveBeenCalledTimes(1);
  });

  it("publishes the daemon's findings on the document", async () => {
    const client = makeClient({
      entitySource: jest.fn().mockResolvedValue({
        document: readEntitySource(JSON.stringify(fixture.payload)),
        findings: [
          {
            code: "degraded.enrichment_shortfall",
            severity: "warning" as const,
            message: "the sweep did not finish",
          },
        ],
      }),
      graphStatusFindings: jest.fn().mockResolvedValue([
        {
          code: "graph_status.completion_unattested",
          severity: "info" as const,
          message: "no attestation",
        },
      ]),
    });
    const { provider, collection } = makeProvider(client);

    await provider.readFile(uri());

    expect(collection.set).toHaveBeenCalledTimes(1);
    const [, diagnostics] = collection.set.mock.calls[0];
    expect(diagnostics.map((d: vscode.Diagnostic) => d.code).sort()).toEqual([
      "degraded.enrichment_shortfall",
      "graph_status.completion_unattested",
    ]);
    expect(diagnostics[0].source).toBe("kin");
    expect(diagnostics[0].severity).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it("still serves the body when the relations read fails, and says so", async () => {
    const client = makeClient({
      entityRelations: jest.fn().mockRejectedValue(new Error("timed out")),
    });
    const { provider } = makeProvider(client);

    await provider.readFile(uri());

    // An absent neighborhood is what the hover renders as "the read did not
    // answer" rather than as "no relations".
    expect(provider.viewFor(uri())?.neighborhood).toBeUndefined();
    expect(provider.viewFor(uri())?.document.body).toBe(fixture.payload.body);
  });

  it("refuses rather than reading a file when the graph cannot answer", async () => {
    // The whole point of the scheme: there is no fallback to open the file
    // with, because a file read here would be indistinguishable from a working
    // viewer while showing bytes graph truth never served.
    const client = makeClient({
      entitySource: jest
        .fn()
        .mockRejectedValue(new Error("Entity not found: dead-id")),
    });
    const { provider } = makeProvider(client);

    await expect(provider.readFile(uri())).rejects.toThrow(
      "Entity not found: dead-id"
    );
  });

  it("refuses a URI with no entity id", async () => {
    const { provider } = makeProvider(makeClient());
    const bare = vscode.Uri.from({
      scheme: "kin",
      authority: KEY,
      path: "/Method/x.rs",
      query: "",
    });

    await expect(provider.readFile(bare)).rejects.toMatchObject({
      code: "FileNotFound",
    });
  });

  it("refuses an entity whose workspace is no longer open", async () => {
    const { provider } = makeProvider(makeClient());
    provider.setWorkspaces([]);

    await expect(provider.readFile(uri())).rejects.toThrow(
      "no longer open"
    );
  });

  it("refuses every write with the reason, not with a bare permission error", async () => {
    const { provider } = makeProvider(makeClient());

    for (const attempt of [
      () => provider.writeFile(uri()),
      () => provider.delete(uri()),
      () => provider.rename(uri()),
    ]) {
      expect(attempt).toThrow(WRITE_PATH_REFUSAL.slice(0, 48));
    }
    expect(WRITE_PATH_REFUSAL).toContain("entity-shaped write to the graph");
  });

  it("is not a directory tree", () => {
    const { provider } = makeProvider(makeClient());
    expect(() => provider.readDirectory(uri())).toThrow();
  });
});

describe("invalidating open entity documents", () => {
  it("re-reads after the graph changes rather than serving the old body", async () => {
    const client = makeClient();
    const { provider } = makeProvider(client);
    const changed: unknown[] = [];
    provider.onDidChangeFile((events) => changed.push(events));

    await provider.readFile(uri());
    provider.invalidateAll();
    await provider.readFile(uri());

    expect(changed).toHaveLength(1);
    // A second read is the point: without it the tab keeps showing a body the
    // graph may no longer hold.
    expect(client.entitySource).toHaveBeenCalledTimes(2);
  });

  it("fires nothing when no entity document is open", () => {
    const { provider } = makeProvider(makeClient());
    const changed: unknown[] = [];
    provider.onDidChangeFile((events) => changed.push(events));

    provider.invalidateAll();

    expect(changed).toHaveLength(0);
  });
});

describe("workspace keys", () => {
  it("are stable for a path and different between paths", () => {
    expect(workspaceKeyFor("/repo")).toBe(workspaceKeyFor("/repo"));
    expect(workspaceKeyFor("/repo")).not.toBe(workspaceKeyFor("/other"));
    expect(workspaceKeyFor("/repo")).toMatch(/^[0-9a-f]{16}$/);
  });
});
