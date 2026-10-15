// Pack the package, install the tarball in a clean project, and import it both ways.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sume-js-smoke-"));
const [{ filename }] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { encoding: "utf8" }),
);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", join(dir, filename)], {
  cwd: dir,
  stdio: "inherit",
});
const esm = `import { run, Sume, verifyWebhook, VERSION } from "@sume-com/open";
if (typeof run !== "function" || typeof verifyWebhook !== "function") throw new Error("missing exports");
console.log("esm", VERSION, new Sume().baseUrl);`;
const cjs = `const { run, Sume, VERSION } = require("@sume-com/open");
if (typeof run !== "function") throw new Error("missing exports");
console.log("cjs", VERSION, new Sume().baseUrl);`;
writeFileSync(join(dir, "esm.mjs"), esm);
writeFileSync(join(dir, "cjs.cjs"), cjs);
const env = { ...process.env, SUME_API_BASE_URL: "" };
execFileSync("node", ["esm.mjs"], { cwd: dir, stdio: "inherit", env });
execFileSync("node", ["cjs.cjs"], { cwd: dir, stdio: "inherit", env });
// The published types must stand alone: a TypeScript project without @types/node, checking every
// declaration file (as Next.js and Vite projects resolve them), sees the per-model types.
writeFileSync(
  join(dir, "consumer.ts"),
  `import { run } from "@sume-com/open";
export const ok = () => run("seedance-2-mini", "a paper boat", { duration: 5, resolution: "480p", maxUsd: 0.5 });
// @ts-expect-error a typo in a field name
export const typo = () => run("gpt-image-2", "a kite", { qualty: "low" });
`,
);
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2023", "DOM"],
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
    },
    include: ["consumer.ts"],
  }),
);
execFileSync(join(process.cwd(), "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
  cwd: dir,
  stdio: "inherit",
});
console.log("types: a project without @types/node type-checks, and the typo is caught");
// A browser bundle (the "browser" condition) must get the stub that refuses to load.
const browser = spawnSync("node", ["--conditions=browser", "esm.mjs"], { cwd: dir, encoding: "utf8", env });
if (browser.status === 0 || !browser.stderr.includes("runs on servers only")) {
  throw new Error(`the browser condition loaded the client:\n${browser.stderr}`);
}
console.log("browser condition: refused, as it should be");
console.log(`ok: ${filename}`);
