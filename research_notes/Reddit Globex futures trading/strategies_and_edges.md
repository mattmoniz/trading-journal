# Reddit-Claimed Overnight/Globex Futures Trading Strategies and Edges

**CRITICAL METHODOLOGICAL NOTE — read before using anything below.** Reddit.com (all subdomains, including `old.reddit.com`) was **completely inaccessible** to the available research tools for this assignment:
- `WebFetch` returned an explicit error ("Claude Code is unable to fetch from www.reddit.com" / "...from old.reddit.com") for every reddit.com URL attempted, including direct search-result pages and individual subreddit search pages.
- `WebSearch` with `allowed_domains: ["reddit.com"]` returned a hard API error: *"The following domains are not accessible to our user agent"* — meaning reddit.com is blocked at the search-provider level for this tool, not just filtered.
- Roughly 20 varied `WebSearch` queries explicitly targeting Reddit (plain "reddit" keyword, `site:reddit.com`, exact `reddit.com/r/FuturesTrading`, `reddit.com/r/Daytrading` path strings, quoted phrases traders would plausibly use) **never once surfaced a single actual reddit.com URL** in results — only TradingView scripts, Substack newsletters, academy/blog content, and investing.com articles came back, even when the query was Reddit-specific.
- `web.archive.org` (to try an archived/cached Reddit page as a workaround) was also blocked for `WebFetch`.

**Net result: I was not able to read a single actual Reddit post, thread title, comment, or upvote count for this assignment.** I cannot report what r/FuturesTrading, r/Daytrading, r/algotrading, or r/Forex posters specifically said, cannot distinguish detailed methodology posts from vague "I made money overnight" posts, cannot assess upvote/engagement signal, and cannot confirm any claim as "independently mentioned by multiple posters" — all of which were explicit requirements of this task. Every finding below comes from **secondary, non-Reddit sources** (trading-education sites, TradingView script descriptions/comments, Substack trading newsletters, financial-media analysis) that describe the same general concepts retail futures traders discuss. These are included only because they describe the *strategy shapes* the assignment asked about and may be useful as background, but **none of it should be cited as "Reddit traders claim X."** Treat every item below as unconfirmed-as-to-source and flag this gap prominently to the report writer and/or ask for an alternative Reddit-access method (authenticated API, a different fetch tool, or manual verification) before this is presented as research into Reddit sentiment specifically.

---

## What specific overnight/Globex setups or patterns do people claim to trade?

### Takeaway
No Reddit-sourced methodology could be retrieved at all. Secondary (non-Reddit) sources describe several recurring strategy *shapes* that are commonly associated with retail overnight/Globex futures trading discussion generally: Globex/overnight high-low breakout-or-reject plays ("Globex Trap"), Asian-range breakout into the London/NY session, overnight opening-range-breakout (ORB) with Fibonacci projections, and overnight inventory (value-area skew) fades. None of these were confirmed as originating from or being discussed on Reddit specifically.

