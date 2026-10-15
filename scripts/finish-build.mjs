// After tsc: mark the CommonJS build as CommonJS, and write the browser stub.
import { readFileSync, writeFileSync } from "node:fs";

writeFileSync("dist/cjs/package.json", `${JSON.stringify({ type: "commonjs" })}\n`);

// The stub has every name the real entry exports, so a browser bundle links,
// then throws the explanation (not "does not provide an export named …").
const names = Object.keys(await import(new URL("../dist/esm/index.js", import.meta.url).href)).sort();
const message = readFileSync("src/browser.ts", "utf8")
  .replace(/^\/\/.*\n/gmu, "")
  .trim();
writeFileSync("dist/browser.js", `${message}\nexport const ${names.map((n) => `${n} = undefined`).join(", ")};\n`);
writeFileSync("dist/browser.d.ts", `export * from "./esm/index.js";\n`);
console.log(`built dist/esm, dist/cjs, dist/browser.js (${names.length} names)`);
