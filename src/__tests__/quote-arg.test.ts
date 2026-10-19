// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// "Run kin doctor --fix" types the binary path into the integrated terminal, so
// the path has to reach the shell intact. The POSIX cases run the quoted text
// through a real `sh` and compare what it prints with the input.

import { execFileSync } from "child_process";
import { quoteArg } from "../setup-panel";

jest.mock("vscode", () => ({}), { virtual: true });

function throughShell(arg: string): string {
  return execFileSync("/bin/sh", ["-c", `printf '%s' ${quoteArg(arg, "linux")}`], {
    encoding: "utf8",
  });
}

describe("quoteArg", () => {
  it("leaves a path with only safe characters bare", () => {
    expect(quoteArg("/Users/dev/.kin/bin/kin", "darwin")).toBe("/Users/dev/.kin/bin/kin");
    expect(quoteArg("kin", "linux")).toBe("kin");
  });

  it("single-quotes a POSIX path with spaces", () => {
    expect(quoteArg("/Users/Jane Doe/.kin/bin/kin", "darwin")).toBe(
      "'/Users/Jane Doe/.kin/bin/kin'"
    );
  });

  it("double-quotes a Windows path with spaces and keeps its backslashes", () => {
    expect(quoteArg("C:\\Program Files\\Kin\\kin.exe", "win32")).toBe(
      '"C:\\Program Files\\Kin\\kin.exe"'
    );
    expect(quoteArg("C:\\kin\\kin.exe", "win32")).toBe("C:\\kin\\kin.exe");
  });
});

(process.platform === "win32" ? describe.skip : describe)("quoteArg through sh", () => {
  it.each([
    "/Users/Jane Doe/.kin/bin/kin",
    "/tmp/back\\slash dir/kin",
    "/tmp/trailing backslash\\",
    '/tmp/say "hi"/kin',
    "/tmp/it's here/kin",
    "/tmp/$HOME/`id`/$(id)/kin",
    "/tmp/a;b&c|d>e/kin",
    "/tmp/!bang/*/kin",
    "",
  ])("hands %p back unchanged", (arg) => {
    expect(throughShell(arg)).toBe(arg);
  });
});
