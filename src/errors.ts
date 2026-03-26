// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

export class KinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KinError";
  }
}

export class BinaryNotFoundError extends KinError {
  constructor(path?: string) {
    super(
      path
        ? `Kin binary not found at: ${path}`
        : "Kin binary not found. Install kin or set kin.binaryPath in settings."
    );
    this.name = "BinaryNotFoundError";
  }
}

export class TimeoutError extends KinError {
  constructor(command: string, timeoutMs: number) {
    super(
      `Kin command timed out after ${timeoutMs}ms: ${command}`
    );
    this.name = "TimeoutError";
  }
}

export class ParseError extends KinError {
  constructor(command: string, raw: string, cause?: Error) {
    super(
      `Failed to parse JSON response from kin ${command}: ${cause?.message ?? "invalid JSON"}`
    );
    this.name = "ParseError";
    if (cause) {
      this.cause = cause;
    }
  }
}
