import { describe, expect, it } from "vitest";
import { playsFromToolEvent, type ToolEvent } from "./plays.ts";

const at = "2026-10-21T12:00:00.000Z";

function write(file_path: string, content: string): ToolEvent {
  return { tool_name: "Write", tool_input: { file_path, content }, session_id: "s1" };
}

function edit(file_path: string, old_string: string, new_string: string): ToolEvent {
  return { tool_name: "Edit", tool_input: { file_path, old_string, new_string }, session_id: "s1" };
}

function multiEdit(file_path: string, edits: { old_string: string; new_string: string }[]): ToolEvent {
  return { tool_name: "MultiEdit", tool_input: { file_path, edits }, session_id: "s1" };
}

function expectPlays(actual: unknown, plays: object[]) {
  expect(actual).toEqual(plays.map((p) => ({ kind: "import", ...p, session_id: "s1", at })));
}

describe("playsFromToolEvent: Write", () => {
  it.each([
    {
      name: "a default import counts the lines that use it",
      event: write("src/a.ts", 'import express from "express";\n\nconst app = express();\napp.listen(express.port);\n'),
      plays: [{ project: "express", lines_written: 2, file_ext: "ts" }],
    },
    {
      name: "named and aliased imports count their local names",
      event: write("src/form.tsx", 'import { z, ZodError as E } from "zod";\nconst s = z.string();\nif (e instanceof E) {}\nconsole.log(1);\n'),
      plays: [{ project: "zod", lines_written: 2, file_ext: "tsx" }],
    },
    {
      name: "a namespace import counts its namespace",
      event: write("a.js", 'import * as R from "ramda";\nR.map(f, xs);\n'),
      plays: [{ project: "ramda", lines_written: 1, file_ext: "js" }],
    },
    {
      name: "a scoped subpath import credits the scoped package",
      event: write("a.ts", 'import { zodResolver } from "@hookform/resolvers/zod";\nuseForm({ resolver: zodResolver(s) });\n'),
      plays: [{ project: "@hookform/resolvers", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "an unscoped subpath import credits the package",
      event: write("a.ts", 'import debounce from "lodash/debounce";\nconst f = debounce(g, 10);\n'),
      plays: [{ project: "lodash", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "each imported Project gets its own Play",
      event: write("a.ts", 'import a from "alpha";\nimport { b } from "beta";\na(b);\n'),
      plays: [
        { project: "alpha", lines_written: 1, file_ext: "ts" },
        { project: "beta", lines_written: 1, file_ext: "ts" },
      ],
    },
    {
      name: "an import that is never used still counts as a Play with 0 lines",
      event: write("a.ts", 'import "reflect-metadata";\n'),
      plays: [{ project: "reflect-metadata", lines_written: 0, file_ext: "ts" }],
    },
    {
      name: "relative imports, Node built-ins and node: modules are not Projects",
      event: write("a.ts", 'import x from "./x";\nimport y from "../y";\nimport fs from "fs";\nimport { join } from "node:path";\nimport { promises } from "fs/promises";\n'),
      plays: [],
    },
    {
      name: "a multi-line import counts only the lines after it that use it",
      event: write("a.ts", 'import {\n  z,\n  ZodError,\n} from "zod";\nconst s = z.string();\n'),
      plays: [{ project: "zod", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "commented-out imports and uses are not Plays",
      event: write("a.ts", '// import x from "foo";\n/* import y from "bar"; */\nimport z from "baz";\n// z is great\nz();\n'),
      plays: [{ project: "baz", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "a URL in a string is not mistaken for a comment",
      event: write("a.ts", 'import ky from "ky";\nky.get("https://example.com"); ky.post("x");\n'),
      plays: [{ project: "ky", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "a re-export credits the package",
      event: write("index.ts", 'export { Button } from "@radix-ui/react-button";\nexport * from "clsx";\n'),
      plays: [
        { project: "@radix-ui/react-button", lines_written: 0, file_ext: "ts" },
        { project: "clsx", lines_written: 0, file_ext: "ts" },
      ],
    },
    {
      name: "an export declaration before an import does not swallow it",
      event: write("a.ts", 'export function f() { return 1 }\nimport { g } from "gee";\ng();\n'),
      plays: [{ project: "gee", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "a file with no imports produces no Plays",
      event: write("README.md", "# Hello\n"),
      plays: [],
    },
  ])("$name", ({ event, plays }) => {
    expect(playsFromToolEvent(event, at)).toEqual(
      plays.map((p) => ({ kind: "import", ...p, session_id: "s1", at })),
    );
  });

  it.each([
    {
      name: "require binds a name whose uses are counted",
      event: write("a.js", 'const express = require("express");\nconst app = express();\napp.listen(3000);\n'),
      plays: [{ project: "express", lines_written: 1, file_ext: "js" }],
    },
    {
      name: "destructured require counts each local name",
      event: write("a.cjs", 'const { a, b: bee, c = 1, ...rest } = require("lib");\na();\nbee();\nc + 1;\nrest;\nb();\n'),
      plays: [{ project: "lib", lines_written: 4, file_ext: "cjs" }],
    },
    {
      name: "an inline require counts the line it is on",
      event: write("a.js", 'app.use(require("cors")());\napp.listen(1);\n'),
      plays: [{ project: "cors", lines_written: 1, file_ext: "js" }],
    },
    {
      name: "a dynamic import bound to a name counts its uses",
      event: write("a.ts", 'const { default: chalk } = await import("chalk");\nconsole.log(chalk.red("x"));\n'),
      plays: [{ project: "chalk", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "an inline dynamic import counts the line it is on",
      event: write("a.ts", 'const load = () => import("@scope/heavy/sub").then((m) => m.run());\n'),
      plays: [{ project: "@scope/heavy", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "TypeScript import-equals require counts its uses",
      event: write("a.ts", 'import fs2 = require("fs-extra");\nfs2.copy(a, b);\n'),
      plays: [{ project: "fs-extra", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "type-only imports credit the package",
      event: write("a.ts", 'import type { Request } from "express";\nimport { type ZodType, z } from "zod";\nexport type { Foo } from "foo";\nlet r: Request;\nlet t: ZodType;\n'),
      plays: [
        { project: "express", lines_written: 1, file_ext: "ts" },
        { project: "zod", lines_written: 1, file_ext: "ts" },
        { project: "foo", lines_written: 0, file_ext: "ts" },
      ],
    },
    {
      name: "require of relative paths and built-ins is not a Project",
      event: write("a.js", 'const x = require("./x");\nconst fs = require("fs");\nconst p = await import("node:path");\n'),
      plays: [],
    },
    {
      name: "a computed specifier names no Project and leaks no source text",
      event: write("a.js", 'const m = await import(`${base}/x`);\nrequire(`pkg-${name}`);\nrequire("Not A Package");\n'),
      plays: [],
    },
    {
      name: "a method that happens to be called require is not an import",
      event: write("a.js", 'loader.require("plugin");\n'),
      plays: [],
    },
  ])("require and import(): $name", ({ event, plays }) => {
    expectPlays(playsFromToolEvent(event, at), plays);
  });

  it("ignores tools other than Write, Edit and MultiEdit", () => {
    const event: ToolEvent = { tool_name: "Bash", tool_input: { command: "npm install zod" }, session_id: "s1" };
    expect(playsFromToolEvent(event, at)).toEqual([]);
  });

  it("never puts source text in a Play (ADR 0001)", () => {
    const secret = "const apiKey = 'sk-very-secret';";
    const event = write("src/secret.ts", `import axios from "axios";\n${secret}\naxios.get(apiKey);\n`);
    const out = JSON.stringify(playsFromToolEvent(event, at));
    expect(out).not.toContain("sk-very-secret");
    expect(out).not.toContain("apiKey");
    expect(out).not.toContain("src/secret");
  });
});

describe("playsFromToolEvent: Edit and MultiEdit", () => {
  const file = 'import { z } from "zod";\nimport ky from "ky";\n\nexport const s = z.string();\nexport const t = z.number();\n';

  it.each([
    {
      name: "new lines that use an import already at the top of the file count",
      event: edit("src/a.ts", "export const s = z.string();", "export const s = z.string().min(1);\nexport const u = z.boolean();"),
      plays: [{ project: "zod", lines_written: 2, file_ext: "ts" }],
    },
    {
      name: "lines kept unchanged from old_string are not counted",
      event: edit("src/a.ts", "export const s = z.string();\nexport const t = z.number();", "export const s = z.string();\nexport const t = z.number().int();"),
      plays: [{ project: "zod", lines_written: 1, file_ext: "ts" }],
    },
    {
      name: "re-indented lines are not new lines",
      event: edit("src/a.ts", "export const s = z.string();", "if (x) {\n  export const s = z.string();\n}"),
      plays: [],
    },
    {
      name: "an import the file has but the new lines do not use is not a Play",
      event: edit("src/a.ts", "const a = 1;", "const a = 2;"),
      plays: [],
    },
    {
      name: "an import added by the edit is a Play even before it is used",
      event: edit("src/a.ts", 'import ky from "ky";', 'import ky from "ky";\nimport "dotenv/config";'),
      plays: [{ project: "dotenv", lines_written: 0, file_ext: "ts" }],
    },
    {
      name: "commented-out uses in new lines are not counted",
      event: edit("src/a.ts", "x", "// z.string()\nky.get(u);"),
      plays: [{ project: "ky", lines_written: 1, file_ext: "ts" }],
    },
  ])("$name", ({ event, plays }) => {
    expectPlays(playsFromToolEvent(event, at, file), plays);
  });

  it("MultiEdit sums the new lines of every edit per Project", () => {
    const event = multiEdit("src/a.ts", [
      { old_string: "export const s = z.string();", new_string: "export const s = z.string().email();" },
      { old_string: "export const t = z.number();", new_string: "export const t = z.number();\nconst r = await ky.get(u);\nz.parse(r);" },
    ]);
    expectPlays(playsFromToolEvent(event, at, file), [
      { project: "zod", lines_written: 2, file_ext: "ts" },
      { project: "ky", lines_written: 1, file_ext: "ts" },
    ]);
  });

  it("without the file's contents, only imports in the edit itself are known", () => {
    const event = edit("src/a.ts", "x", 'import { z } from "zod";\nz.string();\nky.get(u);');
    expectPlays(playsFromToolEvent(event, at), [{ project: "zod", lines_written: 1, file_ext: "ts" }]);
  });
});

describe("no source text in any Play (ADR 0001)", () => {
  const secret = "sk-very-secret";
  const file = `import axios from "axios";\nconst apiKey = '${secret}';\n`;
  it.each([
    { name: "Write", event: write("src/secret.ts", `${file}axios.get(apiKey);\n`) },
    { name: "Edit", event: edit("src/secret.ts", "x", `axios.post(apiKey, '${secret}');`) },
    { name: "MultiEdit", event: multiEdit("src/secret.ts", [{ old_string: "x", new_string: `const k = require("dotenv") && '${secret}';` }]) },
    { name: "require", event: write("src/secret.js", `const { apiKey } = require("axios");\nfetch('${secret}');\n`) },
    { name: "dynamic import", event: write("src/secret.js", `const m = await import("axios");\nm.get('${secret}');\n`) },
  ])("$name", ({ event }) => {
    const plays = playsFromToolEvent(event, at, file);
    expect(plays.length).toBeGreaterThan(0);
    const out = JSON.stringify(plays);
    for (const leak of [secret, "apiKey", "src/secret", "axios.get", "const"]) expect(out).not.toContain(leak);
    for (const play of plays) expect(Object.keys(play).sort()).toEqual(["at", "file_ext", "kind", "lines_written", "project", "session_id"]);
  });
});

describe("package installs are not Plays", () => {
  it.each([
    { tool_name: "Bash", tool_input: { command: "npm install zod" } },
    { tool_name: "Bash", tool_input: { command: "pnpm add @scope/pkg" } },
    { tool_name: "Write", tool_input: { file_path: "package.json", content: '{\n  "dependencies": { "zod": "^3.0.0" }\n}\n' } },
    { tool_name: "Edit", tool_input: { file_path: "package.json", old_string: "{}", new_string: '{ "zod": "^3.0.0" }' } },
  ])("$tool_name $tool_input.file_path$tool_input.command", (e) => {
    expect(playsFromToolEvent({ ...e, session_id: "s1" }, at)).toEqual([]);
  });
});
