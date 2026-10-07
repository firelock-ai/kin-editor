// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";

jest.mock(
  "vscode",
  () => ({
    workspace: {
      getConfiguration: () => ({
        get: () => "",
      }),
    },
  }),
  { virtual: true }
);
jest.mock("child_process");
jest.mock("fs");

import { folderHasKinStore } from "../store-discovery";

const mockedExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockedRealpathSync = realpathSync as unknown as jest.MockedFunction<(path: string) => string>;
const mockedExecFileSync = execFileSync as unknown as jest.MockedFunction<
  (file: string, args: string[], options: object) => string
>;

function answer(workingDir: string): string {
  return JSON.stringify({
    schema: "kin.store-path.v1",
    working_dir: workingDir,
    store: "/stores/repo",
    external: true,
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockedRealpathSync.mockImplementation((path: string) => path);
});

test("a folder with its own .kin is served without asking kin", () => {
  mockedExistsSync.mockImplementation((path) => String(path) === "/work/repo/.kin");
  expect(folderHasKinStore("/work/repo")).toBe(true);
  expect(mockedExecFileSync).not.toHaveBeenCalled();
});

test("a folder whose store is kept outside it is served", () => {
  mockedExistsSync.mockReturnValue(false);
  mockedExecFileSync.mockReturnValue(answer("/work/repo"));
  expect(folderHasKinStore("/work/repo")).toBe(true);
  const [, args] = mockedExecFileSync.mock.calls[0];
  expect(args).toEqual(["store", "path", "--json", "/work/repo"]);
});

test("a store serving an enclosing folder does not serve this one", () => {
  mockedExistsSync.mockReturnValue(false);
  mockedExecFileSync.mockReturnValue(answer("/work"));
  expect(folderHasKinStore("/work/repo")).toBe(false);
});

test("no store, no kin, or an unreadable answer serves nothing", () => {
  mockedExistsSync.mockReturnValue(false);
  mockedExecFileSync.mockImplementation(() => {
    throw new Error("not a Kin repository");
  });
  expect(folderHasKinStore("/work/repo")).toBe(false);
  mockedExecFileSync.mockReset();
  mockedExecFileSync.mockReturnValue("not json");
  expect(folderHasKinStore("/work/repo")).toBe(false);
});
