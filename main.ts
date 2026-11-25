// token-radar — main.ts
// Entry for make.fun bounty token-radar-01: "Build the best token launch radar".
//
// What it does
// ------------
// Reads a DefiLlama protocol snapshot (the grader's sealed snapshot at
// $MAKEFUN_INPUT_DIR/snapshot.json, or --input <file>), finds every protocol
// that still records no token and is not a wrapped / staked / versioned
// product of a protocol that already trades, prices each one against the
// protocols that DO trade, and writes a ranked board plus a judge dossier:
//
//   out/board.json    — the ranked board (>=100 rows when the snapshot allows)
//   out/dossier.json  — the canonical judge dossier, written by the vendored
//                       make.fun library (vendor/makefun-board.ts) from
//                       out/dashboard/ and out/screenshots/
//   out/data.js       — the same board as a script the dashboard reads
//   out/excluded.json — every protocol left off the board, with the reason
//
// The model ("radar-1") is fitted on every run from the snapshot's own
// figures — never from a hardcoded list of names or values:
//   1. Comps: each category's median market-cap/TVL multiple among the
//      protocols in the snapshot that already trade, shrunk toward the
//      global median (shrinkage k = 5). Implied value = TVL x that multiple.
//      A log-log OLS fit of log(market cap) on log(TVL) is computed on the
//      same traders as a validation cross-check (and reported, not used
//      for ranking, because its slope is flattened by tiny-cap tokens).
//
// Determinism: no wall-clock time, no randomness, no network. Two runs on
// the same snapshot produce byte-identical outputs (the snapshot's own
// `snapshot_date` / `fetched_at` is carried through as provenance, never
// today's date).
//
// Run it (Node 22.18+):
//   node main.ts                          # reads ./input/snapshot.json, writes ./out/
//   node main.ts --input snap.json --out out/
//   MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts   # grader mode
//
// No dependencies, no network, no secrets, no environment code execution.

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { buildDossier } from "./vendor/makefun-board.ts";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = "radar-1";
const MIN_TVL_USD = 5_000_000; // a launch candidate must be a real protocol
const SHRINK_K_CATEGORY = 5;
const SHRINK_K_ODDS = 8;
const CATEGORY_FACTOR_MIN = 0.3;
const CATEGORY_FACTOR_MAX = 3.0;

// Categories that cannot launch a token of their own in any meaningful sense:
// centralised exchanges, chains themselves, and bridges / wrapped-asset
// products (a bridge's "token" would be the wrapped asset, not a launch).
const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Chain",
  "Bridge",
  "Canonical Bridge",
  "Anchor BTC",
  "CEXs",
]);

// Name patterns for wrapped / staked / derivative products of a token that
// already trades (wstETH, cbETH, WBTC, sUSDe-style wrappers, "Staked X").
const WRAPPED_NAME =
  /^(wrapped|wbtc|weth|wsteth|sfrxeth|reth|cbeth|steth|ankreth)\b|wrapped|pegged token|staked (eth|btc|sol|avax|bnb|matic)/i;
const VERSION_SUFFIX = /\s+v\d+(\.\d+)?$/i; // "Aave V3", "LayerZero V2" ...

// Gas / cost tiers per primary chain, for the farm plan (USD, Nov 2026).
const CHAIN_COST: Record<string, { gas: string; bridge: string; minutes: number }> = {
  Ethereum: { gas: "$3–$15 per tx", bridge: "$10–$40", minutes: 30 },
  Solana: { gas: "<$0.05 per tx", bridge: "$1–$5", minutes: 15 },
  Base: { gas: "<$0.10 per tx", bridge: "$1–$5", minutes: 15 },
  Arbitrum: { gas: "$0.10–$1 per tx", bridge: "$1–$5", minutes: 15 },
  Optimism: { gas: "$0.10–$1 per tx", bridge: "$1–$5", minutes: 15 },
  Polygon: { gas: "<$0.10 per tx", bridge: "$1–$5", minutes: 15 },
  Avalanche: { gas: "$0.20–$2 per tx", bridge: "$2–$8", minutes: 20 },
  BSC: { gas: "$0.10–$1 per tx", bridge: "$1–$5", minutes: 15 },
  Binance: { gas: "$0.10–$1 per tx", bridge: "$1–$5", minutes: 15 },
  Sui: { gas: "<$0.10 per tx", bridge: "$1–$5", minutes: 15 },
  Aptos: { gas: "<$0.10 per tx", bridge: "$1–$5", minutes: 15 },
  Unichain: { gas: "<$0.10 per tx", bridge: "$1–$5", minutes: 15 },
};
const DEFAULT_COST = { gas: "$0.50–$5 per tx", bridge: "$2–$10", minutes: 20 };

