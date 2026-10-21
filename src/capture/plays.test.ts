import { describe, expect, it } from "vitest";
import { playsFromToolEvent, type ToolEvent } from "./plays.ts";

const at = "2026-10-21T12:00:00.000Z";

function write(file_path: string, content: string): ToolEvent {
  return { tool_name: "Write", tool_input: { file_path, content }, session_id: "s1" };
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

  it("ignores tools other than Write", () => {
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
