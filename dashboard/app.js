// Token Launch Radar — dashboard app (no network, no libraries).
// Reads window.TOKEN_RADAR_BOARD from data.js, written by main.ts.
(function () {
  "use strict";
  var BOARD = window.TOKEN_RADAR_BOARD;
  var boardEl = document.getElementById("rows");
  var emptyEl = document.getElementById("empty");
  if (!BOARD || !Array.isArray(BOARD.rows)) {
    boardEl.innerHTML = '<tr><td colspan="10">Board data did not load. Open this folder with its data.js beside index.html, or re-run <code>node main.ts</code>.</td></tr>';
    return;
  }
  var rows = BOARD.rows;
  var mine = new Set(JSON.parse(localStorage.getItem("token-radar-watch") || "[]"));

  var $ = function (id) { return document.getElementById(id); };
  function fmtUSD(x) {
    if (x == null || isNaN(x)) return "—";
    if (x >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
    if (x >= 1e3) return "$" + (x / 1e3).toFixed(0) + "K";
    return "$" + Math.round(x);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- header / KPIs -------------------------------------------------------
  $("snapshotLabel").textContent =
    "Snapshot: " + (BOARD.snapshot.snapshot_date || "DefiLlama") +
    " · " + BOARD.counts.protocols_in_snapshot.toLocaleString() + " protocols";
  $("footSource").textContent =
    (BOARD.snapshot.source || "DefiLlama") + " · " + (BOARD.snapshot.snapshot_date || "") +
    " · model " + BOARD.model;
  var top = rows[0];
  $("kpis").innerHTML = [
    ["Protocols ranked", BOARD.counts.ranked],
    ["Watchlist covered", BOARD.counts.watchlist + " / " + BOARD.counts.watchlist],
    ["Top expected value", top ? fmtUSD(top.expected_value_usd) + " · " + top.name : "—"],
    ["Median launch odds", median(rows.map(function (r) { return r.launch_odds; }))],
    ["Comps fit R²", BOARD.methodology.comps_r2 + " (n=" + BOARD.methodology.comps_n + ")"],
    ["Left off the board", BOARD.counts.excluded + " (see audit)"],
  ].map(function (k) {
    return '<div class="kpi"><b>' + esc(k[1]) + '</b><span>' + esc(k[0]) + '</span></div>';
  }).join("");
  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    return s.length % 2 ? s[Math.floor(s.length / 2)] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  // ---- methodology + audit panels ------------------------------------------
  var m = BOARD.methodology;
  $("methodBody").innerHTML =
    "<dl class='method'>" +
    "<dt>Comps curve</dt><dd><code>" + esc(m.comps_fit) + "</code> · R² " + m.comps_r2 + " · n=" + m.comps_n + "</dd>" +
    "<dt>Global median</dt><dd>" + m.global_median_mcap_tvl + "× mcap / TVL</dd>" +
    "<dt>Out-of-sample error</dt><dd>median |log error| " + (m.out_of_sample_median_abs_log_error == null ? "n/a" : m.out_of_sample_median_abs_log_error) + " (fit on older half, tested on newer half)</dd>" +
    "<dt>Launch odds by age</dt><dd>" + Object.keys(m.launch_odds_by_age_bucket).map(function (b) {
      var v = m.launch_odds_by_age_bucket[b];
      return b + ": " + Math.round(v.rate * 100) + "% (n=" + v.n + ")";
    }).join(" · ") + "</dd>" +
    "<dt>Minimum TVL</dt><dd>$" + m.min_tvl_usd.toLocaleString() + "</dd></dl>";
  var byCat = {};
  rows.forEach(function (r) { byCat[r.category] = (byCat[r.category] || 0) + 1; });
  $("auditBody").innerHTML =
    "<p><b>" + BOARD.counts.excluded.toLocaleString() + "</b> of " +
    BOARD.counts.protocols_in_snapshot.toLocaleString() + " protocols are not ranked: " +
    BOARD.counts.already_tokenised.toLocaleString() + " already have a token, and the rest are " +
    "versions / wrapped / staked products of one that trades, in an unlaunchable category " +
    "(CEX, chain, bridge), or below the $" + (m.min_tvl_usd / 1e6) + "M TVL minimum.</p>" +
    "<p>Ranked by category: " + Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; })
      .slice(0, 8).map(function (c) { return esc(c) + " " + byCat[c]; }).join(" · ") + ".</p>";

  // ---- filters ---------------------------------------------------------------
  var cats = [...new Set(rows.map(function (r) { return r.category; }))].sort();
  var chains = [...new Set(rows.map(function (r) { return r.chain; }))].sort();
  cats.forEach(function (c) { $("fCategory").add(new Option(c, c)); });
  chains.forEach(function (c) { $("fChain").add(new Option(c, c)); });

  function filtered() {
    var q = $("q").value.trim().toLowerCase();
    var cat = $("fCategory").value, ch = $("fChain").value, cf = $("fConf").value;
    var list = rows.filter(function (r) {
      if (q && (r.name + " " + r.category + " " + r.chain + " " + r.slug).toLowerCase().indexOf(q) === -1) return false;
      if (cat && r.category !== cat) return false;
      if (ch && r.chain !== ch) return false;
      if (cf === "high" && r.confidence !== "high") return false;
      if (cf === "medium" && r.confidence === "low") return false;
      if (cf === "low" && r.confidence !== "low") return false;
      if ($("fWatch").checked && !r.watchlist) return false;
      if ($("fMine").checked && !mine.has(r.id)) return false;
      return true;
    });
    var s = $("sort").value;
    var key = { expected: "expected_value_usd", implied: "implied_value_usd", tvl: "tvl_usd", odds: "launch_odds", score: "radar_score", growth: "tvl_7d_change_pct", age: "age_days" }[s];
    list.sort(function (a, b) {
      var av = a[key] == null ? -Infinity : a[key], bv = b[key] == null ? -Infinity : b[key];
      return bv - av || a.rank - b.rank;
    });
    return list;
  }

  function render() {
    var list = filtered();
    $("resultCount").textContent = list.length + " of " + rows.length + " ranked protocols";
    emptyEl.hidden = list.length > 0;
    boardEl.innerHTML = list.slice(0, 300).map(function (r) {
      var starred = mine.has(r.id);
      return "<tr data-id='" + esc(r.id) + "'>" +
        "<td>" + r.rank + "</td>" +
        "<td class='namecell'>" + esc(r.name) + "<small>" + esc(r.slug || "") +
        (r.watchlist ? " · <span class='tag'>watchlist</span>" : "") + "</small></td>" +
        "<td>" + esc(r.category) + "</td><td>" + esc(r.chain) + "</td>" +
        "<td class='num'>" + fmtUSD(r.tvl_usd) + "</td>" +
        "<td class='num'>" + fmtUSD(r.implied_value_usd) + "</td>" +
        "<td class='num'>" + Math.round(r.launch_odds * 100) + "%</td>" +
        "<td class='num'><b>" + fmtUSD(r.expected_value_usd) + "</b></td>" +
        "<td class='num'><span class='scorebar'><i style='width:" + r.radar_score + "%'></i></span>" + r.radar_score +
        " <span class='tag " + r.confidence + "'>" + r.confidence + "</span></td>" +
        "<td><button class='star" + (starred ? "" : " off") + "' data-star='" + esc(r.id) + "' title='My watchlist' aria-label='Toggle watchlist for " + esc(r.name) + "'>" + (starred ? "★" : "☆") + "</button></td>" +
        "</tr>";
    }).join("");
    if (list.length > 300) {
      boardEl.innerHTML += "<tr><td colspan='10' style='text-align:center;color:var(--muted)'>Showing the first 300 of " + list.length + " — narrow the filters to see more.</td></tr>";
    }
  }

  boardEl.addEventListener("click", function (e) {
    var star = e.target.closest("[data-star]");
    if (star) {
      e.stopPropagation();
      var id = star.getAttribute("data-star");
      if (mine.has(id)) mine.delete(id); else mine.add(id);
      localStorage.setItem("token-radar-watch", JSON.stringify([...mine]));
      render();
      return;
    }
    var tr = e.target.closest("tr[data-id]");
    if (tr) openDetail(tr.getAttribute("data-id"));
  });

  ["q", "fCategory", "fChain", "fConf", "fWatch", "fMine", "sort"].forEach(function (id) {
    $(id).addEventListener("input", render);
    $(id).addEventListener("change", render);
  });
  $("resetBtn").addEventListener("click", function () {
    ["q", "fCategory", "fChain", "fConf", "sort"].forEach(function (id) { $(id).value = id === "sort" ? "expected" : ""; });
    $("fWatch").checked = false; $("fMine").checked = false;
    render();
  });

  // ---- detail drawer ---------------------------------------------------------
  function openDetail(id) {
    var r = rows.find(function (x) { return x.id === id; });
    if (!r) return;
    var d = $("detail");
    var peers = rows.filter(function (x) { return x.category === r.category; }).slice(0, 5);
    d.innerHTML =
      "<h2>" + esc(r.name) + "</h2>" +
      "<p class='meta'>#" + r.rank + " · " + esc(r.category) + " · " + esc(r.chain) +
      " · " + r.chains.length + " chain" + (r.chains.length > 1 ? "s" : "") +
      (r.url ? " · <a href='" + esc(r.url) + "' target='_blank' rel='noopener'>official site ↗</a>" : "") +
      (r.twitter ? " · <a href='https://x.com/" + esc(r.twitter) + "' target='_blank' rel='noopener'>@" + esc(r.twitter) + "</a>" : "") + "</p>" +
      "<div class='kv'>" +
      "<div><b>" + fmtUSD(r.tvl_usd) + "</b><span>TVL" + (r.tvl_7d_change_pct != null ? " · " + (r.tvl_7d_change_pct >= 0 ? "+" : "") + r.tvl_7d_change_pct + "% / 7d" : "") + "</span></div>" +
      "<div><b>" + fmtUSD(r.implied_value_usd) + "</b><span>Implied launch value</span></div>" +
      "<div><b>" + Math.round(r.launch_odds * 100) + "%</b><span>Launch odds" + (r.age_days != null ? " · " + r.age_days + " days old" : "") + "</span></div>" +
      "<div><b>" + fmtUSD(r.expected_value_usd) + "</b><span>Expected value · score " + r.radar_score + " · " + r.confidence + " confidence</span></div>" +
      "</div>" +
      "<p>" + esc(r.why) + "</p>" +
      "<h3>Category peers — implied value</h3><canvas class='chart' id='peerChart' width='520' height='180'></canvas>" +
      "<p class='fine'>Top peers in " + esc(r.category) + " by expected value. Category multiple " + r.category_multiple + "× TVL from " + r.category_peer_count + " trading peers.</p>" +
      "<h3>Farm plan — how to position for a launch</h3>" +
      "<ol class='farm'>" + r.farm_plan.map(function (s) {
        return "<li><b>Step " + s.step + ": " + esc(s.title) + "</b><p>" + esc(s.detail) + "</p>" +
          "<span class='cost'>" + esc(s.cost) + (s.minutes ? " · ~" + s.minutes + " min" : "") + "</span></li>";
      }).join("") + "</ol>" +
      "<p class='fine'>Model: implied = TVL × category multiple " + r.category_multiple + "× (shrunk toward the global median). " +
      "Log-log comps fit would imply " + fmtUSD(r.model.fit_implied_usd) + " — reported as a cross-check. " +
      "Growth bonus +" + Math.round(r.model.growth_bonus * 100) +
      "%, breadth bonus +" + Math.round(r.model.breadth_bonus * 100) + "% (shown for context; the score follows expected value only).</p>";
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("scrim").hidden = false;
    drawPeers(peers, r);
  }
  function closeDetail() {
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("scrim").hidden = true;
  }
  $("drawerClose").addEventListener("click", closeDetail);
  $("scrim").addEventListener("click", closeDetail);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDetail(); });

  function drawPeers(peers, current) {
    var c = document.getElementById("peerChart");
    if (!c || !c.getContext) return;
    var ctx = c.getContext("2d");
    var W = c.width, H = c.height, pad = 34;
    var max = Math.max.apply(null, peers.map(function (p) { return p.implied_value_usd; }).concat([1]));
    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px system-ui";
    var bw = (W - pad * 2) / peers.length;
    peers.forEach(function (p, i) {
      var h = Math.max(3, (p.implied_value_usd / max) * (H - 70));
      var x = pad + i * bw + 6, y = H - 30 - h;
      ctx.fillStyle = p.id === current.id ? "#38d6a5" : "#5aa9ff";
      ctx.fillRect(x, y, bw - 12, h);
      ctx.fillStyle = "#9db0c9";
      ctx.textAlign = "center";
      ctx.fillText(fmtUSD(p.implied_value_usd), x + (bw - 12) / 2, y - 6);
      ctx.save();
      ctx.translate(x + (bw - 12) / 2, H - 16);
      ctx.fillText(p.name.length > 12 ? p.name.slice(0, 11) + "…" : p.name, 0, 0);
      ctx.restore();
    });
  }

  render();
})();