interface Proto {
  id: string;
  name: string;
  slug: string;
  category: string;
  chain: string;
  chains: string[];
  tvl: number;
  chainTvls?: Record<string, number>;
  change_1d?: number | null;
  change_7d?: number | null;
  gecko_id?: string | null;
  cmcId?: string | null;
  mcap?: number | null;
  listedAt?: number | null;
  url?: string;
  twitter?: string | null;
  parentProtocol?: string | null;
  description?: string;
  symbol?: string | null;
  address?: string | null;
}

interface BoardRow {
  rank: number;
  id: string;
  name: string;
  slug: string;
  category: string;
  chain: string;
  chains: string[];
  tvl_usd: number;
  tvl_7d_change_pct: number | null;
  age_days: number | null;
  listed_at: number | null;
  implied_value_usd: number;
  launch_odds: number;
  expected_value_usd: number;
  radar_score: number;
  category_multiple: number;
  category_peer_count: number;
  confidence: "high" | "medium" | "low";
  watchlist: boolean;
  url: string | null;
  twitter: string | null;
  model: {
    fit_implied_usd: number;
    category_factor: number;
    growth_bonus: number;
    breadth_bonus: number;
  };
  farm_plan: { step: number; title: string; detail: string; cost: string; minutes: number }[];
  why: string;
}

function parseArgs(argv: string[]): { input: string; out: string } {
  let input = process.env.MAKEFUN_INPUT_DIR
    ? join(process.env.MAKEFUN_INPUT_DIR, "snapshot.json")
    : join(HERE, "input", "snapshot.json");
  let out = process.env.MAKEFUN_OUTPUT_DIR || join(HERE, "out");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) input = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) out = argv[++i];
  }
  return { input: resolve(input), out: resolve(out) };
}

function loadSnapshot(path: string): { protocols: Proto[]; meta: Record<string, unknown> } {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const list: unknown[] = Array.isArray(raw) ? raw : raw.protocols ?? raw.snapshot ?? [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`no protocols found in snapshot: ${path}`);
  }
  const meta: Record<string, unknown> = Array.isArray(raw)
    ? {}
    : { source: raw.source ?? null, snapshot_date: raw.snapshot_date ?? null, fetched_at: raw.fetched_at ?? null };
  const watchlist: string[] = Array.isArray(raw?.watchlist) ? raw.watchlist : [];
  return {
    protocols: list as Proto[],
    meta: { ...meta, watchlist, protocol_count: list.length },
  };
}

// A protocol "has a token" when DefiLlama records a live market for it.
// Four signals, in order of strength:
//   - a CoinGecko id, a CoinMarketCap id, or a market cap; and
//   - a token symbol PLUS a token contract address. This last one matters:
//     DefiLlama sets gecko_id only on a project's main entry, which often
//     is not in the list at all — but every version entry ("Pendle V2",
//     "Curve DEX", "GMX EVM", "Aave V3") still carries its parent's token
//     symbol and contract address. A symbol alone is NOT enough (DefiLlama
//     fills "-" or a native-asset symbol on token-less entries), and an
//     address alone is not either; the pair together is a token.
//   `symbol`/`address` are never used on their own to claim a token exists.
function hasToken(p: Proto): boolean {
  if (Boolean(p.gecko_id) || Boolean(p.cmcId)) return true;
  if (typeof p.mcap === "number" && p.mcap > 0) return true;
  const sym = typeof p.symbol === "string" ? p.symbol.trim() : "";
  const addr = typeof p.address === "string" ? p.address.trim() : "";
  if (sym === "" || sym === "-") return false;
  if (addr === "" || addr === "-") return false;
  const contract = addr.includes(":") ? addr.split(":").pop() ?? "" : addr;
  if (contract.length < 10) return false;
  return true;
}

