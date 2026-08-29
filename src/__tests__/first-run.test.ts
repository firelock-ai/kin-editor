// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// FIR-2939, coldwalk 2026-08-28 finding 24: the extension shipped no first-run
// experience at all. `contributes.walkthroughs` was absent and
// `contributes.viewsWelcome` had zero entries, which are the two mechanisms an
// editor gives you for this, so a stranger who opened a folder with no `.kin`
// store got an empty panel, no explanation and no next step.
//
// These assertions read the manifest, the walkthrough media and the sources
// together. A contribution that names a command nothing registers, or a step
// that points at a file that does not ship, is invisible in review and only
// the user finds out.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  FIRST_RUN_ACTION,
  FIRST_RUN_OFFER,
  InitLine,
  WALKTHROUGH_ID,
  runKinInit,
  shouldOfferFirstRun,
  summarizeInit,
  walkthroughTarget,
} from "../first-run";

const repoRoot = resolve(__dirname, "..", "..");

interface Step {
  id: string;
  title: string;
  description: string;
  media: { markdown?: string; svg?: string; image?: unknown };
  completionEvents?: string[];
}

interface Manifest {
  name: string;
  publisher: string;
  contributes: {
    commands: Array<{ command: string }>;
    views: Record<string, Array<{ id: string }>>;
    viewsWelcome: Array<{ view: string; contents: string; when?: string }>;
    walkthroughs: Array<{
      id: string;
      title: string;
      description: string;
      steps: Step[];
    }>;
  };
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8")
);
const extensionSource = readFileSync(join(repoRoot, "src", "extension.ts"), "utf8");

const walkthrough = manifest.contributes.walkthroughs?.[0];
const declaredCommands = new Set(
  manifest.contributes.commands.map((c) => c.command)
);

/**
 * Commands a first-run surface may link that this extension does not own.
 *
 * Named one by one rather than allowed by prefix, so a typo in a built-in id
 * is still a failure and every exemption is a decision somebody made.
 */
const BUILT_IN_COMMANDS = new Set(["vscode.openFolder"]);

/** Every `command:<id>` link in the manifest's first-run surfaces. */
function commandLinks(): Array<{ where: string; command: string }> {
  const found: Array<{ where: string; command: string }> = [];
  const scan = (where: string, text: string): void => {
    for (const match of text.matchAll(/\(command:([^)\s]+)\)/g)) {
      found.push({ where, command: match[1] });
    }
  };
  for (const [i, block] of manifest.contributes.viewsWelcome.entries()) {
    scan(`viewsWelcome[${i}]`, block.contents);
  }
  for (const step of walkthrough.steps) {
    scan(`walkthrough step ${step.id}`, step.description);
  }
  return found;
}

describe("the manifest this suite reads is the one that ships", () => {
  // Without this, an empty or wrong-shaped read makes every assertion below
  // vacuous, and a green run would say nothing about the shipped extension.
  it("reads a manifest with contributions and an extension source beside it", () => {
    expect(manifest.contributes.commands.length).toBeGreaterThan(5);
    expect(extensionSource).toContain("registerCommand");
    expect(walkthrough).toBeDefined();
  });
});

describe("the extension contributes a first run", () => {
  it("ships a walkthrough", () => {
    expect(manifest.contributes.walkthroughs).toHaveLength(1);
    expect(walkthrough.steps.length).toBeGreaterThan(2);
  });

  it("ships welcome content on the entity explorer for a workspace with no graph", () => {
    const viewIds = Object.values(manifest.contributes.views).flatMap((views) =>
      views.map((v) => v.id)
    );
    const welcomed = manifest.contributes.viewsWelcome.filter((w) =>
      viewIds.includes(w.view)
    );
    expect(welcomed.length).toBeGreaterThan(0);

    // The state the coldwalk actually hit: a folder is open and it carries no
    // Kin store. A welcome block that only covered the no-folder case would
    // leave that panel exactly as empty as it was.
    const noGraph = welcomed.filter(
      (w) => w.when?.includes("!kin.initialized")
    );
    expect(noGraph).toHaveLength(1);
    expect(noGraph[0].when).toContain("workspaceFolderCount > 0");
  });

  it("covers the window with no folder open as well", () => {
    const noFolder = manifest.contributes.viewsWelcome.filter((w) =>
      w.when?.includes("workspaceFolderCount == 0")
    );
    expect(noFolder).toHaveLength(1);
  });

  it("sets the context key its welcome content keys on", () => {
    // The `when` clause is a claim about a context key. Nothing else makes
    // that key true, so a welcome block gated on one nobody sets renders
    // forever or never, and both look deliberate from the manifest alone.
    const keys = manifest.contributes.viewsWelcome
      .flatMap((w) => [...(w.when ?? "").matchAll(/kin\.[A-Za-z]+/g)])
      .map((m) => m[0]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of new Set(keys)) {
      expect(extensionSource).toContain(`"setContext", ${
        key === "kin.initialized" ? "CONTEXT_INITIALIZED" : key
      }`);
    }
  });
});