### Cited Findings
- A "Globex Trap" indicator/strategy description: traders watch price behavior around the Globex session's high and low — breakout trades on a close above the Globex high/below the Globex low, and reversal/fade trades when price tests and rejects the Globex high or low (fails to follow through) — [TradingView script listing](https://my.tradingview.com/script/Vw4vKGtZ-Globex-Trap-w-percentage-SLICKRICK)
- A "Globex Overnight Futures ORB with Fib's" tool is marketed as useful for ES/NQ/CL traders who follow the overnight session to map key levels (an opening-range-breakout framework with Fibonacci extensions) before the RTH open — [TradingView script listing](https://de.tradingview.com/script/6AFuNt2M-Globex-Overnight-Futures-ORB-with-FIB-s-by-TenAMTrader)
- A described approach using auction market theory, volume profile, and delta profile to identify key areas within the ETH (extended trading hours/overnight) session, treating overnight setups as "multi-hour trades" — on ES a cited target range is 15–20+ points, on NQ "over 100 points," with correspondingly wider stops (~5 pts ES, ~30–40 pts NQ) — [TRADEPRO Academy](https://tradeproacademy.com/ultimate-guide-to-trading-futures-overnight/)
- "Overnight inventory" is described as a market-profile-derived metric measuring how much overnight volume trades above vs. below the prior day's 4:15pm ET settlement price; a reading skewed close to 100% toward one side is described as raising the odds of an early-session correction back the other way (i.e., a fade-the-extreme-skew idea) — [ShadowTrader glossary](https://www.shadowtrader.net/glossary/overnight-inventory/)
- The "Asian Range" (described as roughly 7:00 PM–12:00 AM ET) is described as commonly used by NQ/ES traders as a reference liquidity zone: price trading outside this range during US hours is said to "frequently signal the beginning of a strong directional move," and a specific claimed statistic — breaking the Asian range to the upside implies a 71% chance the daily candle closes bullish — was attributed to a poster/account on X (not Reddit) — [Trader Theory on X](https://x.com/tradertheory/status/1950200491515761106)
- A countervailing view in the same search results: "most US-based retail futures traders should *not* actively trade the Asian session on ES or NQ" because "the range is too compressed and the volume is too thin to support most intraday strategies" — source context unclear/unattributed snippet, flagged as low-confidence
- The ICT ("Inner Circle Trader") "Asian Range" framework describes the Asian session high/low as a liquidity target that price is expected to sweep during the subsequent London and New York sessions, with a specific claimed high-probability follow-through window around the "09:50 NY-AM macro" — [Inner Circle Trader tutorial](https://innercircletrader.net/tutorials/ict-asian-range/)
- A "TeamBull Futures" tool description frames the London session (cited as 03:00–09:29 ET) high/low plus the New York opening-range-breakout (09:30–09:45 ET) high/low/midpoint as the reference levels day traders build a plan around — [TradingView script listing](https://es.tradingview.com/script/ussZpxzm-TeamBull-Futures)
- A described overnight-ES strategy combines three pattern filters specifically for the 6PM–11PM ET window: "Candle Body Confluence" (small-body candles flagging consolidation/reversal zones), a 5-bar Williams Fractal for reversal confirmation, and an RSI filter (buy only RSI<35, sell only RSI>65) gated by a minimum ATR threshold to avoid dead/illiquid stretches — [TradingView script listing](https://www.tradingview.com/script/R4FCY2HE-Overnight-ES-Strategy-CBC-Fractal-RSI-ATR-Filter)
- General framing repeated across multiple non-Reddit sources: traders perceive overnight/Globex as having thinner books, so a rally "built almost entirely in Globex" is viewed with suspicion ("thinner liquidity and lower conviction... often lack real support until they prove themselves during the cash session") — i.e., a recurring heuristic is to fade/discount a move that only happened overnight until RTH volume confirms it — unattributed analysis snippet via search aggregation, treat as low-confidence/unsourced
- NQ overnight-range statistics cited (source/methodology unclear): "the overnight low historically gets taken about 3 in 4 times, while the high gets tested about 4 in 10 times" during the subsequent session — unattributed, low-confidence
- Market-profile-style reference levels mentioned as commonly plotted on RTH charts by overnight/Globex traders: ONH (Overnight High), ONL (Overnight Low), ONM (Overnight Midpoint) — [TradingView script description, "Gold IBH/IBL with IBM Overnight Levels"](https://vn.tradingview.com/script/qmkR8FLd-Gold-IBH-IBL-with-IBM-Overnight-Levels-OVM-and-ONVPOC)

### Inferences
- The recurring shapes across independent non-Reddit sources (Globex high/low break-or-reject, Asian/overnight range as a liquidity-sweep target for the next session, overnight-inventory skew as a fade signal, ORB-off-the-overnight-range) match the strategy *categories* this task's prompt anticipated (session-range breaks, inventory/value-area fades, time-of-day windows) — suggesting these are plausible, widely-circulated retail concepts in this space generally, independent of whether Reddit specifically discusses them this way. This is an inference, not a confirmed finding about Reddit content.
- The volume/liquidity caveat ("Asian session too thin for most intraday strategies," "Globex-only rallies lack conviction until RTH confirms") recurring across sources suggests that even among people marketing or writing about overnight strategies, there is an acknowledged tension between "overnight offers big continuation/breakout moves" and "overnight is too illiquid/choppy to trust blindly" — this mirrors the kind of two-sided discussion one would expect on a forum like Reddit, but again, not confirmed as Reddit-specific content.

### Gaps
- **The core objective of this assignment — what Reddit posters specifically say, with real methodological detail vs. vague claims, and which ideas get independently repeated by multiple different posters — could not be answered.** Reddit was completely inaccessible to every tool available (see the top-of-document note). No alternative access path (API key, authenticated session, archive.org proxy) was available to try.
- Could not assess post detail/specificity, upvote counts, or comment-thread depth for any claim, since no actual posts were retrieved.
- Could not determine whether any of the strategy shapes above are actually discussed on r/FuturesTrading, r/Daytrading, r/algotrading, or r/Forex at all, versus being purely a TradingView/education-content phenomenon.

---

## Do people report real differences in how Globex behaves vs. the regular (RTH) session that inform their strategy?

### Takeaway
Non-Reddit sources consistently describe Globex/overnight as lower-volume, lower-liquidity, and (per some sources) more prone to false/unconfirmed moves than RTH — but no Reddit-specific testimony on this could be retrieved, and the few comparative claims found are largely unattributed or come from marketing copy for trading tools/indicators, not from identifiable independent traders.

### Cited Findings
- "RTH carrying the large majority of daily volume in ES and NQ," with Globex described as "the full electronic session (6:00 PM–5:00 PM ET next day)" by contrast — unattributed aggregated snippet, low-confidence source
- "The overnight session is generally slower with less volume trades but is longer than regular trading hours, requiring traders to exhibit patience and usually hold trades for much longer" — [TRADEPRO Academy](https://tradeproacademy.com/ultimate-guide-to-trading-futures-overnight/)
- "Many traders believe that trading the night session is better than trading the day session. With the Asian and European markets in full swing, it seems like there is less algorithmic trading, and the futures seems to have better movement" — attributed generically to "many traders," no identifiable source or platform given in the snippet; treat as a secondhand paraphrase of common trader folklore, not a verified claim
- Computing Initial Balance (IB) off the Globex session rather than the 9:30–10:30 AM ET RTH window is explicitly called out as a mistake ("computing it off Globex makes the level meaningless") — implying some traders discuss/warn against misapplying RTH-session concepts (IB, value area) to the overnight session — unattributed snippet, low-confidence
- A claim that "the majority of the move in SPY since 1993 has been in the overnight session" is repeated across multiple aggregator/newsletter sources as a justification for overnight-focused strategies — this is a well-known academic/quant finding (close-to-open vs. open-to-close return decomposition) rather than a Reddit claim; cited here as background only — [TradingView chart annotation](https://il.tradingview.com/chart/MES1%21/YOzR7DNG-The-overnight-gap-up-on-SPY); similar framing in [Investing.com analysis](https://investing.com/analysis/is-globex-a-better-trade-than-day-session-most-of-the-time-200209727)

### Inferences
- The liquidity/volume contrast (RTH >> Globex volume) is uncontroversial and matches publicly known exchange volume profiles, so it's reasonable to assume any real Reddit discussion of overnight futures trading references this same basic fact — but this is an inference based on general market knowledge, not a retrieved Reddit post.

### Gaps
- No Reddit-specific commentary on RTH-vs-Globex differences (trend persistence, mean-reversion tendency, specific volatility comparisons) could be retrieved at all.
- Could not confirm whether retail Reddit traders discuss the overnight/RTH volume-decomposition academic literature (e.g., overnight-drift research) or arrived at similar conclusions independently through their own observation.

---

## Are there recurring, independently-mentioned ideas across multiple different posters/threads (a sign of real shared knowledge)?

### Takeaway
This question cannot be answered — it requires reading actual multiple independent Reddit posts/threads, which was not possible. No finding in this report should be read as evidence of cross-poster consensus on Reddit.

### Cited Findings
- None available — no Reddit threads or posts were retrieved.

### Inferences
- None — any inference here would require the underlying Reddit data this report could not obtain.

### Gaps
- **Fully unresolved.** This was one of the four explicit "key questions" in the assignment and could not be investigated at all given the tool access constraints documented above.

---

## What instruments, timeframes, and risk parameters do people typically mention for overnight futures trading?

### Takeaway
Non-Reddit sources (trading-education content and tool/indicator marketing copy) most commonly reference ES and NQ (and their micro counterparts MES/MNQ by implication, though not explicitly named in retrieved sources) for overnight/Globex strategies, with 15-minute/30-minute charts and point-based stops cited as typical — but again, no confirmation this reflects actual Reddit-poster consensus.

### Cited Findings
- Recommended chart timeframe for an overnight-ES pattern strategy: "15-minute or 30-minute candles for ES Mini or NQ Mini," with an ATR threshold of "around 5.0... as a starting point for ES Mini on 15m" used as a volatility filter — [TradingView script listing](https://www.tradingview.com/script/R4FCY2HE-Overnight-ES-Strategy-CBC-Fractal-RSI-ATR-Filter)
- Stop-size guidance for overnight/Globex multi-hour setups: roughly 5 points on ES, and 30–40 points on NQ, reflecting NQ's larger overnight range (cited target magnitude: 15–20+ ES points, 100+ NQ points) — [TRADEPRO Academy](https://tradeproacademy.com/ultimate-guide-to-trading-futures-overnight/)
- An overnight-ES strategy is explicitly scoped to the 6PM–11PM ET window specifically (not the full overnight session through the next RTH open), described as targeting the "volatility-rich, low-liquidity evening" period rather than the quieter pre-dawn hours — [TradingView script listing](https://www.tradingview.com/script/R4FCY2HE-Overnight-ES-Strategy-CBC-Fractal-RSI-ATR-Filter)
- Other futures beyond equity index are mentioned in session-timing contexts (crude oil/CL, gold/GC, treasuries ZN/ZB, grains ZS/ZW) primarily in the context of each product's own distinct Globex session start time rather than instrument-specific overnight strategy detail — [TradingView "Futures Globex Session" script description](https://it.tradingview.com/script/E7DUpGpP-Futures-Globex-Session)

### Inferences
- The consistent emphasis on ES/NQ (not MES/MNQ specifically, nor other products) across the handful of retrievable sources suggests overnight/Globex strategy content skews toward full-size index futures discussion in the material that is indexed/discoverable via general web search — but this cannot be generalized to what's actually posted on Reddit, where retail traders (especially smaller accounts) might discuss the micro contracts (MES/MNQ) more, consistent with this project's own context of MNQ micro trading.

### Gaps
- No Reddit-specific risk-parameter discussion (position sizing, dollar stop amounts, R-multiples) was retrieved.
- Could not confirm whether MES/MNQ (as opposed to full-size ES/NQ) get distinct overnight-strategy discussion anywhere, Reddit or otherwise — the retrieved sources only referenced full-size contracts or were generically about "futures."
- No crude oil, gold, or bond-futures-specific overnight *strategy* detail was found (only session-timing references) — the assignment's secondary interest in "other futures with transferable overnight-session insights" is essentially unaddressed.

---

## Overall assessment for the report writer

This research task could not be substantively completed as scoped. **Reddit.com was unreachable by every available tool** (WebFetch explicitly refused all reddit.com/old.reddit.com URLs; WebSearch's domain-restriction feature rejected reddit.com outright as inaccessible to its user agent; and ~20 unrestricted WebSearch queries explicitly phrased to surface reddit.com URLs returned zero reddit.com links across the board, only third-party sites). I was also unable to reach web.archive.org as a workaround.

Everything compiled above is from non-Reddit secondary sources (TradingView script marketplace descriptions, trading-education sites, Substack trading newsletters, one X/Twitter post) that describe generically similar strategy concepts, and **none of it satisfies the assignment's core requirements**: distinguishing detailed-methodology posts from vague claims, identifying cross-poster/cross-thread repetition as a signal of shared community knowledge, or reporting what specific named subreddits (r/FuturesTrading, r/Daytrading, r/algotrading, r/Forex) actually contain. I'd recommend flagging this to the user/coordinator explicitly — either a different Reddit-access method is needed (official Reddit API/OAuth, a different browsing tool, or a manual export of specific thread URLs the user already has), or this sub-report should be treated as providing only generic background context rather than the Reddit-specific findings that were requested.