// Normalised project name: lower-cased, version suffixes and generic
// trailing words stripped ("Pendle V2" -> "pendle", "Curve DEX" -> "curve").
// Used to catch a version entry whose tokenised parent is not linked by
// parentProtocol and carries no gecko_id in this snapshot ("Zircuit
// Staking" vs the tokenised "Zircuit").
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+v\d+(\.\d+)?$/i, "")
    .replace(/\s+(dex|amm|finance|protocol|labs|app|exchange|network|finance)$/i, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ageDays(p: Proto, asOfSec: number): number | null {
  if (!p.listedAt || p.listedAt <= 0) return null;
  const d = Math.floor((asOfSec - p.listedAt) / 86400);
  return d >= 0 ? d : null;
}

function ageBucket(age: number | null): string {
  if (age === null) return "unknown";
  if (age < 180) return "0-180d";
  if (age < 365) return "180-365d";
  if (age < 730) return "365-730d";
  if (age < 1100) return "730-1100d";
  return "1100d+";
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function primaryChain(p: Proto): string {
  if (p.chain && p.chain !== "Multi-Chain") return p.chain;
  if (p.chainTvls) {
    let best = "";
    let bestV = -1;
    for (const [c, v] of Object.entries(p.chainTvls)) {
      if (typeof v === "number" && v > bestV && !c.endsWith("-borrowed") && !c.includes("OwnTokens")) {
        best = c;
        bestV = v;
      }
    }
    if (best) return best;
  }
  if (p.chains && p.chains.length > 0) return p.chains[0];
  return "Multi-Chain";
}

function categoryAction(category: string): string {
  const c = category.toLowerCase();
  if (c.includes("lending")) return "supply collateral and borrow against it";
  if (c.includes("dex")) return "swap and provide liquidity in a core pool";
  if (c.includes("yield")) return "deposit into the flagship vault";
  if (c.includes("liquid staking") || c.includes("restaking")) return "stake through the protocol's main pool";
  if (c.includes("derivative")) return "open a small perpetuals position and hold it";
  if (c.includes("cdp")) return "mint the protocol's stable asset against collateral";
  if (c.includes("rwa")) return "take a position in a tokenised asset offering";
  if (c.includes("risk curator") || c.includes("onchain capital")) return "deposit into a curated vault";
  if (c.includes("bridge")) return "bridge assets through the protocol";
  if (c.includes("liquid")) return "provide liquidity to the flagship pool";
  return "use the protocol's flagship product";
}

function farmPlan(p: Proto, chain: string, age: number | null): BoardRow["farm_plan"] {
  const cost = CHAIN_COST[chain] ?? DEFAULT_COST;
  const action = categoryAction(p.category);
  const holdWeeks = age === null ? 12 : age < 180 ? 26 : age < 365 ? 16 : 8;
  const capital =
    p.tvl > 1_000_000_000 ? "$500–$2,000" : p.tvl > 100_000_000 ? "$150–$500" : "$50–$150";
  return [
    { step: 1, title: "Fund a wallet on " + chain, detail: `Set up a fresh wallet on ${chain} and fund it with ${capital} in the chain's native asset plus a stablecoin. Keep this wallet for this protocol only, so any future airdrop is easy to prove.`, cost: cost.bridge + " to bridge in", minutes: cost.minutes },
    { step: 2, title: "Do the core action", detail: `On ${p.name} (${p.url ?? "the protocol's official site — verify the URL from DefiLlama before connecting"}), ${action}. Start with half your capital; confirm the transaction and keep the receipt.`, cost: cost.gas, minutes: 15 },
    { step: 3, title: "Use a second feature", detail: "A second, different interaction (a different pool, vault or market) shows real usage rather than a single one-off deposit. Do it at least a week after step 2.", cost: cost.gas, minutes: 10 },
    { step: 4, title: "One qualifying action a week", detail: `Repeat a small qualifying action weekly — ${action} again, or add/withdraw a little. Consistency over ${holdWeeks} weeks matters more than size.`, cost: cost.gas + " / week", minutes: 5 },
    { step: 5, title: "Check the points page", detail: "If the protocol runs a points or rewards page, connect the same wallet monthly and confirm your activity is counted. Screenshot it each time; if points are missing, raise it with the team before the window closes.", cost: "Free", minutes: 5 },
    { step: 6, title: "Hold the position", detail: `Do not fully exit for at least ${holdWeeks} weeks. Airdrop snapshots reward wallets that were present over time, not wallets that farmed and left.`, cost: "Opportunity cost only", minutes: 0 },
    { step: 7, title: "Exit and log it", detail: "When a token is announced, claim from the protocol's official announcement only, then unwind the position and log dates, amounts and tx hashes. Never sign a claim link from a DM or a search ad.", cost: cost.gas, minutes: 15 },
  ];
}

function main(): void {
  const { input, out } = parseArgs(process.argv.slice(2));
  const { protocols, meta } = loadSnapshot(input);

  // The snapshot's own "as of" moment: the newest listedAt is a safe,
  // deterministic stand-in (the sealed snapshot is dated 2026-11-14; the
  // dev snapshot carries its own snapshot_date). Never Date.now().
  const asOfSec = Math.max(...protocols.map((p) => (p.listedAt && p.listedAt > 0 ? p.listedAt : 0)), 0) || 0;

  // --- 1. Who already trades? Group by parent protocol: a version (V2/V3)
  // inherits its parent's token status, so "Aave V3" is tokenised via AAVE.
  const parentHasToken = new Map<string, boolean>();
  const parentNames = new Map<string, string>();
  for (const p of protocols) {
    if (p.parentProtocol) {
      parentHasToken.set(p.parentProtocol, (parentHasToken.get(p.parentProtocol) ?? false) || hasToken(p));
      parentNames.set(p.parentProtocol, p.name.replace(VERSION_SUFFIX, "").trim());
    }
  }
  const tokenNames = new Set<string>();
  for (const p of protocols) if (hasToken(p)) tokenNames.add(normName(p.name));
  // First-words prefix match: a candidate whose name starts with a
  // tokenised project's normalised name is that project's product.
  function startsWithTokenised(name: string): string | null {
    const words = normName(name).split(" ").filter(Boolean);
    for (let k = Math.min(3, words.length); k >= 1; k--) {
      const prefix = words.slice(0, k).join(" ");
      if (prefix.length >= 4 && tokenNames.has(prefix)) return prefix;
    }
    return null;
  }

  // --- 2. Fit the comps curve on protocols that trade.
  const traders = protocols.filter((p) => hasToken(p) && p.tvl > 0 && (p.mcap ?? 0) > 0);
  const xs = traders.map((p) => Math.log(p.tvl));
  const ys = traders.map((p) => Math.log(p.mcap as number));
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  // R^2 of the fit.
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < xs.length; i++) {
    ssTot += (ys[i] - my) ** 2;
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  // Category medians of mcap/TVL among traders, with a global median.
  const multiplesByCat = new Map<string, number[]>();
  const allMultiples: number[] = [];
  for (const p of traders) {
    const m = (p.mcap as number) / p.tvl;
    if (m > 0 && m < 100) {
      allMultiples.push(m);
      if (!multiplesByCat.has(p.category)) multiplesByCat.set(p.category, []);
      multiplesByCat.get(p.category)?.push(m);
    }
  }
  const globalMedian = median(allMultiples);
  const categoryMultiple = new Map<string, { multiple: number; peers: number }>();
  for (const [cat, arr] of multiplesByCat) {
    const med = median(arr);
    const shrunk = (arr.length * med + SHRINK_K_CATEGORY * globalMedian) / (arr.length + SHRINK_K_CATEGORY);
    categoryMultiple.set(cat, { multiple: shrunk, peers: arr.length });
  }

  // --- 3. Launch odds: empirical token rate by age bucket, shrunk by category.
  const dated = protocols.filter(
    (p) => ageDays(p, asOfSec) !== null && !EXCLUDED_CATEGORIES.has(p.category),
  );
  const bucketRate = new Map<string, { rate: number; n: number }>();
  const bucketCat = new Map<string, Map<string, { tok: number; n: number }>>();
  for (const p of dated) {
    const b = ageBucket(ageDays(p, asOfSec));
    if (!bucketRate.has(b)) bucketRate.set(b, { rate: 0, n: 0 });
    const br = bucketRate.get(b) as { rate: number; n: number };
    br.n += 1;
    br.rate += hasToken(p) ? 1 : 0;
    if (!bucketCat.has(b)) bucketCat.set(b, new Map());
    const cm = bucketCat.get(b) as Map<string, { tok: number; n: number }>;
    if (!cm.has(p.category)) cm.set(p.category, { tok: 0, n: 0 });
    const cell = cm.get(p.category) as { tok: number; n: number };
    cell.n += 1;
    cell.tok += hasToken(p) ? 1 : 0;
  }
  for (const br of bucketRate.values()) br.rate = br.n === 0 ? 0 : br.rate / br.n;
  function launchOdds(p: Proto, age: number | null): number {
    const b = ageBucket(age);
    const base = bucketRate.get(b)?.rate ?? bucketRate.get("1100d+")?.rate ?? 0.4;
    const cell = bucketCat.get(b)?.get(p.category);
    if (!cell || cell.n === 0) return clamp(base, 0.05, 0.95);
    const shrunk = (cell.tok + SHRINK_K_ODDS * base) / (cell.n + SHRINK_K_ODDS);
    return clamp(shrunk, 0.05, 0.95);
  }

  // --- 4. Classify every protocol; build the board.
  const excluded: { id: string; name: string; category: string; tvl_usd: number; reason: string }[] = [];
  const rows: BoardRow[] = [];
  const watchlistNames: string[] =
    (meta.watchlist as string[]).length > 0 ? (meta.watchlist as string[]) : [];
  const seen = new Set<string>();

  for (const p of protocols) {
    const tvl = typeof p.tvl === "number" && p.tvl > 0 ? p.tvl : 0;
    const baseName = p.name.replace(VERSION_SUFFIX, "").trim().toLowerCase();
    const tokenisedPrefix = startsWithTokenised(p.name);
    let reason = "";
    if (hasToken(p)) reason = "already has a token (gecko_id / cmcId / mcap / token symbol+contract recorded)";
    else if (p.parentProtocol && parentHasToken.get(p.parentProtocol)) reason = `version of a tokenised parent (${parentNames.get(p.parentProtocol) ?? p.parentProtocol})`;
    else if (tokenisedPrefix) reason = `product of tokenised project "${tokenisedPrefix}"`;
    else if (tokenNames.has(baseName)) reason = "shares a name with a protocol that already trades";
    else if (EXCLUDED_CATEGORIES.has(p.category)) reason = `category ${p.category} cannot launch a token of its own`;
    else if (WRAPPED_NAME.test(p.name)) reason = "wrapped / staked derivative product";
    else if (tvl < MIN_TVL_USD) reason = `TVL $${Math.round(tvl).toLocaleString("en-US")} below $${MIN_TVL_USD.toLocaleString("en-US")} minimum`;
    else if (!p.name) reason = "no name";
    if (reason) {
      excluded.push({ id: String(p.id ?? p.slug ?? "?"), name: p.name ?? "?", category: p.category ?? "?", tvl_usd: round(tvl), reason });
      continue;
    }
    if (seen.has(p.slug || p.name)) continue;
    seen.add(p.slug || p.name);

    const age = ageDays(p, asOfSec);
    const fitImplied = Math.exp(intercept + slope * Math.log(tvl));
    const cat = categoryMultiple.get(p.category);
    // Primary pricing: TVL x the category's shrunk median mcap/TVL.
    // Categories with no trading peers fall back to the global median.
    const catMultiple = cat ? cat.multiple : globalMedian;
    const catFactor = clamp(catMultiple / globalMedian, CATEGORY_FACTOR_MIN, CATEGORY_FACTOR_MAX);
    const implied = tvl * catMultiple;
    const odds = launchOdds(p, age);
    const expected = implied * odds;
    const growth = typeof p.change_7d === "number" ? clamp(p.change_7d, -50, 200) : 0;
    const breadth = clamp(((p.chains?.length ?? 1) - 1) / 10, 0, 1);
    const growthBonus = clamp(growth / 200, 0, 0.15);
    const breadthBonus = breadth * 0.05;
    const chain = primaryChain(p);
    const peers = cat?.peers ?? 0;
    const confidence: BoardRow["confidence"] =
      peers >= 10 && age !== null ? "high" : peers >= 3 ? "medium" : "low";
    rows.push({
      rank: 0,
      id: String(p.id ?? p.slug),
      name: p.name,
      slug: p.slug ?? "",
      category: p.category,
      chain,
      chains: p.chains ?? [chain],
      tvl_usd: round(tvl),
      tvl_7d_change_pct: typeof p.change_7d === "number" ? round(p.change_7d) : null,
      age_days: age,
      listed_at: p.listedAt ?? null,
      implied_value_usd: round(implied),
      launch_odds: round(odds),
      expected_value_usd: round(expected),
      radar_score: 0, // filled after ranking
      category_multiple: cat ? round(cat.multiple) : round(globalMedian),
      category_peer_count: peers,
      confidence,
      watchlist: false, // filled below
      url: p.url ?? null,
      twitter: p.twitter ?? null,
      model: { fit_implied_usd: round(fitImplied), category_factor: round(catFactor), growth_bonus: round(growthBonus), breadth_bonus: round(breadthBonus) },      farm_plan: farmPlan(p, chain, age),
      why: `${p.name} holds $${(tvl / 1e6).toFixed(1)}M TVL with no token. Peers in ${p.category} trade at a median ${(cat?.multiple ?? globalMedian).toFixed(2)}x TVL (n=${peers}), giving an implied value of $${(implied / 1e6).toFixed(0)}M; protocols of this age launch a token ${(odds * 100).toFixed(0)}% of the time, so the expected launch value is $${(expected / 1e6).toFixed(0)}M.`,
    });
  }

  // Rank by expected value; score 0-100 is a strictly rank-preserving
  // transform of log(expected value), so score order always matches rank
  // order. Growth and breadth are reported per row, not baked into the score.
  rows.sort((a, b) => b.expected_value_usd - a.expected_value_usd || a.name.localeCompare(b.name));
  const logs = rows.map((r) => Math.log(Math.max(r.expected_value_usd, 1)));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  rows.forEach((r, i) => {
    r.rank = i + 1;
    const norm = hi === lo ? 1 : (Math.log(Math.max(r.expected_value_usd, 1)) - lo) / (hi - lo);
    r.radar_score = round(clamp(norm * 100, 1, 100));
  });

  // Watchlist: the snapshot's own list when present, else the top 40 by TVL.
  const wl = new Set<string>();
  if (watchlistNames.length > 0) {
    for (const r of rows) if (watchlistNames.includes(r.slug) || watchlistNames.includes(r.name)) wl.add(r.id);
  } else {
    [...rows].sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 40).forEach((r) => wl.add(r.id));
  }
  for (const r of rows) r.watchlist = wl.has(r.id);

  // Out-of-sample check of the comps curve: fit on the oldest half of
  // traders (by listedAt), test on the newest half; report median abs
  // log-error. Deterministic, computed from the snapshot only.
  const datedTraders = traders.filter((p) => p.listedAt).sort((a, b) => (a.listedAt as number) - (b.listedAt as number));
  let oosMedianAbsLogErr: number | null = null;
  if (datedTraders.length >= 40) {
    const half = Math.floor(datedTraders.length / 2);
    const tr = datedTraders.slice(0, half);
    const te = datedTraders.slice(half);
    const tx = tr.map((p) => Math.log(p.tvl));
    const ty = tr.map((p) => Math.log(p.mcap as number));
    const tmx = mean(tx);
    const tmy = mean(ty);
    let tn = 0;
    let td = 0;
    for (let i = 0; i < tx.length; i++) {
      tn += (tx[i] - tmx) * (ty[i] - tmy);
      td += (tx[i] - tmx) ** 2;
    }
    const ts = td === 0 ? 0 : tn / td;
    const ti = tmy - ts * tmx;
    const errs = te
      .map((p) => Math.abs(Math.log(p.mcap as number) - (ti + ts * Math.log(p.tvl))))
      .sort((a, b) => a - b);
    oosMedianAbsLogErr = round(errs[Math.floor(errs.length / 2)]);
  }

  const board = {
    title: "Token Launch Radar — pre-token protocols ranked by implied launch value",
    model: VERSION,
    generated_from: input,
    snapshot: meta,
    snapshot_as_of_unix: asOfSec,
    excluded_summary: (() => {
      // Coarse keys only — the per-protocol reasons (with TVL amounts)
      // live in excluded.json, not in the board.
      const byReason = new Map<string, number>();
      for (const e of excluded) {
        let key = e.reason;
        if (key.startsWith("TVL $")) key = "below $5,000,000 TVL minimum";
        else if (key.startsWith("version of a tokenised parent")) key = "version of a tokenised parent";
        else if (key.startsWith("product of tokenised project")) key = "product of a tokenised project";
        else if (key.startsWith("category ")) key = "unlaunchable category (CEX / chain / bridge)";
        byReason.set(key, (byReason.get(key) ?? 0) + 1);
      }
      return Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1]));
    })(),
    methodology: {
      comps_fit: `log(mcap) = ${round(intercept)} + ${round(slope)} * log(tvl)`,
      comps_r2: round(r2),
      comps_n: traders.length,
      global_median_mcap_tvl: round(globalMedian),
      category_shrinkage_k: SHRINK_K_CATEGORY,
      odds_shrinkage_k: SHRINK_K_ODDS,
      min_tvl_usd: MIN_TVL_USD,
      out_of_sample_median_abs_log_error: oosMedianAbsLogErr,
      launch_odds_by_age_bucket: Object.fromEntries(
        [...bucketRate.entries()].map(([b, v]) => [b, { rate: round(v.rate), n: v.n }]),
      ),
    },
    counts: {
      protocols_in_snapshot: protocols.length,
      already_tokenised: protocols.filter(hasToken).length,
      ranked: rows.length,
      excluded: excluded.length,
      watchlist: wl.size,
    },
    rows,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "board.json"), JSON.stringify(board, null, 2));
  writeFileSync(join(out, "data.js"), `window.TOKEN_RADAR_BOARD = ${JSON.stringify(board)};\n`);
  writeFileSync(join(out, "excluded.json"), JSON.stringify({ count: excluded.length, excluded }, null, 2));

  // Refresh the dashboard's committed copy when the repo dashboard exists
  // and is writable (local runs). In the grader the repo is read-only, so
  // this is best-effort and never fails the run.
  try {
    const dashData = join(HERE, "dashboard", "data.js");
    if (existsSync(join(HERE, "dashboard"))) {
      writeFileSync(dashData, `window.TOKEN_RADAR_BOARD = ${JSON.stringify(board)};\n`);
    }
  } catch {
    // read-only checkout (grader) — out/ already holds everything.
  }
  // Copy the dashboard's static files into out/ too, so out/ is a complete
  // self-contained deliverable beside board.json.
  try {
    for (const f of ["index.html", "styles.css", "app.js"]) {
      const src = join(HERE, "dashboard", f);
      if (existsSync(src)) cpSync(src, join(out, f));
    }
  } catch {
    // dashboard not built yet — main.ts still exits 0 with board.json.
  }

  // The judge dossier is written last, from what is already in out/: the
  // vendored make.fun library reads out/dashboard/ and out/screenshots/ and
  // writes the canonical dossier.json the gate compares byte for byte.
  cpSync(join(HERE, "dashboard"), join(out, "dashboard"), { recursive: true });
  cpSync(join(HERE, "screenshots"), join(out, "screenshots"), { recursive: true });
  writeFileSync(join(out, "dossier.json"), buildDossier(out, { text_max_bytes: 65_536 }));

  console.log(`token-radar ${VERSION}: ${protocols.length} protocols in snapshot`);
  console.log(`  traders fitted: ${traders.length} (R^2=${round(r2)}, slope=${round(slope)})`);
  console.log(`  ranked: ${rows.length}  excluded: ${excluded.length}  watchlist: ${wl.size}`);
  console.log(`  top 3: ${rows.slice(0, 3).map((r) => `${r.name} ($${(r.expected_value_usd / 1e6).toFixed(0)}M expected)`).join(", ")}`);
  console.log(`  wrote ${out}/board.json, dossier.json, data.js, excluded.json`);
}

main();
