import { html, raw } from "hono/html";
import type { Play } from "../play.ts";
import type { Statement } from "./statement.ts";

// The Developer's dashboard: the current period's statement, then their Plays, newest first.
export function dashboardPage(name: string, plays: Play[], statement: Statement) {
  const rows = plays.map(
    (p) => html`<tr>
      <td>${p.project}</td><td>${p.kind}</td><td>${p.lines_written ?? ""}</td><td>${p.file_ext ?? ""}</td>
      <td><time datetime="${p.at}">${p.at.slice(0, 16).replace("T", " ")} UTC</time></td>
    </tr>`,
  );
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PlayCount</title>
  <style>${raw(STYLE)}</style>
</head>
<body>
  <main>
    <h1>PlayCount</h1>
    <h2>Statement for ${statement.period}</h2>
    ${statement.projects.length
      ? html`<div id="statement-grid"></div>`
      : html`<p>No Plays this period yet.</p>`}
    <h2>Plays</h2>
    <p>${name}'s Plays: <strong>${plays.length}</strong></p>
    ${plays.length
      ? html`<table>
      <thead><tr><th>Project</th><th>Kind</th><th>Lines written</th><th>File</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
      : html`<p>No Plays yet. They appear here as your Agent writes code that imports npm packages.</p>`}
  </main>
  <script type="application/json" id="statement">${raw(JSON.stringify(statement).replace(/</g, "\\u003c"))}</script>
  <script src="/vendor/ag-grid-community.min.js"></script>
  <script>${raw(GRID)}</script>
</body>
</html>`;
}

// Renders the statement with AG Grid; every column sorts on a header click.
const GRID = `
  const statement = JSON.parse(document.getElementById("statement").textContent);
  const el = document.getElementById("statement-grid");
  if (el) {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    agGrid.createGrid(el, {
      theme: agGrid.themeQuartz.withPart(dark ? agGrid.colorSchemeDark : agGrid.colorSchemeLight),
      domLayout: "autoHeight",
      rowData: statement.projects,
      defaultColDef: { sortable: true, flex: 1 },
      columnDefs: [
        { field: "project", headerName: "Project", flex: 2 },
        { field: "import_plays", headerName: "Import Plays" },
        { field: "docs_plays", headerName: "Docs Plays" },
        { field: "lines_written", headerName: "Lines written" },
      ],
    });
  }
`;

const STYLE = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #e3e3e3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #999; --line: #333; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  time { color: var(--muted); }
`;
