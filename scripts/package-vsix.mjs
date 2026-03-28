import { readFile } from "node:fs/promises";
import { createVSIX } from "@vscode/vsce";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
const tagName = (process.env.TAG_NAME || process.env.GITHUB_REF_NAME || "").trim();

if (!tagName) {
  throw new Error("TAG_NAME or GITHUB_REF_NAME is required");
}

if (!tagName.startsWith("v")) {
  throw new Error(`Release tag must start with 'v' (got: ${tagName})`);
}

const version = tagName.slice(1);
if (packageJson.version !== version) {
  throw new Error(
    `package.json version ${packageJson.version} does not match release tag ${version}`,
  );
}

const packagePath = (process.env.VSIX_PATH || `kin-${version}.vsix`).trim();
const preRelease = version.includes("-");

await createVSIX({
  packagePath,
  preRelease,
});

console.log(`Packaged ${packagePath}`);