describe("every first-run link goes somewhere", () => {
  it("finds the links it is asserting about", () => {
    expect(commandLinks().length).toBeGreaterThan(3);
  });

  it("points every command link at a declared or named built-in command", () => {
    const dangling = commandLinks().filter(
      ({ command }) =>
        !declaredCommands.has(command) && !BUILT_IN_COMMANDS.has(command)
    );
    expect(dangling).toEqual([]);
  });

  it("registers every command a first-run link names", () => {
    const unregistered = commandLinks()
      .filter(({ command }) => declaredCommands.has(command))
      .filter(({ command }) => !extensionSource.includes(`registerCommand("${command}"`));
    expect(unregistered).toEqual([]);
  });

  it("would catch a link to a command that does not exist", () => {
    // Negative control for the two checks above. Built from a name the
    // manifest cannot contain, so it cannot pass by accident.
    expect(declaredCommands.has("kin.noSuchFirstRunCommand")).toBe(false);
    expect(BUILT_IN_COMMANDS.has("kin.noSuchFirstRunCommand")).toBe(false);
  });
});

describe("every walkthrough step ships the file it points at", () => {
  it("gives every step media that exists and says something", () => {
    for (const step of walkthrough.steps) {
      const rel = step.media.markdown ?? step.media.svg;
      expect(rel).toBeDefined();
      const full = join(repoRoot, rel as string);
      expect(existsSync(full)).toBe(true);
      expect(readFileSync(full, "utf8").trim().length).toBeGreaterThan(80);
    }
  });

  it("would catch a step pointing at a file that does not ship", () => {
    expect(existsSync(join(repoRoot, "resources/walkthrough/no-such-step.md"))).toBe(
      false
    );
  });

  it("addresses the walkthrough by the id the manifest declares", () => {
    // The id VS Code opens is `<publisher>.<name>#<walkthrough id>`, and the
    // publisher and name come from the running extension rather than from a
    // second copy written here. This asserts the join over the real values, so
    // renaming the walkthrough in the manifest fails here rather than shipping
    // a command that silently opens nothing.
    expect(WALKTHROUGH_ID).toBe(walkthrough.id);
    expect(walkthroughTarget(`${manifest.publisher}.${manifest.name}`)).toBe(
      `${manifest.publisher}.${manifest.name}#${walkthrough.id}`
    );
  });
});

describe("the first-run copy is the brand canon, verbatim", () => {
  // Locked lines from docs/brand (Brand Book, "The canon - locked lines"). A
  // surface needing a headline takes one of these and does not get a new one,
  // so an edit that writes a fresh headline here has to turn this red first.
  const NORTH_STAR = "Software that remembers itself.";
  const PRODUCT_PROMISE =
    "Git shows which lines changed. Kin shows what the change affects.";

  it("titles the walkthrough with the north-star line", () => {
    expect(walkthrough.title).toBe(NORTH_STAR);
    expect(walkthrough.description).toBe(PRODUCT_PROMISE);
  });

  it("opens the welcome view with the same two lines", () => {
    const noGraph = manifest.contributes.viewsWelcome.find((w) =>
      w.when?.includes("!kin.initialized")
    );
    expect(noGraph?.contents).toContain(NORTH_STAR);
    expect(noGraph?.contents).toContain(PRODUCT_PROMISE);
  });

  it("opens the one-time offer with the same two lines", () => {
    expect(FIRST_RUN_OFFER).toContain(NORTH_STAR);
    expect(FIRST_RUN_OFFER).toContain(PRODUCT_PROMISE);
  });

  it("carries no em dash on any first-run surface", () => {
    const surfaces = [
      walkthrough.title,
      walkthrough.description,
      FIRST_RUN_OFFER,
      FIRST_RUN_ACTION,
      ...manifest.contributes.viewsWelcome.map((w) => w.contents),
      ...walkthrough.steps.flatMap((s) => [s.title, s.description]),
      ...walkthrough.steps.map((s) =>
        readFileSync(join(repoRoot, s.media.markdown as string), "utf8")
      ),
    ];
    expect(surfaces.length).toBeGreaterThan(8);
    expect(surfaces.filter((text) => text.includes("—"))).toEqual([]);
  });
});

