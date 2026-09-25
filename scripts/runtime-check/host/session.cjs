// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

"use strict";

// Runs inside the extension host of a real VS Code. It drives the installed
// kin-editor through the commands, views and kin:// documents a person uses,
// and writes what happened to host-result.json after every step.
//
// It never fails the VS Code process on a product failure. Each step is graded
// here and the result file is read by run.mjs, so a step that fails or hangs
// still leaves evidence and the steps after it still run. The observers below
// only record calls into the extension's own compiled modules; they return the
// original result untouched and never replace behavior.

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const EXTENSION_ID = "firelock.kin-editor";

const input = JSON.parse(
  fs.readFileSync(process.env.KIN_RUNTIME_CHECK_INPUT, "utf8")
);
const resultPath = path.join(input.phaseDir, "host-result.json");
const started = Date.now();

const report = {
  phase: input.phase,
  vscode: {
    version: vscode.version,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    platform: process.platform,
    arch: process.arch,
  },
  extension: null,
  steps: [],
  observers: [],
  outputs: {},
};

const restorers = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function write() {
  report.elapsedMs = Date.now() - started;
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
}

function describe(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

class NotShipped extends Error {}
class Skipped extends Error {}

/**
 * One graded step. A step that throws NotShipped or Skipped is recorded with
 * that status rather than as a failure, and a step that outlives its timeout is
 * recorded as failed while the steps after it go on. A timeout does not cancel
 * the underlying operation.
 */
async function step(name, timeoutMs, action) {
  const entry = { name, status: "running", startedMs: Date.now() - started };
  report.steps.push(entry);
  write();
  let timer;
  try {
    const detail = await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`did not finish within ${timeoutMs} ms`)),
          timeoutMs
        );
      }),
    ]);
    entry.status = "passed";
    entry.detail = detail ?? null;
  } catch (error) {
    if (error instanceof NotShipped) {
      entry.status = "not_shipped";
      entry.detail = error.message;
    } else if (error instanceof Skipped) {
      entry.status = "skipped";
      entry.detail = error.message;
    } else {
      entry.status = "failed";
      entry.error = describe(error);
    }
  } finally {
    clearTimeout(timer);
    entry.durationMs = Date.now() - started - entry.startedMs;
    write();
  }
  return entry.status === "passed";
}

function passed(name) {
  return report.steps.some((entry) => entry.name === name && entry.status === "passed");
}

