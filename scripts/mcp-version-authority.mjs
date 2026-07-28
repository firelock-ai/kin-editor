// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// One structural authority for the initialize handshake fields that release
// verification reads and release preparation rewrites. The expression is
// intentionally strict and bounded: if the handshake is refactored, release
// automation fails closed instead of borrowing a same-named literal from
// elsewhere in the source file.
const HANDSHAKE_PATTERN = new RegExp(
  String.raw`(sendRequest\(\s*"initialize"\s*,\s*\{\s*protocolVersion:\s*")` +
    String.raw`([^"]+)` +
    String.raw`("\s*,\s*capabilities:\s*\{[^{}]*\}\s*,\s*clientInfo:\s*\{\s*name:\s*"kin-editor"\s*,\s*version:\s*")` +
    String.raw`([^"]+)` +
    String.raw`("\s*,?\s*\})`,
  "gm",
);

function uniqueHandshakeMatch(source) {
  const matches = [...source.matchAll(HANDSHAKE_PATTERN)];
  return matches.length === 1 ? matches[0] : null;
}

export function extractMcpHandshake(source) {
  const match = uniqueHandshakeMatch(source);
  return {
    protocolVersion: match?.[2] ?? null,
    clientVersion: match?.[4] ?? null,
  };
}

export function replaceMcpClientVersion(source, expected, next) {
  const match = uniqueHandshakeMatch(source);
  if (!match) {
    throw new Error(
      "could not locate exactly one structurally valid Kin Editor initialize handshake",
    );
  }
  if (match[4] !== expected) {
    throw new Error(
      `MCP client version ${match[4]} does not match package version ${expected}`,
    );
  }

  const relativeStart =
    match[1].length + match[2].length + match[3].length;
  const start = match.index + relativeStart;
  const end = start + match[4].length;
  return `${source.slice(0, start)}${next}${source.slice(end)}`;
}
