import { html, raw } from "hono/html";
import type { Play } from "../play.ts";

// The Developer's dashboard: their Plays, newest first. It renders the Plays recorded so far,
// then follows the live Play stream so the counter and list update while the Agent works.
export function dashboardPage(name: string, plays: Play[]) {
  const rows = plays.map(
    (p) => html`<tr>
      <td>${p.project}</td><td>${p.kind}</td><td>${p.lines_written ?? ""}</td><td>${p.file_ext ?? ""}</td>
      <td><time datetime="${p.at}">${when(p.at)}</time></td>
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
    <p class="summary">
      ${name}'s Plays: <strong id="count" data-count="${plays.length}">${plays.length}</strong>
      <span id="live" class="live" data-state="connecting">connecting</span>
    </p>
    <p id="empty" ${plays.length ? "hidden" : ""}>No Plays yet. They appear here as your Agent writes code that imports npm packages.</p>
    <table id="plays" ${plays.length ? "" : "hidden"}>
      <thead><tr><th>Project</th><th>Kind</th><th>Lines written</th><th>File</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
  <script>${raw(SCRIPT)}</script>
</body>
</html>`;
}

// Keep in step with `when` in SCRIPT, so streamed rows look like rendered ones.
function when(at: string) {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

// Follows /api/plays/stream. Each event's id is the Developer's Play count, so the counter is
// set from it rather than incremented, and a reconnect (which sends the last id seen) catches
// up on exactly the Plays missed while disconnected.
const SCRIPT = `
(() => {
  const count = document.getElementById("count");
  const live = document.getElementById("live");
  const table = document.getElementById("plays");
  const tbody = table.querySelector("tbody");
  const when = (at) => at.slice(0, 16).replace("T", " ") + " UTC";
  const setLive = (state, text) => { live.dataset.state = state; live.textContent = text; };

  const stream = new EventSource("/api/plays/stream?since=" + count.dataset.count);
  stream.onopen = () => setLive("live", "live");
  stream.onerror = () => setLive("connecting", "reconnecting");
  stream.addEventListener("reset", () => location.reload());
  stream.onmessage = (event) => {
    const play = JSON.parse(event.data);
    const row = document.createElement("tr");
    const cells = [play.project, play.kind, play.lines_written ?? "", play.file_ext ?? ""];
    for (const text of cells) row.appendChild(document.createElement("td")).textContent = String(text);
    const time = row.appendChild(document.createElement("td")).appendChild(document.createElement("time"));
    time.dateTime = play.at;
    time.textContent = when(play.at);
    row.className = "new";
    tbody.prepend(row);
    table.hidden = false;
    document.getElementById("empty").hidden = true;

    count.dataset.count = event.lastEventId;
    count.textContent = event.lastEventId;
    count.classList.remove("bump");
    void count.offsetWidth;
    count.classList.add("bump");
  };
})();
`;

const STYLE = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #e3e3e3; --accent: #0a7d3c; --flash: #e3f6ea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #999; --line: #333; --accent: #4cc982; --flash: #173524; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  time { color: var(--muted); }
  [hidden] { display: none; }
  #count { display: inline-block; font-variant-numeric: tabular-nums; }
  #count.bump { animation: bump 400ms ease-out; }
  @keyframes bump { 0% { transform: scale(1.4); color: var(--accent); } 100% { transform: scale(1); } }
  tr.new td { animation: flash 1.5s ease-out; }
  @keyframes flash { from { background: var(--flash); } to { background: transparent; } }
  .live { margin-left: 8px; font-size: 13px; color: var(--muted); }
  .live::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--muted); vertical-align: 1px; }
  .live[data-state="live"]::before { background: var(--accent); }
  @media (prefers-reduced-motion: reduce) { #count.bump, tr.new td { animation: none; } }
`;