describe("the one-time offer", () => {
  const base = {
    hasWorkspaceFolder: true,
    kinFolderCount: 0,
    alreadyOffered: false,
  };

  it("offers when a folder is open and carries no graph", () => {
    expect(shouldOfferFirstRun(base)).toBe(true);
  });

  it("stays quiet once it has been offered", () => {
    expect(shouldOfferFirstRun({ ...base, alreadyOffered: true })).toBe(false);
  });

  it("stays quiet when the workspace already has a graph", () => {
    expect(shouldOfferFirstRun({ ...base, kinFolderCount: 1 })).toBe(false);
  });

  it("stays quiet when there is no folder to build a graph in", () => {
    expect(shouldOfferFirstRun({ ...base, hasWorkspaceFolder: false })).toBe(
      false
    );
  });
});

describe("kin init reports the CLI's own words", () => {
  const said = (stream: "stdout" | "stderr", text: string): InitLine => ({
    stream,
    text,
  });

  it("quotes the CLI's last line on success", () => {
    const summary = summarizeInit({
      ok: true,
      exitCode: 0,
      signal: null,
      lines: [said("stdout", "reading 41 files"), said("stdout", "graph ready: 812 entities")],
    });
    expect(summary.tone).toBe("info");
    expect(summary.message).toContain("graph ready: 812 entities");
  });

  it("quotes the CLI's own refusal rather than describing one", () => {
    // The extension does not know why an init refused. A sentence written here
    // would be a guess wearing the CLI's authority, which is exactly what the
    // old "Kin init failed" message was.
    const refusal = "error: a Kin store already exists at /repo/.kin";
    const summary = summarizeInit({
      ok: false,
      exitCode: 3,
      signal: null,
      lines: [said("stdout", "reading 41 files"), said("stderr", refusal)],
    });
    expect(summary.tone).toBe("error");
    expect(summary.message).toContain(refusal);
    expect(summary.message).toContain("exited 3");
  });

  it("says the CLI printed nothing rather than inventing a reason", () => {
    const summary = summarizeInit({
      ok: false,
      exitCode: 1,
      signal: null,
      lines: [],
    });
    expect(summary.message).toBe("kin init exited 1. It printed nothing.");
  });

  it("reports a signalled init as signalled", () => {
    const summary = summarizeInit({
      ok: false,
      exitCode: null,
      signal: "SIGKILL",
      lines: [],
    });
    expect(summary.message).toContain("stopped by SIGKILL");
  });
});

describe("kin init streams while it runs", () => {
  // Driven against a real process rather than a mock, because the thing under
  // test is that lines arrive as they are written rather than in one lump at
  // the end. A mocked child process would assert the mock.
  function fakeKin(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kin-editor-init-"));
    const path = join(dir, "kin");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("hands over each line as it arrives, tagged with its stream", async () => {
    const binary = fakeKin(
      [
        'test "$1" = "init" || { echo "wrong args: $*" 1>&2; exit 9; }',
        'echo "reading 41 files"',
        'echo "graph ready"',
      ].join("\n")
    );
    const seen: InitLine[] = [];
    const outcome = await runKinInit(binary, process.cwd(), (line) =>
      seen.push(line)
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(seen).toEqual([
      { stream: "stdout", text: "reading 41 files" },
      { stream: "stdout", text: "graph ready" },
    ]);
  });

  it("resolves a refusal as an outcome instead of rejecting", async () => {
    const binary = fakeKin(
      ['echo "error: store already exists" 1>&2', "exit 3"].join("\n")
    );
    const outcome = await runKinInit(binary, process.cwd(), () => undefined);
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.lines).toEqual([
      { stream: "stderr", text: "error: store already exists" },
    ]);
  });

  it("keeps a final line that arrived with no trailing newline", async () => {
    const binary = fakeKin('printf "no newline here"');
    const outcome = await runKinInit(binary, process.cwd(), () => undefined);
    expect(outcome.lines).toEqual([
      { stream: "stdout", text: "no newline here" },
    ]);
  });

  it("rejects when the binary is not there at all", async () => {
    await expect(
      runKinInit(
        join(tmpdir(), "kin-editor-no-such-binary"),
        process.cwd(),
        () => undefined
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
