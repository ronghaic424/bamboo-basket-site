import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");

// 内联 <script> 也要过一遍语法检查：HTML 里的脚本是拼在模板字符串里的，
// 改动字符串拼接时容易漏掉 `+`，仅靠 ESM 解析发现不了。
const inlineScripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.ok(inlineScripts.length > 0, "expected at least one inline <script> block");
inlineScripts.forEach((code, index) => {
  assert.doesNotThrow(
    () => new vm.Script(code, { filename: `inline-script-${index + 1}.js` }),
    `inline script #${index + 1} has a syntax error`,
  );
});
console.log(`Inline scripts OK (${inlineScripts.length})`);
