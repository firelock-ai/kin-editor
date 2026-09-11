#!/usr/bin/env python3
"""Falsify every behaviour the entity viewer's tests guard.

A test that cannot fail is not evidence. This breaks one behaviour at a time,
runs the suite that guards it, and records whether the suite went red. A
mutation that leaves the suite green names a test that asserts nothing.

Restoration is by writing the original bytes back, never by `git checkout --`,
which restores HEAD and would delete an uncommitted file outright. The run
refuses to start on a dirty tree and asserts the tree is clean at the end, so a
mutation can never be left behind.

Usage: python3 scripts/falsify-entity-viewer.py
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Mutation:
    """One break, the suite that must catch it, and what it is testing."""

    name: str
    path: str
    old: str
    new: str
    suite: str
    guards: str


MUTATIONS: list[Mutation] = [
    Mutation(
        name="a cut body reads as whole",
        path="src/graph-entity.ts",
        old="return body.trimEnd().endsWith(TRUNCATION_MARKER);",
        new="return false;",
        suite="src/__tests__/graph-entity.test.ts",
        guards="the daemon's truncation marker is detected",
    ),
    Mutation(
        name="a URI with no id resolves off its path",
        path="src/graph-uri.ts",
        old="  if (!entityId) {\n    return undefined;\n  }",
        new="  if (!entityId) {\n    return { workspaceKey: parts.authority, entityId: parts.path };\n  }",
        suite="src/__tests__/graph-uri.test.ts",
        guards="an entity is addressed by its graph id and never by its path",
    ),
    Mutation(
        name="every name is its own namespace",
        path="src/graph-entity.ts",
        old="  const namespace = name.slice(0, index);\n  return namespace.length > 0 ? namespace : undefined;",
        new="  return name;",
        suite="src/__tests__/graph-entity.test.ts",
        guards="namespaces come from the graph's qualified name",
    ),
    Mutation(
        name="an observed-false degraded flag becomes a finding",
        path="src/graph-findings.ts",
        old="    if (value !== true) {\n      continue;\n    }",
        new="    if (value === undefined) {\n      continue;\n    }",
        suite="src/__tests__/graph-findings.test.ts",
        guards="only an affirmative degraded flag is raised",
    ),
    Mutation(
        name="an unmeasured parse side reads as zero",
        path="src/graph-findings.ts",
        old="    const parsedCalls = num(resolution.parsed_call_sites);\n    const resolvedCalls = num(resolution.resolved_call_edges);",
        new="    const parsedCalls = num(resolution.parsed_call_sites) ?? 0;\n    const resolvedCalls = num(resolution.resolved_call_edges) ?? 0;",
        suite="src/__tests__/graph-findings.test.ts",
        guards="an unmeasured count is not published as a measured zero",
    ),
    Mutation(
        name="an incoming edge joins to its own destination",
        path="src/graph-relations.ts",
        old='      const far = direction === "outgoing" ? entry.dst : entry.src;',
        new="      const far = entry.dst;",
        suite="src/__tests__/graph-relations.test.ts",
        guards="a caller is read off the edge's source, not its destination",
    ),
    Mutation(
        name="a failed relations read renders as no relations",
        path="src/entity-hover.ts",
        old="  const neighborhood = view.neighborhood;\n  if (!neighborhood) {",
        new="  const neighborhood = view.neighborhood ?? { truncated: false, relations: [] };\n  if (false) {",
        suite="src/__tests__/entity-hover.test.ts",
        guards="a read that did not answer is not rendered as an absence",
    ),
    Mutation(
        name="a save is accepted silently",
        path="src/entity-viewer.ts",
        old="  writeFile(uri: vscode.Uri): void {\n    throw refuseWrite(uri);\n  }",
        new="  writeFile(_uri: vscode.Uri): void {\n    return;\n  }",
        suite="src/__tests__/entity-viewer.test.ts",
        guards="the provider refuses a write and says why",
    ),
    Mutation(
        name="a graph failure becomes an empty document",
        path="src/entity-viewer.ts",
        old="      throw vscode.FileSystemError.Unavailable(\n        err instanceof Error ? err.message : String(err)\n      );",
        new='      source = { document: { entityId: "", name: "", kind: "", body: "", truncated: false, provenance: {} }, findings: [] };',
        suite="src/__tests__/entity-viewer.test.ts",
        guards="the viewer refuses rather than serving something the graph did not",
    ),
    Mutation(
        name="a tree row carries its file again",
        path="src/graph-browser.ts",
        old="    item.command = {\n      command: OPEN_ENTITY_COMMAND,",
        new='    item.resourceUri = vscode.Uri.file(entity.file);\n    item.command = {\n      command: OPEN_ENTITY_COMMAND,',
        suite="src/__tests__/graph-browser.test.ts",
        guards="a graph row is not decorated as a file",
    ),
    Mutation(
        name="graph findings wear the review source",
        path="src/graph-diagnostics.ts",
        old='  diagnostic.source = "kin";',
        new='  diagnostic.source = "kin-review";',
        suite="src/__tests__/entity-viewer.test.ts",
        guards="graph disclosures are distinguishable from review findings",
    ),
    Mutation(
        name="the entity id is dropped from a search answer",
        path="src/cli-contract.ts",
        old="    ...(raw.id ? { id: String(raw.id) } : {}),",
        new="",
        suite="src/__tests__/cli-contract.test.ts",
        guards="the graph id the CLI publishes survives normalisation",
    ),
]


def run(cmd: list[str]) -> int:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True).returncode


def tree_is_clean() -> bool:
    result = subprocess.run(
        ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True
    )
    return result.stdout.strip() == ""


def main() -> int:
    if not tree_is_clean():
        print("refusing to run: the worktree has uncommitted changes")
        return 2

    baseline = run(["npx", "jest", "--silent"])
    if baseline != 0:
        print("refusing to run: the suite is not green before any mutation")
        return 2
    print(f"baseline: the whole suite is green ({len(MUTATIONS)} mutations to apply)\n")

    survivors: list[str] = []
    for mutation in MUTATIONS:
        target = ROOT / mutation.path
        original = target.read_text()
        if mutation.old not in original:
            print(f"SKIP {mutation.name}: anchor not found in {mutation.path}")
            survivors.append(f"{mutation.name} (anchor not found)")
            continue
        if original.count(mutation.old) != 1:
            print(f"SKIP {mutation.name}: anchor is not unique in {mutation.path}")
            survivors.append(f"{mutation.name} (anchor not unique)")
            continue

        target.write_text(original.replace(mutation.old, mutation.new, 1))
        try:
            code = run(["npx", "jest", "--silent", mutation.suite])
        finally:
            target.write_text(original)

        verdict = "CAUGHT" if code != 0 else "SURVIVED"
        print(f"{verdict:9} {mutation.name}")
        print(f"          guards: {mutation.guards}")
        print(f"          suite:  {mutation.suite}\n")
        if code == 0:
            survivors.append(mutation.name)

    if not tree_is_clean():
        print("ERROR: the worktree is dirty after restoring; inspect it by hand")
        return 3

    after = run(["npx", "jest", "--silent"])
    if after != 0:
        print("ERROR: the suite is not green after restoring")
        return 3

    if survivors:
        print(f"{len(survivors)} mutation(s) survived:")
        for name in survivors:
            print(f"  - {name}")
        return 1

    print(f"all {len(MUTATIONS)} mutations were caught; tree clean and suite green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
