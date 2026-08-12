// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Every contribution declared in package.json must be backed by real code.
//
// A declared-but-unimplemented contribution is invisible in review and loud in
// use: the palette lists the command, the settings UI lists the setting, and
// only the user finds out nothing is behind it. These assertions read the
// manifest and the extension sources together so the manifest can never drift
// ahead of the implementation again.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..");

interface Manifest {
  icon: string;
  contributes: {
    viewsContainers: Record<string, Array<{ icon: string }>>;
    commands: Array<{ command: string }>;
    views: Record<string, Array<{ id: string }>>;
    menus: Record<string, Array<{ command: string }>>;
    keybindings: Array<{ command: string }>;
    configuration: { properties: Record<string, unknown> };
  };
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8")
);

function collectSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSources(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const sourceFiles = collectSources(join(repoRoot, "src"));
const source = sourceFiles
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("package.json contributions are implemented", () => {
  it("reads the extension sources it is asserting against", () => {
    // Without this, an empty read would make every assertion below vacuous.
    expect(sourceFiles.length).toBeGreaterThan(5);
    expect(source).toContain("registerCommand");
  });

  it("registers every contributed command", () => {
    const declared = manifest.contributes.commands.map((c) => c.command);
    expect(declared.length).toBeGreaterThan(0);

    const unregistered = declared.filter(
      (id) => !source.includes(`registerCommand("${id}"`)
    );
    expect(unregistered).toEqual([]);
  });

  it("fails when a command is declared with no registration", () => {
    // Falsification: the check above must be able to catch a fabricated id.
    expect(source.includes('registerCommand("kin.nothingImplementsThis"')).toBe(
      false
    );
  });

  it("provides a tree data provider for every contributed view", () => {
    const viewIds = Object.values(manifest.contributes.views).flatMap((views) =>
      views.map((v) => v.id)
    );
    expect(viewIds.length).toBeGreaterThan(0);

    const unprovided = viewIds.filter(
      (id) => !source.includes(`registerTreeDataProvider("${id}"`)
    );
    expect(unprovided).toEqual([]);
  });

  it("reads every contributed setting", () => {
    const settings = Object.keys(
      manifest.contributes.configuration.properties
    );
    expect(settings.length).toBeGreaterThan(0);

    const unread = settings.filter((key) => {
      const name = key.replace(/^kin\./, "");
      return !source.includes(`get<string>("${name}")`) &&
        !source.includes(`get<boolean>("${name}"`);
    });
    expect(unread).toEqual([]);
  });

  it("ships every icon the manifest points at", () => {
    const icons = [
      manifest.icon,
      ...Object.values(manifest.contributes.viewsContainers).flatMap(
        (containers) => containers.map((c) => c.icon)
      ),
    ];
    expect(icons.length).toBeGreaterThan(1);

    const missing = icons.filter((rel) => !existsSync(join(repoRoot, rel)));
    expect(missing).toEqual([]);
    expect(existsSync(join(repoRoot, "resources/no-such-icon.png"))).toBe(false);
  });

  it("points menus and keybindings at declared commands only", () => {
    const declared = new Set(
      manifest.contributes.commands.map((c) => c.command)
    );
    const referenced = [
      ...Object.values(manifest.contributes.menus).flatMap((items) =>
        items.map((i) => i.command)
      ),
      ...manifest.contributes.keybindings.map((k) => k.command),
    ];
    expect(referenced.length).toBeGreaterThan(0);

    const dangling = referenced.filter((id) => !declared.has(id));
    expect(dangling).toEqual([]);
  });
});
