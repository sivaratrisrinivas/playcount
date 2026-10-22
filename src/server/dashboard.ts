import { html, raw } from "hono/html";
import type { Play } from "../play.ts";
import type { Statement } from "./statement.ts";
import type { Share, Weighting } from "./weighting.ts";

// Whether this service offers GitHub sign-in ("off" when it has no GitHub OAuth app configured).
export type SignIn = "available" | "off";

export type DashboardView = {
  name: string;
  plays: Play[];
  statement: Statement;
  // The current period's Weighting, once one has been proposed.
  weighting?: Weighting;
  // Whether this browser may propose, adjust and approve: only the signed-in Developer can.
  canWeigh: boolean;
  // Marks where the page's Plays end in the live Play stream.
  cursor: string;
  signIn: SignIn;
  // Present only for the signed-in Developer's own dashboard.
  setup?: { key: string; installCommand: string };
};

const head = () => html`<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PlayCount</title>
  <style>${raw(STYLE)}</style>
</head>`;

function header(signedIn: boolean, signIn: SignIn) {
  const account = signedIn
    ? html`<form method="post" action="/auth/signout"><button type="submit" class="link">Sign out</button></form>`
    : signIn === "available"
      ? html`<a class="button" href="/auth/github">Sign in with GitHub</a>`
      : "";
  return html`<header><h1>PlayCount</h1>${account}</header>`;
}

// Shown when there is no Developer to show: no one is signed in and no demo Developer is seeded.
export function landingPage(signIn: SignIn) {
  return html`<!doctype html>
<html lang="en">
${head()}
<body>
  <main>
    ${header(false, signIn)}
    <p>PlayCount splits your monthly budget among the open-source projects your coding agent actually uses.</p>
    ${signIn === "off" ? html`<p>Sign-in is not configured on this service yet.</p>` : ""}
  </main>
</body>
</html>`;
}

// The signed-in Developer's one-time setup: the install command, their PlayCount key, and key rotation.
function setupSection({ key, installCommand }: { key: string; installCommand: string }) {
  return html`<section id="setup">
      <h2>Set up capture</h2>
      <p>Run this once in a terminal. It installs the capture hook and docs tool into your user-level Claude Code settings, so Plays are counted in every repo you open. Needs Node 22.18 or later.</p>
      <div class="command"><pre><code id="install">${installCommand}</code></pre><button type="button" id="copy">Copy</button></div>
      <p>Your PlayCount key: <code id="key">${key}</code></p>
      <form method="post" action="/key/rotate" onsubmit="return confirm('Rotate your PlayCount key? The old key stops working at once.')">
        <button type="submit">Rotate key</button>
        <span class="hint">The old key stops working at once. Run the install command again to use the new one.</span>
      </form>
    </section>`;
}

// The Developer's dashboard: the current period's statement, then their Plays, newest first.
// It renders the Plays recorded so far, then follows the live Play stream so the counter and
// list update while the Agent works. A visitor who has not signed in sees the demo Developer's.
export function dashboardPage({ name, plays, statement, weighting, canWeigh, cursor, signIn, setup }: DashboardView) {
  return html`<!doctype html>
<html lang="en">
${head()}
<body>
  <main>
    ${header(Boolean(setup), signIn)}
    ${setup ? setupSection(setup) : ""}
    <h2 id="statement-title">Statement for ${statement.period}</h2>
    <p id="statement-empty" ${statement.projects.length ? "hidden" : ""}>No Plays this period yet.</p>
    <div id="statement-grid" ${statement.projects.length ? "" : "hidden"}></div>
    ${weightingSection(statement, weighting, canWeigh)}
    <h2>Plays</h2>
    <p class="summary">
      ${name}'s Plays: <strong id="count" data-cursor="${cursor}">${plays.length}</strong>
      <span id="live" class="live" data-state="connecting">connecting</span>
    </p>
    <p id="empty" ${plays.length ? "hidden" : ""}>No Plays yet. They appear here as your Agent writes code that imports npm packages or reads their docs through the PlayCount docs tool.</p>
    <table id="plays" ${plays.length ? "" : "hidden"}>
      <thead><tr><th>Project</th><th>Kind</th><th>Lines written</th><th>File</th><th>When</th></tr></thead>
      <tbody>${plays.map(playRow)}</tbody>
    </table>
  </main>
  <script type="application/json" id="statement">${raw(JSON.stringify(statement).replace(/</g, "\\u003c"))}</script>
  <script src="/vendor/ag-grid-community.min.js"></script>
  <script>${raw(GRID)}</script>
  <script>${raw(SCRIPT)}</script>
  ${canWeigh && weighting?.status === "proposed" ? html`<script>${raw(WEIGHTING)}</script>` : ""}
  ${setup ? html`<script>${raw(COPY)}</script>` : ""}
</body>
</html>`;
}

