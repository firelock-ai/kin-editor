// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// One vocabulary for the non-happy graph states, shared by every tree that has
// to render one.
//
// These sentences exist because an unreachable daemon, a drifted CLI, a warming
// graph and a genuinely empty one used to collapse into one blank panel. Two
// trees now show them, and a second copy of the wording is how the two would
// start disagreeing about what a state means.

import type { GraphAvailability } from "./kin-client";

/** What a tree shows in place of entities when the graph is not serving them. */
export interface GraphStateNotice {
  message: string;
  tooltip: string;
}

/**
 * The notice a graph availability earns, or `undefined` when the graph is
 * genuinely indexed and entities should be listed instead.
 */
export function graphStateNotice(
  availability: GraphAvailability
): GraphStateNotice | undefined {
  switch (availability) {
    case "warming":
      return {
        message: "Kin graph is starting up",
        tooltip:
          "The Kin daemon is still starting, so the graph has nothing to show yet. This is startup latency, not an empty graph. A large repository can take minutes on a cold start. Refresh once it is ready.",
      };
    case "contract-drift":
      return {
        message: "Kin CLI version mismatch",
        tooltip:
          "The kin CLI answered in a shape this extension cannot read. This is a version mismatch, not an empty graph. Update the Kin VS Code extension, or update the kin CLI, so the two agree, then refresh.",
      };
    case "not-indexed":
      return {
        message: "Graph not indexed yet",
        tooltip:
          "Kin has not indexed this workspace yet. Run Kin: Setup Workspace or wait for the daemon to finish indexing, then refresh.",
      };
    case "unavailable":
      return graphUnavailableNotice();
    case "invalid-response":
      return {
        message: "Kin graph returned an unreadable response",
        tooltip:
          "The Kin daemon replied with data the editor could not parse. This is a broken or still-starting daemon, not an empty graph. Check that the kin daemon is healthy, then refresh.",
      };
    case "empty":
      return graphEmptyNotice();
    case "indexed":
      return undefined;
    default:
      return undefined;
  }
}

export function graphEmptyNotice(): GraphStateNotice {
  return {
    message: "No entities found",
    tooltip:
      "The Kin graph is reachable but reported no entities yet. Indexing may still be in progress, so refresh to retry.",
  };
}

export function graphUnavailableNotice(): GraphStateNotice {
  return {
    message: "Kin graph unavailable",
    tooltip:
      "Could not reach the Kin graph. Check that the kin binary is installed and the daemon is running, then refresh.",
  };
}
