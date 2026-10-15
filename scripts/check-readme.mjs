// Type-check every ```ts block in README.md against the built package, so the examples cannot rot.
// A block may fail only when the README shows its error: the ```text block right after it must
// contain the message tsc prints. Run after `npm run build`.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
// Names a block may use from the text around it.
const STUBS = {
  signingSecret: "declare const signingSecret: string;",
  pngBytes: "declare const pngBytes: Uint8Array;",
  app: "declare const app: { post(path: string, handler: (req: { body: { prompt: string } }, res: { json(body: unknown): void }) => Promise<void>): void };",
  job: 'declare const job: import("@sume-com/open").Job;',
  run: 'import { run } from "@sume-com/open";',
};

const dir = mkdtempSync(join(tmpdir(), "sume-js-readme-"));
mkdirSync(join(dir, "node_modules", "@sume-com"), { recursive: true });
symlinkSync(root, join(dir, "node_modules", "@sume-com", "open"), "dir");
writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [join(root, "node_modules", "@types")],
    },
    include: ["*.ts"],
  }),
);

const shown = new Map();
const fence = /```(\w+)\n([\s\S]*?)```/gu;
const blocks = [...readme.matchAll(fence)];
let count = 0;
for (const [i, [, lang, code]] of blocks.entries()) {
  if (lang !== "ts") continue;
  const prelude = Object.entries(STUBS)
    .filter(([name]) => new RegExp(`\\b${name}\\b`, "u").test(code))
    .filter(
      ([name]) => !new RegExp(`(const|let|function)\\s+${name}\\b|import\\s*\\{[^}]*\\b${name}\\b`, "u").test(code),
    )
    .map(([, stub]) => stub);
  const file = `block${String(count++).padStart(2, "0")}.ts`;
  writeFileSync(join(dir, file), `${prelude.join("\n")}\n${code}\nexport {};\n`);
  const next = blocks[i + 1];
  if (next?.[1] === "text") shown.set(file, next[2]);
}

let output = "";
try {
  execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
} catch (error) {
  output = String(error.stdout ?? "");
}
const unexpected = output
  .split("\n")
  .filter((line) => /^block\d+\.ts\(/u.test(line))
  .filter((line) => {
    const [, file, message] = /^(block\d+\.ts)\(\d+,\d+\): (error TS\d+: .*)$/u.exec(line) ?? [];
    return !(file && message && shown.get(file)?.includes(message));
  });
if (unexpected.length > 0) {
  console.error(`README.md examples do not type-check (files in ${dir}):\n${unexpected.join("\n")}`);
  process.exit(1);
}
console.log(`README.md: ${count} TypeScript examples type-check; shown errors match tsc.`);