const day = (iso: string) => iso.slice(0, 10);

const proposeForm = (period: string, label: string) =>
  html`<form method="post" action="/weighting/propose"><input type="hidden" name="period" value="${period}"><button type="submit">${label}</button></form>`;

// The AI model's proposed split of the Budget for the period, with a reason per Project. While it is
// a proposal the signed-in Developer can adjust the shares and approve it; once approved it is
// locked. A visitor who has not signed in sees it read-only.
function weightingSection(statement: Statement, weighting: Weighting | undefined, canWeigh: boolean) {
  const { period } = statement;
  const section = (body: unknown) => html`<section id="weighting"><h2>Weighting for ${period}</h2>${body}</section>`;
  if (!weighting) {
    if (!statement.projects.length || !canWeigh) return "";
    return section(html`
      <p>An AI model reads this period's Play log (never your code) and proposes how to split your Budget among these Projects, with a reason for each. You can adjust the shares before approving.</p>
      ${proposeForm(period, "Propose Weighting")}`);
  }
  const source =
    weighting.proposed_by === "play counts"
      ? html`Proposed from Play counts on ${day(weighting.proposed_at)}, because the AI model was unavailable`
      : html`Proposed by ${weighting.proposed_by} on ${day(weighting.proposed_at)}`;
  const adjusted = weighting.adjusted ? ", then adjusted" : "";
  const sharesTable = (shareCell: (s: Share) => unknown, foot: unknown = "") => html`<table>
        <thead><tr><th>Project</th><th class="num">Share</th><th>Reason</th></tr></thead>
        <tbody>${weighting.shares.map((s) => html`<tr><td>${s.project}</td><td class="num">${shareCell(s)}</td><td>${s.reason}</td></tr>`)}</tbody>
        ${foot}
      </table>`;
  const readOnly = sharesTable((s) => `${s.share}%`);

  if (weighting.status === "approved") {
    const by = weighting.approved_by === "auto" ? "Auto-approved" : "Approved by the Developer";
    return section(html`
      <p class="note"><strong>${by}</strong> on ${day(weighting.approved_at ?? "")}. ${source}${adjusted}. It is locked for this period.</p>
      ${readOnly}`);
  }
  const deadline = html`It auto-approves on ${day(weighting.auto_approves_at)} unless approved first.`;
  if (!canWeigh) return section(html`<p class="note">${source}${adjusted}. ${deadline}</p>${readOnly}`);
  return section(html`
      <p class="note">${source}${adjusted}. ${deadline}</p>
      <form method="post" action="/weighting/adjust" id="weighting-adjust">
        <input type="hidden" name="period" value="${period}">
        ${sharesTable(
          (s) => html`<input type="hidden" name="project" value="${s.project}"><input type="number" name="share" value="${s.share}" min="0" max="100" step="0.01" required aria-label="${s.project} share">%`,
          html`<tfoot><tr><th>Total</th><th class="num"><span id="weighting-total">100</span>%</th><th></th></tr></tfoot>`,
        )}
        <p class="actions"><button type="submit" id="weighting-save">Save adjustments</button> <span class="hint">Shares must add up to 100%.</span></p>
      </form>
      <div class="actions">
        <form method="post" action="/weighting/approve"><input type="hidden" name="period" value="${period}"><button type="submit" class="primary">Approve Weighting</button></form>
        ${proposeForm(period, "Propose again")}
      </div>`);
}

// One Play as a dashboard row, both in the page and in the live Play stream.
export function playRow(p: Play) {
  return html`<tr>
      <td>${p.project}</td><td>${p.kind}</td><td>${p.lines_written ?? ""}</td><td>${p.file_ext ?? ""}</td>
      <td><time datetime="${p.at}">${p.at.slice(0, 16).replace("T", " ")} UTC</time></td>
    </tr>`;
}

// Follows /api/plays/stream. Each event's id is a cursor ending in the Developer's Play count,
// so the counter is set from it rather than incremented, and a reconnect (which sends the last
// cursor seen) catches up on exactly the Plays missed while disconnected.
const SCRIPT = `
(() => {
  const count = document.getElementById("count");
  const live = document.getElementById("live");
  const table = document.getElementById("plays");
  const setLive = (state, text) => { live.dataset.state = state; live.textContent = text; };

  const stream = new EventSource("/api/plays/stream?since=" + count.dataset.cursor);
  stream.onopen = () => setLive("live", "live");
  stream.onerror = () => setLive("connecting", "reconnecting");
  stream.addEventListener("reset", () => location.reload());
  stream.addEventListener("statement", (event) => showStatement(JSON.parse(event.data)));
  stream.onmessage = (event) => {
    const tbody = table.tBodies[0];
    tbody.insertAdjacentHTML("afterbegin", event.data);
    tbody.rows[0].className = "new";
    table.hidden = false;
    document.getElementById("empty").hidden = true;

    count.textContent = event.lastEventId.split(".")[1];
    count.classList.remove("bump");
    void count.offsetWidth;
    count.classList.add("bump");
  };
})();
`;

