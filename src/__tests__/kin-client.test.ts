// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync } from "fs";
import { BinaryNotFoundError, ParseError, TimeoutError } from "../errors";

// Mock vscode module (not available outside VS Code host)
jest.mock(
  "vscode",
  () => ({
    workspace: {
      getConfiguration: () => ({
        get: () => "",
      }),
    },
    window: {
      withProgress: (_opts: unknown, task: () => Promise<unknown>) => task(),
    },
    ProgressLocation: {
      Notification: 15,
    },
  }),
  { virtual: true }
);

jest.mock("child_process");
jest.mock("fs");
jest.mock("../logger", () => ({
  log: jest.fn(),
  logError: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;

// Import after mocks are set up
import { KinClient } from "../kin-client";

describe("KinClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no configured binary, no ~/.kin/bin/kin, fall back to "kin" in PATH
    mockExistsSync.mockReturnValue(false);
  });

  describe("binary path resolution", () => {
    it("falls back to 'kin' when no binary found at known paths", () => {
      mockExistsSync.mockReturnValue(false);
      const client = new KinClient("/workspace");
      expect(client.isAvailable()).toBe(true);
    });

    it("uses ~/.kin/bin/kin when it exists", () => {
      mockExistsSync.mockImplementation((p: string) =>
        p.includes(".kin/bin/kin")
      );
      const client = new KinClient("/workspace");
      expect(client.isAvailable()).toBe(true);
    });
  });

  describe("runJson — JSON parse error handling", () => {
    it("throws ParseError on invalid JSON output", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, "not valid json {{{", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("test")).rejects.toThrow(ParseError);
    });

    it("includes command name in ParseError message", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, "<html>not json</html>", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("query")).rejects.toThrow(
        /Failed to parse JSON response from kin search/
      );
    });

    it("parses valid JSON correctly", async () => {
      const entities = [
        { kind: "Function", name: "foo", file: "test.ts", line: 1 },
      ];
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, JSON.stringify(entities), "");
        }
      );

      const client = new KinClient("/workspace");
      const result = await client.search("foo");
      expect(result).toEqual(entities);
    });

    it("passes relative paths to kin review --files", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, JSON.stringify({ file: "src/demo.ts", findings: [], summary: "ok" }), "");
        }
      );

      const client = new KinClient("/workspace");
      await client.review("/workspace/src/demo.ts");

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.anything(),
        ["review", "--files", "src/demo.ts", "--json"],
        expect.objectContaining({ cwd: "/workspace" }),
        expect.any(Function)
      );
    });

    it("passes relative paths to kin rename --file", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(
            null,
            JSON.stringify({
              entity: { name: "foo", kind: "Function", file: "src/demo.ts", line: 1 },
              newName: "bar",
              edits: [],
              warnings: [],
            }),
            ""
          );
        }
      );

      const client = new KinClient("/workspace");
      await client.renamePlan("foo", "bar", "/workspace/src/demo.ts", 9, 5);

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.anything(),
        ["rename", "foo", "bar", "--file", "src/demo.ts", "--line", "9", "--column", "5", "--json"],
        expect.objectContaining({ cwd: "/workspace" }),
        expect.any(Function)
      );
    });
  });

  describe("timeout behavior", () => {
    it("throws TimeoutError when command is killed by timeout", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const err = new Error("Command timed out") as Error & {
            killed: boolean;
            signal: string;
          };
          err.killed = true;
          err.signal = "SIGTERM";
          cb(err, "", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("slow")).rejects.toThrow(TimeoutError);
    });

    it("includes timeout duration in TimeoutError message", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const err = new Error("timed out") as Error & {
            killed: boolean;
            signal: string;
          };
          err.killed = true;
          err.signal = "SIGTERM";
          cb(err, "", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("slow")).rejects.toThrow(/15000ms/);
    });
  });

  describe("binary not found", () => {
    it("throws BinaryNotFoundError when binary does not exist (ENOENT)", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const err = new Error("spawn kin ENOENT") as Error & {
            code: string;
          };
          err.code = "ENOENT";
          cb(err, "", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("test")).rejects.toThrow(
        BinaryNotFoundError
      );
    });
  });

  describe("status fallback", () => {
    it("returns default status on error instead of throwing", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(new Error("repo not initialized"), "", "repo not initialized");
        }
      );

      const client = new KinClient("/workspace");
      const status = await client.status();
      expect(status).toEqual({
        initialized: false,
        entityCount: 0,
        graphState: "unknown",
      });
    });
  });
});
