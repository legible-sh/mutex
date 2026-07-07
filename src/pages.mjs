// HTML for browsers. curl gets text/JSON; these pages are the same data
// with eyeballs in mind. Self-contained: inline CSS, no external assets.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const shell = (title, body, { refresh = null } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.25rem; background: #0b0e14; color: #d6deeb;
         font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; color: #7ee787; }
  h1 a { color: inherit; text-decoration: none; }
  .sub { color: #8b96a8; margin: 0 0 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #1d2433; }
  th { color: #8b96a8; font-weight: normal; }
  code, pre { background: #11161f; border-radius: 6px; }
  code { padding: .1rem .35rem; }
  pre { padding: .9rem 1rem; overflow-x: auto; }
  .free { color: #7ee787; } .held { color: #f0883e; }
  .muted { color: #8b96a8; }
  footer { margin-top: 2.5rem; color: #566073; font-size: .85rem; }
  footer a { color: #8b96a8; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export function homePage(baseUrl) {
  const b = esc(baseUrl);
  return shell('mutex', `
<h1>mutex</h1>
<p class="sub">flock(1) for agents that live on different machines.</p>
<p>Named locks and counting semaphores over plain HTTP. Acquire with a TTL
lease in one curl, long-poll to block, heartbeat to renew. Every grant carries
a monotonic fencing token.</p>
<pre>curl -X POST '${b}/migrate-prod-db?ttl=60'            # 200 = yours, 409 = held
curl -X POST '${b}/migrate-prod-db?ttl=60&amp;wait=300'   # block until yours (FIFO)
curl -X POST '${b}/TOPIC/LEASE/renew?ttl=60'  # heartbeat; 404 = you lost it
curl -X DELETE '${b}/TOPIC/LEASE'             # release
curl '${b}/TOPIC'                             # who holds it (no lease tokens)</pre>
<p>Semaphores: add <code>capacity=3</code> to the acquire. Watch a topic live:
<code>curl -N ${b}/TOPIC/sse</code>. Open <code>${b}/&lt;topic&gt;</code> in a
browser for a live status page.</p>
<p class="muted">This is a lease, not a lock — pass the <code>fence</code>
number to whatever you're protecting and reject writes from lower fences.</p>
<footer>One of ten legible primitives · <a href="https://github.com/legible-sh/mutex">source</a> · MIT</footer>`);
}

export function statusPage(baseUrl, status) {
  const free = status.capacity === null
    ? status.capacity
    : status.capacity - status.holders.length;
  const state = status.capacity === null
    ? '<span class="free">never used</span>'
    : free > 0
      ? `<span class="free">${free} of ${status.capacity} permit${status.capacity === 1 ? '' : 's'} free</span>`
      : '<span class="held">held</span>';
  const rows = status.holders.map((h) => `<tr>
    <td>${esc(h.name)}</td>
    <td>${h.fence}</td>
    <td>${esc(new Date(h.since).toISOString())}</td>
    <td>${esc(new Date(h.expires).toISOString())}</td>
  </tr>`).join('\n');
  return shell(`mutex/${status.topic}`, `
<h1><a href="${esc(baseUrl)}/">mutex</a> / ${esc(status.topic)}</h1>
<p class="sub">${state} · ${status.waiting} waiting · capacity ${status.capacity ?? 'unset'}</p>
${status.holders.length ? `<table>
<tr><th>holder</th><th>fence</th><th>since</th><th>expires</th></tr>
${rows}
</table>` : '<p class="muted">No holders. First POST takes it.</p>'}
<pre>curl -X POST '${esc(baseUrl)}/${esc(status.topic)}?ttl=60&amp;wait=300'</pre>
<p class="muted">Lease tokens are never shown — knowing the topic must not let
you release someone else's lock. Auto-refreshes every 2s.</p>
<footer><a href="${esc(baseUrl)}/${esc(status.topic)}/sse">live event stream</a> · MIT</footer>`,
  { refresh: 2 });
}