function requirePassed(...names) {
  const missing = names.filter((name) => !passed(name));
  if (missing.length > 0) {
    throw new Skipped(`needs ${missing.join(", ")}, which did not pass`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function until(description, timeoutMs, probe, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${description}${last ? `: ${describe(last)}` : ""}`);
}

/**
 * Record every call to one method of a class the extension's compiled code
 * exports. Requiring the module by its absolute path returns the instance the
 * extension already loaded, so the observer sees the extension's own calls.
 */
function observe(extensionPath, file, className, method, sink) {
  const label = `${className}.${method}`;
  let loaded;
  try {
    loaded = require(path.join(extensionPath, "out", file));
  } catch (error) {
    report.observers.push({ label, installed: false, reason: describe(error) });
    return false;
  }
  const cls = loaded?.[className];
  if (typeof cls !== "function" || typeof cls.prototype?.[method] !== "function") {
    report.observers.push({ label, installed: false, reason: `out/${file} exports no ${label}` });
    return false;
  }
  const original = cls.prototype[method];
  cls.prototype[method] = function observed(...args) {
    const result = original.apply(this, args);
    try {
      sink({ self: this, args, result });
    } catch {
      // Evidence only. A failing observer never changes the product call.
    }
    return result;
  };
  restorers.push(() => {
    cls.prototype[method] = original;
  });
  report.observers.push({ label, installed: true });
  return true;
}

function isName(entityName, wanted) {
  return (
    entityName === wanted ||
    entityName.endsWith(`.${wanted}`) ||
    entityName.endsWith(`::${wanted}`)
  );
}

/** Walk a tree provider the way the view expands it and return its entity rows. */
async function walk(provider) {
  const entities = [];
  const infos = [];
  let frontier = await provider.getChildren();
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next = [];
    for (const node of frontier) {
      if (node.type === "entity") entities.push(node);
      else if (node.type === "info") infos.push(node.message);
      else next.push(...(await provider.getChildren(node)));
    }
    frontier = next;
  }
  return { entities, infos };
}

/** The tree rows a view asked for, as VS Code rendered them, not as the harness walks them. */
function treeRecorder() {
  const rendered = [];
  let harnessWalking = 0;
  return {
    rendered,
    sink({ self, args, result }) {
      if (args[0] !== undefined || harnessWalking > 0) return;
      Promise.resolve(result).then(
        (nodes) =>
          rendered.push({
            at: Date.now() - started,
            self,
            types: nodes.map((node) => node.type),
            infos: nodes.filter((node) => node.type === "info").map((node) => node.message),
          }),
        (error) => rendered.push({ at: Date.now() - started, self, error: describe(error) })
      );
    },
    async walk(provider) {
      harnessWalking++;
      try {
        return await walk(provider);
      } finally {
        harnessWalking--;
      }
    },
  };
}

/** Wait until the view renders graph rows rather than a loading or failure notice. */
async function waitForRows(label, recorder, timeoutMs) {
  let lastRefresh = Date.now();
  return until(
    `${label} rendered no graph rows (last root: ${JSON.stringify(
      recorder.rendered.at(-1)?.infos ?? recorder.rendered.at(-1)?.error ?? "none"
    )})`,
    timeoutMs,
    async () => {
      const loaded = recorder.rendered.find(
        (root) => root.types && root.types.length > 0 && !root.types.includes("info")
      );
      if (loaded) return loaded;
      // A warming daemon answers with a notice first. The extension refreshes
      // its trees when MCP connects; this only shortens the wait.
      if (Date.now() - lastRefresh > 5000) {
        lastRefresh = Date.now();
        await vscode.commands.executeCommand("kin.refresh");
      }
      return undefined;
    }
  );
}

function entitySummary(nodes) {
  return nodes.map((node) => ({
    name: node.entity.name,
    kind: node.entity.kind,
    id: node.entity.id ?? null,
  }));
}

function queryParam(uri, key) {
  return new URLSearchParams(decodeURIComponent(uri.query)).get(key);
}

function freshSourceUri(sourceUri, entityId) {
  return vscode.Uri.from({
    scheme: "kin",
    authority: sourceUri.authority,
    path: sourceUri.path,
    query: `id=${encodeURIComponent(entityId)}&read=${crypto.randomUUID()}`,
  });
}

async function readFresh(sourceUri, entityId) {
  const document = await vscode.workspace.openTextDocument(freshSourceUri(sourceUri, entityId));
  return document.getText();
}

function sameBody(left, right) {
  return left.replace(/\s+$/, "") === right.replace(/\s+$/, "");
}

exports.run = async function run() {
  const fixture = input.fixture;
  const state = { extension: undefined };
  const graphRecorder = treeRecorder();
  const explorerRecorder = treeRecorder();
  const traceCalls = [];
  const applyCalls = [];

  try {
    await step("extension_installed", 30_000, async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert(extension, `${EXTENSION_ID} is not installed in this VS Code`);
      const installedFromDir = path.relative(input.extensionsDir, extension.extensionPath);
      assert(
        installedFromDir && !installedFromDir.startsWith("..") && !path.isAbsolute(installedFromDir),
        `${EXTENSION_ID} was loaded from ${extension.extensionPath}, not from the installed extensions directory`
      );
      const packageJSON = extension.packageJSON;
      report.extension = {
        id: EXTENSION_ID,
        version: packageJSON.version,
        extensionPath: extension.extensionPath,
        commands: (packageJSON.contributes?.commands ?? []).map((entry) => entry.command),
        views: packageJSON.contributes?.views ?? null,
      };
      if (input.expectedExtensionVersion) {
        assert(
          packageJSON.version === input.expectedExtensionVersion,
          `installed ${packageJSON.version}, expected ${input.expectedExtensionVersion}`
        );
      }
      state.extension = extension;
      return { version: packageJSON.version, extensionPath: extension.extensionPath };
    });

    await step("extension_activated", 60_000, async () => {
      requirePassed("extension_installed");
      const extension = state.extension;
      const out = extension.extensionPath;
      observe(out, "graph-browser.js", "GraphBrowserProvider", "getChildren", graphRecorder.sink);
      observe(out, "entity-explorer.js", "EntityExplorerProvider", "getChildren", explorerRecorder.sink);
      observe(out, "kin-client.js", "KinClient", "trace", ({ args, result }) => {
        const call = { entity: args[0] };
        traceCalls.push(call);
        Promise.resolve(result).then(
          (entities) => {
            call.results = entities.map((entity) => ({
              name: entity.name,
              kind: entity.kind,
              file: entity.file,
              line: entity.line,
            }));
          },
          (error) => {
            call.error = describe(error);
          }
        );
      });
      observe(out, "entity-viewer.js", "KinEntityFileSystemProvider", "applyDraft", ({ result }) => {
        const call = {};
        applyCalls.push(call);
        Promise.resolve(result).then(
          (applied) => {
            call.result = {
              applied_draft_revision: applied?.applied_draft_revision ?? null,
              current_text_applied: applied?.current_text_applied ?? null,
              has_receipt: !!applied?.draft?.applied_receipt,
            };
          },
          (error) => {
            call.error = describe(error);
          }
        );
      });
      await extension.activate();
      assert(extension.isActive, "the extension did not report itself active");
      return { observers: report.observers };
    });

    await step("graph_browser_loads", 120_000, async () => {
      requirePassed("extension_activated");
      await vscode.commands.executeCommand("workbench.view.extension.kin");
      await vscode.commands.executeCommand("kinGraph.focus");
      const root = await waitForRows("Graph Browser", graphRecorder, 110_000);
      const { entities, infos } = await graphRecorder.walk(root.self);
      const names = entities.map((node) => node.entity.name);
      for (const wanted of fixture.names) {
        assert(
          names.some((name) => isName(name, wanted)),
          `Graph Browser rows lack ${wanted}: ${JSON.stringify(names)}`
        );
      }
      state.graphBrowser = root.self;
      state.graphEntities = entities;
      report.outputs.graphBrowser = { rootTypes: root.types, entities: entitySummary(entities), infos };
      return { rows: entities.length, rootTypes: root.types, names };
    });

    if (input.phase === "first") {
      await step("entity_explorer_loads", 90_000, async () => {
        requirePassed("extension_activated");
        const config = vscode.workspace.getConfiguration("kin");
        await config.update("entityViewer", false, vscode.ConfigurationTarget.Global);
        try {
          await vscode.commands.executeCommand("workbench.view.extension.kin");
          await until("the Entity Explorer view never became focusable", 20_000, async () => {
            await vscode.commands.executeCommand("kinExplorer.focus");
            return true;
          });
          const root = await waitForRows("Entity Explorer", explorerRecorder, 60_000);
          const { entities } = await explorerRecorder.walk(root.self);
          const names = entities.map((node) => node.entity.name);
          for (const wanted of fixture.names) {
            assert(
              names.some((name) => isName(name, wanted)),
              `Entity Explorer rows lack ${wanted}: ${JSON.stringify(names)}`
            );
          }
          report.outputs.entityExplorer = { rootTypes: root.types, entities: entitySummary(entities) };
          return { rows: entities.length, rootTypes: root.types };
        } finally {
          await config.update("entityViewer", true, vscode.ConfigurationTarget.Global);
          await vscode.commands.executeCommand("kinGraph.focus").then(undefined, () => undefined);
        }
      });
    }

    await step("kin_document_opens", 60_000, async () => {
      requirePassed("graph_browser_loads");
      const node = state.graphEntities.find((candidate) => isName(candidate.entity.name, fixture.target));
      assert(node, `no Graph Browser row for ${fixture.target}`);
      const item = state.graphBrowser.getTreeItem(node);
      assert(item.command?.command === "kin.openEntity", `the ${fixture.target} row runs ${item.command?.command ?? "no command"}`);
      // The same command and arguments a click on the row sends.
      await vscode.commands.executeCommand(item.command.command, ...(item.command.arguments ?? []));
      const document = await until("clicking the row opened no kin:// document", 30_000, () => {
        const active = vscode.window.activeTextEditor?.document;
        return active?.uri.scheme === "kin" && queryParam(active.uri, "id") ? active : undefined;
      });
      const text = document.getText();
      const expected = input.phase === "first" ? input.source.body : input.previous.expectedBody;
      assert(
        sameBody(text, expected),
        `the kin:// document reads ${JSON.stringify(text)}, the daemon holds ${JSON.stringify(expected)}`
      );
      state.sourceDocument = document;
      state.entityId = queryParam(document.uri, "id");
      report.outputs.sourceDocument = { uri: document.uri.toString(), entityId: state.entityId, text };
      return { uri: document.uri.toString(), matchesDaemon: true };
    });

    if (input.phase === "first") {
      await step("trace_entity", 90_000, async () => {
        requirePassed("extension_activated");
        const file = vscode.Uri.file(path.join(input.repo, fixture.file));
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const callSite = document.getText().indexOf(fixture.traceCallSite);
        assert(callSite >= 0, `${fixture.file} has no ${fixture.traceCallSite}`);
        const cursor = document.positionAt(callSite + 1);
        editor.selection = new vscode.Selection(cursor, cursor);
        const before = traceCalls.length;
        let settled = false;
        let failure;
        vscode.commands.executeCommand("kin.trace").then(
          () => {
            settled = true;
          },
          (error) => {
            settled = true;
            failure = error;
          }
        );
        // Enter on the input box (prefilled with the word under the cursor),
        // then Enter on the first result, the way a keyboard user runs it.
        await until("Trace Entity never settled", 75_000, async () => {
          if (settled) return true;
          await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
          return false;
        }, 400);
        if (failure) throw failure;
        const call = traceCalls.slice(before).at(-1);
        assert(call, "Trace Entity never asked Kin to trace anything");
        assert(call.entity === fixture.target, `Trace Entity traced ${JSON.stringify(call.entity)}, not the word under the cursor`);
        await until("the trace result never arrived", 10_000, () => call.results || call.error);
        assert(!call.error, `Kin trace failed: ${call.error}`);
        assert(call.results.length > 0, "Kin trace returned no related entities");
        assert(
          call.results.some((result) => fixture.names.some((name) => isName(result.name, name))),
          `trace results name none of the fixture's entities: ${JSON.stringify(call.results)}`
        );
        const first = call.results[0];
        const active = vscode.window.activeTextEditor;
        assert(active, "picking a trace result opened no editor");
        const expectedFile = path.isAbsolute(first.file) ? first.file : path.join(input.repo, first.file);
        assert(
          fs.realpathSync(active.document.uri.fsPath) === fs.realpathSync(expectedFile),
          `picking the first result opened ${active.document.uri.fsPath}, expected ${expectedFile}`
        );
        assert(
          active.selection.active.line === first.line - 1,
          `picking the first result put the cursor on line ${active.selection.active.line + 1}, expected ${first.line}`
        );
        report.outputs.trace = call;
        return { traced: call.entity, results: call.results.length, opened: `${first.file}:${first.line}` };
      });

      await step("draft_save_and_apply", 120_000, async () => {
        const contributed = new Set(report.extension?.commands ?? []);
        const missing = ["kin.editEntity", "kin.applyDraft"].filter((command) => !contributed.has(command));
        if (missing.length > 0) {
          throw new NotShipped(
            `this extension build contributes no ${missing.join(" or ")}, so kin:// documents are read-only here`
          );
        }
        requirePassed("kin_document_opens");
        await vscode.window.showTextDocument(state.sourceDocument, { preview: false });
        await vscode.commands.executeCommand("kin.editEntity");
        const draft = await until("Edit Entity opened no durable draft", 45_000, () => {
          const active = vscode.window.activeTextEditor?.document;
          return active?.uri.scheme === "kin" && queryParam(active.uri, "draft") ? active : undefined;
        });
        const original = draft.getText();
        assert(sameBody(original, input.source.body), `the new draft starts from ${JSON.stringify(original)}`);
        const edited = original.replace(fixture.editFrom, fixture.editTo);
        assert(edited !== original, `the draft has no ${fixture.editFrom} to change`);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(draft.uri, new vscode.Range(draft.positionAt(0), draft.positionAt(original.length)), edited);
        assert(await vscode.workspace.applyEdit(edit), "the edit was not applied to the draft buffer");
        assert(await draft.save(), "Save was not acknowledged");
        assert(!draft.isDirty, "the draft is still dirty after Save");
        const before = applyCalls.length;
        await vscode.commands.executeCommand("kin.applyDraft");
        const call = applyCalls.slice(before).at(-1);
        if (call) {
          await until("Apply never settled", 30_000, () => call.result || call.error);
          assert(!call.error, `Apply failed: ${call.error}`);
          assert(call.result.current_text_applied === true, `Apply did not cover the saved text: ${JSON.stringify(call.result)}`);
          assert(call.result.has_receipt, "Apply returned no receipt");
        }
        state.draftUri = draft.uri.toString();
        state.editedBody = edited;
        report.outputs.draft = { uri: state.draftUri, editedBody: edited, apply: call?.result ?? null };
        return { draft: queryParam(draft.uri, "draft"), apply: call?.result ?? "applyDraft observer unavailable" };
      });

      await step("readback_after_apply", 60_000, async () => {
        requirePassed("draft_save_and_apply");
        const text = await until("a fresh kin:// read never showed the applied body", 45_000, async () => {
          const current = await readFresh(state.sourceDocument.uri, state.entityId);
          return sameBody(current, state.editedBody) ? current : undefined;
        }, 500);
        report.outputs.readback = { text };
        return { body: text };
      });

      await step("working_copy_projection", 60_000, async () => {
        requirePassed("readback_after_apply");
        const file = path.join(input.repo, fixture.file);
        const text = await until(`${fixture.file} on disk never showed the applied body`, 45_000, () => {
          const current = fs.readFileSync(file, "utf8");
          return current.includes(fixture.editTo) && !current.includes(fixture.editFrom) ? current : undefined;
        }, 500);
        return { file: fixture.file, containsEdit: true, bytes: Buffer.byteLength(text) };
      });
    } else {
      await step("draft_survives_restart", 60_000, async () => {
        if (!input.previous.draftUri) {
          throw new NotShipped("the first session saved no draft, so there is none to reopen");
        }
        const uri = vscode.Uri.parse(input.previous.draftUri);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        assert(
          sameBody(document.getText(), input.previous.editedBody),
          `the reopened draft reads ${JSON.stringify(document.getText())}`
        );
        return { uri: input.previous.draftUri, body: document.getText() };
      });
    }
  } catch (error) {
    report.fatal = describe(error);
  } finally {
    for (const restore of restorers.reverse()) {
      try {
        restore();
      } catch {
        // The host is about to exit; a failed restore changes no evidence.
      }
    }
    report.state = {
      entityId: state.entityId ?? null,
      draftUri: state.draftUri ?? null,
      editedBody: state.editedBody ?? null,
    };
    report.finished = true;
    write();
  }
};
