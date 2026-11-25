# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kalidefi/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kalidefi/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar that ranks every DefiLlama protocol that still has no
token by what its launch could be worth — and shows a reader how to farm each
one. An entry for make.fun's
[“Build the best token launch radar”](https://make.fun/bounty/token-radar-01)
bounty ($1,325, 10 places; 1st $1,000; closes Mon 14 Dec 2026, 10:00 UTC).

## What it does

`main.ts` reads a DefiLlama protocol snapshot, finds every protocol that
still records no token and is not a wrapped / staked / versioned product of
one that already trades, prices each one against the protocols that do trade,
and writes a ranked board with a 7-step farm plan per protocol:

- `board.json` — the ranked board (215 rows on the 2026-11-25 dev snapshot:
  the whole watchlist plus every other rankable pre-token protocol), with the
  fitted curve, its validation, the launch odds and the model block
- `dossier.json` — the canonical dossier the judge reads (dashboard source + screenshots), written by the kit's `buildDossier` library
- `dashboard/` — a static, sortable, filterable board that renders with no
  network: KPI strip, search, category / chain / confidence / watchlist
  filters, a detail view per protocol (peer chart + farm plan), a personal
  watchlist, a methodology panel and an audit of everything left off the board
- `out/excluded.json` — every protocol left off the board, with one reason each

## The model (`radar-1`)

Priced on every run from the snapshot's own figures — never from a hardcoded
list of names or values:

```
implied value  = TVL × category median mcap/TVL   (shrunk toward the global
                                                    median, shrinkage k=5)
launch odds    = empirical token rate of dated protocols in the same age
                 bucket (0–180d, 180–365d, 365–730d, 730–1100d, 1100d+),
                 shrunk toward the bucket rate by category (k=8)
expected value = implied value × launch odds
radar score    = 0–100, a rank-preserving transform of log(expected value)
```

A log-log OLS fit of log(market cap) on log(TVL) over the trading protocols
is computed on every run as a validation cross-check and reported in
`board.json` (on the dev snapshot: `log(mcap) = 9.21 + 0.31·log(TVL)`,
R² 0.25, n=613, out-of-sample median |log error| 1.48). It is not used for
ranking, because its slope is flattened by tiny-cap tokens; the category
multiples carry the pricing.

**How "has a token" is decided.** A protocol counts as tokenised when
DefiLlama records a CoinGecko id, a CoinMarketCap id, a market cap — or a
token symbol *plus* a token contract address. That last signal matters:
DefiLlama sets `gecko_id` only on a project's main entry, which often is not
in the list at all, but every version entry ("Pendle V2", "Curve DEX",
"GMX EVM", "Aave V3") still carries its parent's token symbol and contract.
A symbol alone is not enough, and neither is an address alone. On top of
that, versions are caught by `parentProtocol` grouping and by a
name-prefix check against tokenised projects ("Zircuit Staking" vs "Zircuit"),
and CEX / chain / bridge / wrapped-asset categories are excluded outright.
Minimum TVL: $5,000,000.

**Top of the board** (dev snapshot, 2026-11-25):

| # | Protocol | Category | TVL | Implied | Odds | Expected |
|---|----------|----------|-----|---------|------|----------|
| 1 | Polymarket International | Prediction Market | $321M | $1,168M | 63% | $731M |
| 2 | Veda | Onchain Capital Allocator | $1,426M | $1,893M | 29% | $548M |
| 3 | Sentora Curator | Risk Curators | $2,672M | $3,571M | 14% | $503M |
| 4 | Steakhouse Financial | Risk Curators | $2,534M | $3,386M | 14% | $477M |
| 5 | Gauntlet | Risk Curators | $1,571M | $2,100M | 14% | $296M |

## Run it

Requires Node.js 22.18 or later (tested on Node v24.22.1). No dependencies,
no network, no secrets.

```sh
node main.ts                          # reads ./input/snapshot.json, writes ./out/
node main.ts --input snap.json --out out/
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts   # grader mode
```

Then open `dashboard/index.html` in a browser — it renders with no network.
`main.ts` also refreshes `dashboard/data.js` when the dashboard is writable;
in a read-only checkout (the grader) it writes everything to the output
directory instead and still exits 0.

Two runs on the same snapshot produce byte-identical `board.json` and
`dossier.json` (verified — see below). The run is deterministic: no clock,
no randomness, no network.

## Data provenance

- Dev snapshot: DefiLlama's public protocol API
  (`https://api.llama.fi/protocols`, no key), fetched 2026-11-25, trimmed to
  the fields `main.ts` reads and saved as `input/snapshot.json` (9,110
  protocols). The raw fetch is kept as `input/snapshot-raw.json`.
- The grader re-runs `main.ts` on its own sealed snapshot dated 2026-11-14
  (`/input/snapshot.json`, 758 protocols) — the board it produces will differ
  from the dev board, and that is by design: the model is fitted from
  whichever snapshot it is given.
- Implied and expected values are model estimates from that snapshot, not
  prices and not a prediction that a token will launch. A protocol may never
  issue a token. This is not financial advice.

## Verification (done 2026-11-25)

- `node main.ts` exits 0 on the dev snapshot: 215 ranked rows, 40 watchlist,
  8,895 excluded with reasons; top 3 as above.
- Determinism: two runs → byte-identical `board.json` and `dossier.json`.
- Grader mode (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`) exits 0 and writes
  all four outputs; a read-only copy of the repo also exits 0.
- Robustness: on a synthetic 400-protocol array-format snapshot (the sealed
  snapshot's exact shape is unknown) it still ranks 102 rows and exits 0.
- `node --check dashboard/app.js` passes; `dashboard/data.js` loads and
  carries 215 rows. The dashboard loads no external resources (no CDN, no
  fonts, no analytics; the only outbound links are per-protocol official-site
  links the user clicks).
- Board invariants checked: ranks 1..n, sorted by expected value, score
  monotonic in rank, every row has a 7-step farm plan.

## Known limits

- DefiLlama data can lag: a protocol listed as pre-token may have launched
  since the snapshot date, and a version entry can slip through when neither
  its parent nor its name links it to a token (e.g. an obscure fork). The
  audit panel names everything excluded; nothing is silently dropped.
- A few ranked rows are judgement calls, not errors: USDD (a stablecoin, in
  CDP) and Lightning Network (payments) have no token but are unusual
  "launch candidates". The model ranks by the numbers; the detail view shows
  the reasoning so a reader can disagree.
- The dev snapshot is live (2026-11-25), not the sealed 2026-11-14 snapshot
  the grader uses — expect a different board at grading time.

## What is still missing to submit (do not skip)

1. **The make.fun kit** (`vendor/makefun-board.ts`) is included, and
   `dossier.json` is the canonical `buildDossier` output, regenerated by
   `main.ts` on every run. Re-run `main.ts` afterwards and re-check the
   outputs.
2. **Screenshots** (`screenshots/`): the board, a protocol's detail view and
   a filtered view. No browser was available in this session, so none were
   taken. Open `dashboard/` in Chrome/Firefox, take the three, save as PNG.
3. **GitHub repository**: create a *new* public repo (after 2026-11-14) —
   proposed name `token-radar` under `@kalidefi` — push this tree, set the
   About (website `https://make.fun/bounty/token-radar-01`, topics
   `makefun, ai-agents, bounties, trading`), and add `.makefun/owner.json`
   with the account wallet. The full wallet address is needed: only the
   truncated form `BvNG…R8hv` is on file here, so it was deliberately **not**
   written — do not guess it.
4. **Transcripts**: bundle the agent sessions that built this entry with the
   kit CLI (`node cli/makefun.mjs bundle …`), including this session and its
   parent, plus the system prompt and run record.
5. **Submit** with the kit CLI before Mon 14 Dec 2026 10:00 UTC, signing the
   entry message with a wallet on the make.fun account
   (`@kali-defi-2` / wallet `BvNG…R8hv`). Nothing in this tree has been
   submitted, signed, posted or funded.

## Disclaimer

Model estimates only. Not financial advice, not a prediction that any
protocol will issue a token, and not an offer to sell any security.

---

Entered on [make.fun](https://make.fun/?ref=qr288bqj&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