// Keeps a running total of the adjusted shares and only lets the Developer save 100%.
// Approving uses the saved shares, so it waits until unsaved edits are saved.
const WEIGHTING = `
(() => {
  const form = document.getElementById("weighting-adjust");
  const inputs = [...form.querySelectorAll('input[name="share"]')];
  const total = document.getElementById("weighting-total");
  const save = document.getElementById("weighting-save");
  const approve = document.querySelector('form[action="/weighting/approve"] button');
  const update = () => {
    const hundredths = inputs.reduce((sum, i) => sum + Math.round(Number(i.value) * 100), 0);
    total.textContent = String(hundredths / 100);
    total.classList.toggle("off", hundredths !== 10000);
    save.disabled = hundredths !== 10000;
    approve.disabled = inputs.some((i) => i.value !== i.defaultValue);
  };
  form.addEventListener("input", update);
  update();
})();
`;

const COPY = `
  document.getElementById("copy").addEventListener("click", async (event) => {
    await navigator.clipboard.writeText(document.getElementById("install").textContent);
    event.target.textContent = "Copied";
  });
`;

// Renders the statement with AG Grid; every column sorts on a header click. showStatement
// replaces it with a newer one from the live Play stream, flashing the cells that changed.
const GRID = `
  const statement = JSON.parse(document.getElementById("statement").textContent);
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const statementGrid = agGrid.createGrid(document.getElementById("statement-grid"), {
    theme: agGrid.themeQuartz.withPart(dark ? agGrid.colorSchemeDark : agGrid.colorSchemeLight),
    domLayout: "autoHeight",
    rowData: statement.projects,
    getRowId: (params) => params.data.project,
    defaultColDef: { sortable: true, flex: 1, enableCellChangeFlash: true },
    columnDefs: [
      { field: "project", headerName: "Project", flex: 2 },
      { field: "import_plays", headerName: "Import Plays" },
      { field: "docs_plays", headerName: "Docs Plays" },
      { field: "lines_written", headerName: "Lines written" },
    ],
  });
  function showStatement(next) {
    document.getElementById("statement-title").textContent = "Statement for " + next.period;
    statementGrid.setGridOption("rowData", next.projects);
    document.getElementById("statement-grid").hidden = next.projects.length === 0;
    document.getElementById("statement-empty").hidden = next.projects.length > 0;
  }
`;

const STYLE = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #e3e3e3; --accent: #0a7d3c; --flash: #e3f6ea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #999; --line: #333; --accent: #4cc982; --flash: #173524; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  time { color: var(--muted); }
  [hidden] { display: none; }
  #count { display: inline-block; font-variant-numeric: tabular-nums; }
  #count.bump { animation: bump 400ms ease-out; }
  @keyframes bump { 0% { transform: scale(1.4); color: var(--accent); } 100% { transform: scale(1); } }
  tr.new td { animation: flash 1.5s ease-out; }
  @keyframes flash { from { background: var(--flash); } to { background: transparent; } }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  header form { margin: 0; }
  a.button, button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; text-decoration: none; }
  button.link { border: 0; padding: 0; color: var(--muted); text-decoration: underline; }
  .command { display: flex; gap: 8px; align-items: flex-start; }
  .command pre { flex: 1; margin: 0; padding: 10px; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; font-size: 13px; }
  code { overflow-wrap: anywhere; }
  #weighting .note { color: var(--muted); }
  #weighting input[type="number"] { width: 5.5em; font: inherit; padding: 2px 4px; margin-right: 2px; text-align: right; }
  #weighting .num { text-align: right; white-space: nowrap; }
  #weighting .off { color: #c0392b; font-weight: 600; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
  .actions form { margin: 0; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .hint { margin-left: 8px; font-size: 13px; color: var(--muted); }
  .live { margin-left: 8px; font-size: 13px; color: var(--muted); }
  .live::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--muted); vertical-align: 1px; }
  .live[data-state="live"]::before { background: var(--accent); }
  @media (prefers-reduced-motion: reduce) { #count.bump, tr.new td { animation: none; } }
`;
