import type { Intervention } from "./types.js";

/**
 * Operator-facing HTML. Deliberately plain — the brief permits mocking this
 * surface, and every minute spent styling it is a minute not spent on the
 * control-transfer model underneath.
 *
 * The one thing it does take seriously: showing the operator enough context to
 * act safely without reading a log file. Which capability, which step, what the
 * run expected, what it actually saw.
 */

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;background:#f6f6f4;color:#1a1a18}
h1{font-size:18px;font-weight:500;margin:0 0 4px}
h2{font-size:15px;font-weight:500;margin:20px 0 8px}
.card{background:#fff;border:1px solid #e0dfd9;border-radius:8px;padding:16px;margin-bottom:16px}
dl{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;margin:0}
dt{color:#6b6a64}dd{margin:0}
code{background:#f1efe8;padding:1px 5px;border-radius:4px;font-size:13px}
img{max-width:100%;border:1px solid #e0dfd9;border-radius:4px;cursor:crosshair;display:block}
form{display:inline}
input,button,select{font:inherit;padding:6px 10px;border:1px solid #cfcec7;border-radius:6px;background:#fff}
button{cursor:pointer;background:#1a1a18;color:#fff;border-color:#1a1a18}
button.secondary{background:#fff;color:#1a1a18}
.row{display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap}
.warn{background:#fdf3e3;border-color:#e8cf9f}
table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eceae3;vertical-align:top}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:#f1efe8}
a{color:#1a1a18}
`;

export function renderIndex(list: Intervention[]): string {
  const rows = list.length
    ? list
        .map(
          (i) => `<tr>
        <td><a href="/i/${esc(i.interventionId)}">${esc(i.interventionId)}</a></td>
        <td>${esc(i.capabilityId)}</td>
        <td>${esc(i.reason)}</td>
        <td><span class="pill">${esc(i.state)}</span></td>
        <td>${esc(i.operator ?? "—")}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="5">No interventions raised.</td></tr>`;

  return `<!doctype html><meta charset="utf-8"><title>Operator queue</title><style>${STYLE}</style>
<h1>Operator queue</h1>
<div class="card"><table>
<tr><th>Intervention</th><th>Capability</th><th>Reason</th><th>State</th><th>Operator</th></tr>
${rows}</table></div>`;
}

export function renderConsole(i: Intervention, port: number): string {
  const done = i.state === "returned" || i.state === "aborted";

  const actions = i.humanActions.length
    ? i.humanActions
        .map(
          (a) => `<tr><td>${esc(a.at.slice(11, 19))}</td><td>${esc(a.kind)}</td>
          <td>${a.at_xy ? `(${a.at_xy.x}, ${a.at_xy.y})` : esc(a.value ?? "")}</td>
          <td><code>${esc(a.urlAfter)}</code></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4">Nothing recorded yet.</td></tr>`;

  /**
   * An irreversible step is a decision, not a repair. The person's job is to
   * approve or refuse; the automation then performs the step itself, once.
   * Offering click-anywhere controls here invites the operator to do the step by
   * hand — which then happens twice, or makes the resumed step fail because the
   * button it wants has already gone. So the screenshot is read-only and the
   * only controls are approve and refuse.
   */
  const approval = i.reason === "irreversible_step" && !done;

  const controls = done
    ? `<p>Control returned to automation. The run has resumed.</p>`
    : approval
      ? `
<div class="row">
  <form method="post" action="/i/${i.interventionId}/finish">
    <input type="hidden" name="decision" value="resume">
    <button>Approve &amp; resume</button>
  </form>
  <form method="post" action="/i/${i.interventionId}/finish">
    <input type="hidden" name="decision" value="abort">
    <button class="secondary">Refuse — abort the run</button>
  </form>
</div>`
    : `
<p><b>Click the field on the screenshot first</b> — typing goes wherever the
keyboard focus currently is in the live browser, exactly as it would if you were
sitting at it. <i>Sensitive</i> is on by default: the audit trail then records
that a value was entered and where, never the value itself. Untick it only for
something that is safe to keep.</p>
<div class="row">
  <form method="post" action="/i/${i.interventionId}/act">
    <input type="hidden" name="kind" value="type">
    <input type="hidden" name="operator" value="${esc(i.operator ?? "")}">
    <input name="value" placeholder="text to type into the focused field" size="30" required>
    <label><input type="checkbox" name="sensitive" checked> sensitive (do not record the value)</label>
    <button>Type</button>
  </form>
  <form method="post" action="/i/${i.interventionId}/act">
    <input type="hidden" name="kind" value="press">
    <input type="hidden" name="operator" value="${esc(i.operator ?? "")}">
    <select name="keys"><option>Enter</option><option>Tab</option><option>Escape</option></select>
    <button>Press</button>
  </form>
  <form method="post" action="/i/${i.interventionId}/act">
    <input type="hidden" name="kind" value="note">
    <input type="hidden" name="operator" value="${esc(i.operator ?? "")}">
    <input name="value" placeholder="why you did this — recorded, not typed into the app" size="42" required>
    <button class="secondary">Add note</button>
  </form>
</div>
<div class="row">
  <form method="post" action="/i/${i.interventionId}/finish">
    <input type="hidden" name="decision" value="resume">
    <button>Hand back &amp; resume</button>
  </form>
  <form method="post" action="/i/${i.interventionId}/finish">
    <input type="hidden" name="decision" value="abort">
    <button class="secondary">Abort the run</button>
  </form>
</div>`;

  return `<!doctype html><meta charset="utf-8"><title>Intervention ${esc(i.interventionId)}</title><style>${STYLE}</style>
<h1>Intervention ${esc(i.interventionId)}</h1>
<p><a href="/">&larr; queue</a></p>

<div class="card warn">
<dl>
<dt>Capability</dt><dd><code>${esc(i.capabilityId)}@${esc(i.capabilityVersion)}</code></dd>
<dt>Goal</dt><dd>${esc(i.goal)}</dd>
<dt>Stopped at step</dt><dd><code>${esc(i.atStepId)}</code></dd>
<dt>Why</dt><dd>${esc(i.reason)}</dd>
<dt>Expected</dt><dd>${esc(i.expected)}</dd>
<dt>Observed</dt><dd>${esc(i.observed)}</dd>
<dt>Tenant</dt><dd>${esc(i.tenantId)}</dd>
<dt>Live session</dt><dd><code>${esc(i.sessionId)}</code> — attachable at <code>${esc(i.connectUrl)}</code></dd>
<dt>Controller</dt><dd><span class="pill">${esc(i.controller)}</span></dd>
</dl>
</div>

<h2>Live session</h2>
<div class="card">
${
    approval
      ? `<p><b>Approval needed.</b> The next step cannot be undone. Review the screen below. If it is right, press <b>Approve &amp; resume</b> and the automation will perform the step itself. <b>Do not click the button on the page yourself</b> — the screenshot is read-only here.</p>`
      : `<p>Click the image to click the same point in the live browser. The automation is paused and cannot act.</p>`
  }
<form method="post" action="/i/${i.interventionId}/act" id="clickform">
  <input type="hidden" name="kind" value="click">
  <input type="hidden" name="operator" value="${esc(i.operator ?? "")}">
  <input type="hidden" name="x" id="x"><input type="hidden" name="y" id="y">
  <img src="/i/${i.interventionId}/screenshot?t=${Date.now()}" id="shot" alt="live session"${approval ? ` data-locked="1" style="cursor:default"` : ""}>
</form>
${controls}
</div>

<h2>Recorded operator actions</h2>
<div class="card"><table>
<tr><th>Time</th><th>Action</th><th>Detail</th><th>URL after</th></tr>
${actions}</table></div>

<script>
// Map a click on the screenshot to viewport coordinates in the live session.
const img = document.getElementById('shot');
img.addEventListener('click', (e) => {
  if (img.dataset.locked) return;
  const r = img.getBoundingClientRect();
  document.getElementById('x').value = Math.round((e.clientX - r.left) * (img.naturalWidth / r.width));
  document.getElementById('y').value = Math.round((e.clientY - r.top) * (img.naturalHeight / r.height));
  document.getElementById('clickform').submit();
});
</script>`;
}
