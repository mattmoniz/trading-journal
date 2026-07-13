import React from 'react';
import InfoTooltip from '../components/shared/InfoTooltip.jsx';
import FetchStamp from '../components/shared/FetchStamp.jsx';

const API_URL = '/api';

const PLAYBOOK_SECTIONS = [
  {
    id: 'bracket',
    title: 'Bracket Environment',
    color: '#3b82f6',
    tag: 'BRACKET',
    tagColor: '#3b82f6',
    subtitle: 'Responsive strategy — fade the extremes',
    source: 'Dalton (Markets in Profile) + Steidlmayer',
    context: 'A bracket forms when the market has found accepted value and is rotating between a defined high and low. Value areas overlap day after day. This is the dominant market condition — roughly 75% of all trading time. Neither buyers nor sellers are committing directionally.',
    rules: [
      { rule: 'Buy near VAL, sell near VAH', detail: 'The bracket edges are your targets AND your entry zones. VAL (value area low) is where buyers have stepped in historically — that is where responsive buyers enter. VAH (value area high) is where sellers have stepped in. Trade toward the opposite edge, not beyond it.' },
      { rule: 'Do NOT hold breakouts', detail: '75% of breakout attempts in a bracket fail and snap back. When price breaks above VAH, the most likely scenario is a return to VAH or below. The breakout traders get faded by responsive sellers. Wait for confirmation before treating a breakout as real.' },
      { rule: 'Reduce size on A signals', detail: 'An A Up signal inside a bracket has significantly lower follow-through than an A Up in a trending environment. The bracket\'s structural resistance dampens the move. Trade A signals with 50-75% of normal size until the bracket confirms a break.' },
      { rule: 'Target the midpoint', detail: 'If you buy VAL, target the POC (point of control) first, then the VAH. Do not expect a full bracket range move in one session. The POC is the gravitational center — price rotates around it and often stalls there.' },
      { rule: 'Watch for bracket compression', detail: 'If value areas are getting narrower each day (VAH-VAL spread shrinking), the market is compressing energy. A significant breakout is building. Do not predict the direction but prepare to act fast when it comes.' },
    ],
    warning: 'The most dangerous bracket condition: when NL30 is bullish AND value is migrating higher AND the week looks like a trend — but the bracket has not confirmed. This is where trend traders get blown out. Everything tells you to buy the breakout. The bracket snaps it back. You try again. Same result. Three stops later the structural story still sounds right but your account is down. Dalton specifically calls this out: the bracket that looks like it should break but doesn\'t is the most consistently costly condition in market profile trading.',
    setup: 'Best setup: fade the first extension beyond VAH or VAL in the first 30 minutes if the OR is narrow (NORMAL or NARROW condition). The first push is often the entry point.',
  },
  {
    id: 'trending-up',
    title: 'Trending Up Environment',
    color: '#22c55e',
    tag: 'TRENDING UP',
    tagColor: '#22c55e',
    subtitle: 'Initiative strategy — go with extensions',
    source: 'Dalton + Fisher (The Logical Trader)',
    context: 'Value areas are migrating higher consistently — the market is accepting higher prices. OTF (other timeframe) buyers are in control and are consistently willing to transact at elevated levels. NL30 above +9 confirms multi-session structural support for longs.',
    rules: [
      { rule: 'Buy pullbacks to prior day VAH', detail: 'In a trend, prior resistance becomes support. Yesterday\'s VAH is today\'s buy zone. Price pulls back to it, finds buyers, and extends higher. This is the highest-quality entry in a trending environment — you have structure behind you and a defined stop level.' },
      { rule: 'Do NOT short into strength', detail: 'Countertrend fades in a trend get destroyed. Every time price makes a new high and you short, you are fighting OTF buyers who have unlimited capital and a structural thesis. Your structural edge is zero on the short side. Reserve shorts for when the trend breaks.' },
      { rule: 'A Down signals have high failure rate', detail: 'In a bullish NL30 (+9) environment, A Down signals fail significantly more often than in neutral conditions. Sellers try, fail, and price recovers. If you trade A Downs in a bull trend, use minimal size and exit quickly on any stall.' },
      { rule: 'Hold A Up signals longer', detail: 'In a trending environment, A Up + C confirmation is the highest-conviction setup available. The structure is aligned — pre-market bias, number line, and value migration all support the move. Hold these past initial targets. Trail stops to prior session VAH.' },
      { rule: 'NL30 alignment is the multiplier', detail: 'When NL30 > +9 AND value is migrating higher AND you have an A Up signal, all three timeframes agree. Fisher: this is the condition where the trade is most likely to exceed its initial target. Size up to normal (not more — structure supports but does not guarantee).' },
    ],
    warning: 'The biggest trap in a trend: giving back gains by over-staying. A trend that is showing absorption (heavy volume, narrow range, close off the high) is warning you. The first profile shape that goes FAT after a series of elongated ones is the earliest sign the trend is slowing.',
    setup: 'Best setup: Open Drive in the trend direction + A signal confirmation within the first hour. The OD tells you OTF is committed from the open; the A signal gives you the structural entry level with a defined stop.',
  },
  {
    id: 'trending-down',
    title: 'Trending Down Environment',
    color: '#ef4444',
    tag: 'TRENDING DOWN',
    tagColor: '#ef4444',
    subtitle: 'Initiative strategy — go with extensions downward',
    source: 'Dalton + Fisher (The Logical Trader)',
    context: 'Value areas are migrating lower. OTF sellers are in control. NL30 below -9 confirms multi-session structural support for shorts. The same principles as trending up apply in reverse.',
    rules: [
      { rule: 'Sell rallies to prior day VAL', detail: 'Prior support flips to resistance in a downtrend. Yesterday\'s VAL is today\'s sell zone. Price rallies into it, finds sellers, and extends lower. This is your structural entry with a defined stop above the VAL.' },
      { rule: 'Do NOT buy dips expecting a bounce', detail: 'Countertrend longs in a downtrend lose money systematically. OTF sellers will press every rally. Your structural edge is zero on the long side during a confirmed downtrend.' },
      { rule: 'A Up signals have high failure rate', detail: 'In a bearish NL30 environment, A Up signals fail significantly more often. Buyers try, get absorbed, and price reverses lower. Skip or trade with minimal size.' },
      { rule: 'Failed A Down signals are extra powerful', detail: 'In a downtrend, when price reaches A Down and then reverses up — that failed A Down often leads to a quick recovery that gets sold again. Sellers come back. The failure does not mean the trend changed.' },
      { rule: 'Hold A Down + C confirmation', detail: 'A Down fired + C Down confirmed in a bearish NL30 environment is the highest-conviction short setup. Trail stops to prior session VAL on the way down.' },
    ],
    warning: 'Catching falling knives: the most common mistake is buying into a downtrend looking for "cheap" prices. Dalton specifically addresses this — price can always go lower and value can always migrate lower. There is no objective "oversold" in a trending market.',
    setup: 'Best setup: gap below prior VAL on the open (Open Drive lower) + A Down signal within the first hour. The gap tells you overnight sellers committed; the A signal gives you the structural entry.',
  },
  {
    id: 'transitional',
    title: 'Transitional Environment',
    color: '#fbbf24',
    tag: 'TRANSITIONAL',
    tagColor: '#fbbf24',
    subtitle: 'Reduce size 50%+ — only the most obvious setups',
    source: 'Dalton + Steidlmayer (Mind Over Markets)',
    context: 'The 5-day and 10-day structure disagree. Either a bracket is breaking into a trend, or a trend is exhausting into a bracket. Neither strategy works cleanly. This is the most dangerous condition — strategies that worked in the prior regime stop working before the new direction confirms.',
    rules: [
      { rule: 'Bracket → Trend: wait for confirmed VA migration', detail: 'When a bracket breaks, the temptation is to chase the breakout. Do not. Wait for the first day where value MIGRATES (VAH-POC-VAL all establish above/below prior day). That is the first confirmed step of a new trend. Then buy the pullback to the new VAH — not the breakout.' },
      { rule: 'Bracket → Trend: use NL30 as the deciding vote', detail: 'If NL30 is above +9 and a bullish breakout is developing, the trend has multi-session structural backing — higher conviction. If NL30 is ranging and the bracket breaks, the move is less reliable. The A signal in the breakout direction is your entry confirmation.' },
      { rule: 'Trend → Bracket: stop adding to trend positions', detail: 'The first sign of regime change is the trend\'s reliable setups starting to fail. If A signals in the trend direction are failing 2-3 consecutive times, the trend is exhausting. Stop adding. Tighten stops on existing positions. Do not add contracts.' },
      { rule: 'Trend → Bracket: look for failed A signals as confirmation', detail: 'Failed A signals are the first technical confirmation that the trend is shifting to balance. When the trend\'s entry signal (A Up in an uptrend, A Down in a downtrend) starts failing consistently, the regime has changed. Shift to responsive strategy.' },
      { rule: 'Wait for the 10:00-10:30 window', detail: 'In transitional conditions, the opening often does not give clear direction. The 10:00-10:30 window is when the session\'s character becomes clearer. If no A signal has fired by 10:30, the day is likely going auction/rotational — set tighter targets and reduce size further.' },
    ],
    warning: 'The most costly losses in transitional environments come from traders who see a bullish structural backdrop (NL30 green, value migrating up, trend week) and size up like it\'s a clean trend — when it\'s actually a bracket in transition. The bracket punishes breakout buyers repeatedly because the structural story always feels right. Each failed breakout costs a full stop. The confirmation requirement — value migrating above prior VAH for a full session — is the only protection against this trap.',
    setup: 'Best setup in transitional conditions: wait for the Opening Range to form. An ORR (Open Rejection Reverse) opening is most common in transitional states — it tests one direction, finds rejection, and reverses. The reversal direction often indicates which regime is winning.',
  },
  {
    id: 'opening-types',
    title: 'Opening Call Types',
    color: '#a78bfa',
    tag: 'OPENING READS',
    tagColor: '#a78bfa',
    subtitle: 'Reading the first 15 minutes',
    source: 'Steidlmayer (Market Profile Handbook)',
    context: 'The opening call classifies the first 15 minutes of the session. It tells you how OTF participants are positioning at the open and sets the tone for the entire session.',
    rules: [
      { rule: 'Open Drive (OD)', detail: 'Price immediately extends one direction from the open with no pullback. High directional conviction. OTF is committed from the start. Trade with the drive — do not fade. An A signal in the drive direction is high conviction. This is the most powerful opening type.' },
      { rule: 'Open Test Drive (OTD)', detail: 'Price tests one side of the OR (or prior VA), finds no acceptance, then drives hard the other direction. The initial test is the "tell" — that side had no conviction. The drive after the test is the real direction. Trade the drive side.' },
      { rule: 'Open Rejection Reverse (ORR)', detail: 'Price opens, extends beyond one edge of prior value, gets rejected, and reverses back inside value. The rejection confirms that side (above VAH or below VAL) had no acceptance. Fade the initial extension back toward the POC or opposite edge. Responsive play.' },
      { rule: 'Open Auction (OA)', detail: 'Price rotates within or near the OR, testing both sides without committing. Neither buyers nor sellers have conviction at the open. Two-sided, rotational day likely. Set tight targets, expect price to keep rotating. Wait for an A signal before taking directional risk.' },
    ],
    warning: 'Opening type is a condition, not a signal by itself. An Open Drive is only a trade if combined with structural alignment (pre-market bias, NL30, A signal). The opening call CONFIRMS or CONTRADICTS your pre-market read — it does not replace it.',
    setup: '',
  },
  {
    id: 'acd-by-nl',
    title: 'ACD Signals by NL30 State',
    color: '#06b6d4',
    tag: 'ACD CONTEXT',
    tagColor: '#06b6d4',
    subtitle: 'Signal quality changes with the trend',
    source: 'Fisher (The Logical Trader)',
    context: 'The same A signal has different quality depending on the NL30 state. Fisher explicitly showed this: an A Up in a +12 NL30 environment is fundamentally different from an A Up in a -6 NL30 environment.',
    rules: [
      { rule: 'NL30 > +9: A Up is high conviction', detail: 'The 30-session trend is confirmed bullish. OTF buyers have been reliably showing up for a month. An A Up in this environment has structural multi-timeframe support. Hold longer, use normal size, target above initial OR extension targets.' },
      { rule: 'NL30 > +9: A Down is low conviction', detail: 'Selling against a confirmed bullish trend. Sellers have been losing the monthly battle. A Down signals fail frequently — the buyers absorb the initial breakdown. If you trade A Downs here, use 25-50% of normal size and exit on any stall.' },
      { rule: 'NL30 ranging (-9 to +9): trade both but reduce size', detail: 'No multi-session directional edge. Both A Up and A Down signals are lower conviction than in a trending NL30 environment. Day-trade only — do not hold overnight based on ACD alone. Size down 25-50%.' },
      { rule: 'NL30 < -9: A Down is high conviction', detail: 'Confirmed bearish trend. Sellers have dominated 30 sessions. A Down + C confirmation has the highest structural support. Hold longer, target below initial levels.' },
      { rule: 'NL10 diverging from NL30: early warning', detail: 'When NL30 is bullish (+9) but NL10 is negative, shorter-term momentum is working against the trend. This is not a reversal signal — it is a reason to reduce size on longs and tighten stops. Do not add contracts when NL10 diverges negatively.' },
    ],
    warning: 'The NL30 is only as good as the data feeding it. If you have missed logging A and C signals for multiple sessions, the number will be inaccurate. Check data quality (logged days count) before trusting the reading.',
    setup: '',
  },
];

function SetupPriorityReference() {
  const [ref, setRef] = React.useState(null);
  const [expanded, setExpanded] = React.useState(true);
  React.useEffect(() => {
    fetch(`${API_URL}/setups/playbook-reference`).then(r => r.json()).then(setRef).catch(() => {});
  }, []);

  const alignedRate  = ref?.aSignalAligned?.winRateNLAbove9;
  const counterRate  = ref?.aSignalCounter?.winRate;
  const alignedN     = ref?.aSignalAligned?.totalSignals;
  const counterN     = ref?.aSignalCounter?.totalSignals;

  const toStarsEl = (n) => {
    const sc = n === 3 ? '#22c55e' : n === 2 ? '#f59e0b' : '#94a3b8';
    return <span style={{ color: sc, fontWeight: 700, letterSpacing: '0.05em' }}>{'★'.repeat(n)}{'☆'.repeat(3-n)}</span>;
  };

  const SETUPS = [
    { rank: 1,  name: 'TRT + MAH',                dir: 'LONG / SHORT', stars: 3, winRate: null,            note: 'Rarest, highest edge. A signal fails + MAH trapped buyers/sellers. Counter-move accelerates.' },
    { rank: 2,  name: 'TRT V2 (early trigger)',    dir: 'LONG / SHORT', stars: 3, winRate: null,            note: 'A signal fires, no C in same direction, price crosses back through OR. Earlier entry than classic TRT.' },
    { rank: 3,  name: 'TRT Classic',               dir: 'LONG / SHORT', stars: 2, winRate: null,            note: 'Classic A signal failure. Bulls/bears show up, fail, reversal follows.' },
    { rank: '4a', name: 'A Up Strong',             dir: 'LONG',         stars: 3, winRate: alignedRate,     note: `Immediate drive, price holds cleanly above OR High. NL30-aligned: ${alignedRate != null ? (alignedRate*100).toFixed(0)+'%' : '—'} win rate (n=${alignedN ?? '—'}). Fisher: the most definitive signal.` },
    { rank: '4b', name: 'A Down Strong',           dir: 'SHORT',        stars: 3, winRate: alignedRate,     note: `Price drives cleanly below OR Low, holds without pullback. NL30-aligned: ${alignedRate != null ? (alignedRate*100).toFixed(0)+'%' : '—'} win rate. Counter-trend: use reduced size.` },
    { rank: 5,  name: 'Open Test Drive',           dir: 'LONG / SHORT', stars: 2, winRate: null,            note: 'Price probes one direction 10+ pts in first 15 bars, reverses through OR. The probe direction had no acceptance.' },
    { rank: '6a', name: 'A Up Weak',               dir: 'LONG',         stars: 1, winRate: counterRate,     note: `Slow grind to A Up level, stalls. Watch for failure. Counter-trend rate: ${counterRate != null ? (counterRate*100).toFixed(0)+'%' : '—'} (n=${counterN ?? '—'}). Tighter targets.` },
    { rank: '6b', name: 'A Down Weak',             dir: 'SHORT',        stars: 1, winRate: counterRate,     note: `Slow grind to A Down, lacks conviction. Higher failure rate in bull NL30. Tighter targets, no overnight hold.` },
    { rank: 7,  name: 'IB Confirmation',           dir: 'LONG / SHORT', stars: 2, winRate: null,            note: 'IB High/Low breakout with structure behind it. Entry at the IB edge, stop inside the IB.' },
    { rank: 8,  name: 'Open Drive Continuation',  dir: 'LONG / SHORT', stars: 2, winRate: null,            note: 'Strong directional gap that holds. OTF committed from the open. Continuation in drive direction.' },
    { rank: '9a', name: 'C Up + C Down (paired)', dir: 'LONG / SHORT', stars: 2, winRate: null,            note: 'Bar closes above OR High (C Up) after A signal. Full +4 ACD score. Fisher: C confirms absorption of counter-move. Highest conviction day type when combined with A signal.' },
    { rank: '9b', name: 'C Reversal',              dir: 'LONG / SHORT', stars: 2, winRate: null,            note: 'C fires in opposite direction of prior A signal failure. Confirms the premise reversed.' },
    { rank: 10, name: 'Failed Auction at Key Level', dir: 'LONG / SHORT', stars: 1, winRate: null,          note: 'Price tests a key structural level (VAH/VAL/bracket edge), fails to accept, reverses.' },
    { rank: 11, name: 'Bracket Breakout Confirmation', dir: 'LONG / SHORT', stars: 2, winRate: null,       note: 'Price accepts outside the bracket range for a full session. Structural regime change.' },
    { rank: 12, name: 'Value Area Responsive',     dir: 'LONG / SHORT', stars: 1, winRate: null,            note: 'Fade VAH/VAL edges inside a bracket. Lower confidence — bracket condition required for edge.' },
    { rank: 13, name: 'C Standalone',              dir: 'LONG / SHORT', stars: 1, winRate: null,            note: 'Bar closed above/below OR but no A signal ever fired. Half conviction. Lower follow-through probability.' },
  ];

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 20px', marginBottom: 20 }}>
      <button onClick={() => setExpanded(e => !e)}
        style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0, marginBottom: expanded ? 14 : 0 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'left' }}>Setup Priority Reference — All 13 Setups</div>
          <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 2, textAlign: 'left' }}>
            Ranked by edge quality. A Up/Down win rates from ACD backtest.
            {alignedRate != null && ` NL-aligned: ${(alignedRate*100).toFixed(0)}% · Counter: ${counterRate != null ? (counterRate*100).toFixed(0)+'%' : '—'}`}
          </div>
        </div>
        <span style={{ color: '#cbd5e1', fontSize: 13 }}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                {['#', 'Setup', 'Dir', 'Stars', 'Win Rate', 'Notes'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#cbd5e1', fontWeight: 700, fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SETUPS.map((s, i) => {
                const isLong  = s.dir === 'LONG';
                const isShort = s.dir === 'SHORT';
                const dirColor = isLong ? '#22c55e' : isShort ? '#ef4444' : '#94a3b8';
                const rowBg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)';
                return (
                  <tr key={s.rank} style={{ borderBottom: '1px solid var(--border-color)', background: rowBg, verticalAlign: 'top' }}>
                    <td style={{ padding: '8px 10px', color: '#94a3b8', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>{s.rank}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{s.name}</td>
                    <td style={{ padding: '8px 10px', color: dirColor, fontWeight: 600, whiteSpace: 'nowrap', fontSize: 12 }}>{s.dir}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{toStarsEl(s.stars)}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                      {s.winRate != null
                        ? <span style={{ color: s.winRate >= 0.55 ? '#22c55e' : s.winRate >= 0.45 ? '#f59e0b' : '#ef4444', fontWeight: 700 }}>{(s.winRate * 100).toFixed(0)}%</span>
                        : <span style={{ color: '#94a3b8' }}>—</span>
                      }
                    </td>
                    <td style={{ padding: '8px 10px', color: '#94a3b8', lineHeight: 1.5, maxWidth: 400 }}>{s.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', marginBottom: 4 }}>A SIGNAL NL30 SPLIT ({alignedN ?? '—'} NL-aligned · {counterN ?? '—'} counter-trend signals tracked)</div>
            <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7 }}>
              NL-aligned (A Up in bull NL30 / A Down in bear NL30): <strong style={{ color: '#22c55e' }}>{alignedRate != null ? (alignedRate*100).toFixed(0)+'%' : '—'}</strong> win rate when NL30 &gt; +9
              &nbsp;·&nbsp;
              Counter-trend: <strong style={{ color: '#f59e0b' }}>{counterRate != null ? (counterRate*100).toFixed(0)+'%' : '—'}</strong> overall
              &nbsp;·&nbsp;
              <span style={{ color: '#94a3b8' }}>Fisher's key insight: alignment with the 30-session trend is the most consistent edge multiplier in the ACD framework.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const LEVEL_COMBOS = [
  {
    id: 'or_mid_hi_wvwap', cat: 'or', tier: 1,
    label: 'OR Mid + OR High + W-VWAP',
    levels: ['OR5Mid', 'OR_Hi', 'W-VWAP'],
    avg: 103, win: 60, n: 89, stop: 'both',
    best: ['Open drive', 'Open below PD VA'],
    avoid: ['Inside VA open (−$80)', 'Fridays (−$34)'],
    rules: [
      'Entry above OR5Mid, at OR High acting as resistance',
      'Touch W-VWAP from below (+$120 vs $86 from above)',
      'OR High from below — nearly universal (88/89 sessions)',
    ],
    note: 'Strongest setup in dataset. Open drive + below VA open is the power combination.'
  },
  {
    id: 'or_mid_hi_pwhi', cat: 'or', tier: 1,
    label: 'OR Mid + OR High + PW High',
    levels: ['OR5Mid', 'OR_Hi', 'PW_Hi'],
    avg: 94, win: 67, n: 57, stop: 'both',
    best: ['Open drive ($+190, 87% win)', 'Entry above PW High'],
    avoid: ['Fridays (−$121)', 'Mid-morning (−$124)'],
    rules: [
      'PW High from above = support underneath (+$116 vs +$39)',
      'OR High from below — resistance confirmed',
      'Open drive only — edge collapses mid-morning',
    ],
    note: 'Best win rate of any major setup (67%). Timing is everything: open drive or skip it.'
  },
  {
    id: 'or_hi_pwhi', cat: 'or', tier: 1,
    label: 'OR High + PW High',
    levels: ['OR_Hi', 'PW_Hi'],
    avg: 58, win: 48, n: 94, stop: 'both',
    best: ['Open drive or lunch'],
    avoid: ['Open below VA (−$60)', 'Fridays (−$84)'],
    rules: [
      'OR High from below → +$82 avg (resistance touch)',
      'Entry above PW High → +$66 avg (weekly support)',
      'Not below VA open — market in value is better context',
    ],
    note: 'Broader version with wider entry window (open drive + lunch both work).'
  },
  {
    id: 'on_lo_pd_lo', cat: 'on', tier: 1,
    label: 'ON Low + PD Low',
    levels: ['ON_Lo', 'PD_Lo'],
    avg: 63, win: 61, n: 70, stop: 'both',
    best: ['Open NOT inside VA (+$170 vs +$23)', 'Wide IB (+$72 vs +$19)', 'Fridays ($+240)'],
    avoid: ['Inside VA open', 'Wednesdays (−$96)'],
    rules: [
      'Entry ABOVE ON Low = using it as support (+$248 vs −$6 from below)',
      'Wide IB day — volatility context matches the level spread',
      'Open outside VA — breakout/extension day type',
    ],
    note: 'ON Low acts as support only. Approaching from below makes it resistance — avoid.'
  },
  {
    id: 'on_lo_pdpoc_vwap', cat: 'on', tier: 1,
    label: 'ON Low + PD POC + VWAP',
    levels: ['ON_Lo', 'PD_POC', 'VWAP'],
    avg: 83, win: 50, n: 26, stop: 'both',
    best: ['Mid-morning ($+129)', 'Inside VA open ($+118)'],
    avoid: ['Thursdays (0% win rate, −$64)'],
    rules: [
      'Entry above ON Low (+$103 vs −$2 from below)',
      'PD POC from below = +$132 (do NOT touch from above, −$82)',
      'Entry below VWAP (+$87 — mean reversion context)',
    ],
    note: 'Small n (26) but $+83 avg. Strong directional rules — both ON Low and PD POC have hard approach requirements.'
  },
  {
    id: 'a_dn_wvwap', cat: 'acd', tier: 2,
    label: 'A Down + W-VWAP',
    levels: ['A_Dn', 'W-VWAP'],
    avg: 25, win: 48, n: 92, stop: 'both',
    best: ['Inside VA open (+$26 delta)', 'Mid-morning to afternoon'],
    avoid: ['Above VA open (−$156!)', 'Open drive (−$67)', 'Saturdays'],
    rules: [
      'A Down from below = confirmed short (+$81 vs −$22 above)',
      'W-VWAP from below = bearish drift (+$76 vs −$56 above)',
      'Narrow IB preferred (+$34 vs −$71 wide)',
    ],
    note: 'Most consistent across time periods. Not a morning setup — skip open drive, best mid-morning through afternoon.'
  },
  {
    id: 'a_dn_vwap_wvwap', cat: 'acd', tier: 2,
    label: 'A Down + VWAP + W-VWAP',
    levels: ['A_Dn', 'VWAP', 'W-VWAP'],
    avg: 44, win: 54, n: 54, stop: 'both',
    best: ['Afternoon ($+128)', 'Mid-morning ($+63)', 'Inside VA ($+95)'],
    avoid: ['Wide IB (−$71)', 'Above VA open (−$156)'],
    rules: [
      'A Down from below (+$127 vs −$33) — must be a real ACD short',
      'VWAP from above (+$157 vs +$18) — entry above VWAP in short context',
      'W-VWAP from below (+$84) — below weekly average',
    ],
    note: 'Triple ACD/VWAP confluence. All three direction rules must align — deviations cut the edge severely.'
  },
  {
    id: 'pd_val_wvwap', cat: 'pd', tier: 2,
    label: 'PD VAL + W-VWAP',
    levels: ['PD_VAL', 'W-VWAP'],
    avg: 60, win: 57, n: 109, stop: '10pt',
    best: ['Open drive ($+82)', 'Open below or above VA (not inside)'],
    avoid: ['Inside VA open (−$141)', 'Thursdays (−$178 avg)'],
    rules: [
      'Entry above PD VAL (+$81 vs −$6 below) — VAL as support',
      'W-VWAP from below (+$74 vs +$27 above)',
      'Narrow IB (+$81 vs +$20 wide)',
    ],
    note: '10pt stop only — edge disappears with wider stop. Strong in Early period.'
  },
  {
    id: 'pd_lo_pd_val', cat: 'pd', tier: 2,
    label: 'PD Low + PD VAL',
    levels: ['PD_Lo', 'PD_VAL'],
    avg: 22, win: 44, n: 128, stop: 'both',
    best: ['Mid-morning ($+67)', 'Open above VA (+$144 delta +$122)', 'Saturdays'],
    avoid: ['Below VA open (−$63 delta)', 'Afternoon (−$37)', 'Wednesdays'],
    rules: [
      'PD VAL from above = +$108 vs −$16 from below — approach matters',
      'Open above VA = open drive through prior day range = breakout context',
      'Mid-morning is the sweet spot; afternoon kills the edge',
    ],
    note: 'Strong open-above-VA signal — when the open is already above VA, these lows provide backstop support.'
  },
  {
    id: 'pm_val', liveId: 'pm_val_solo', cat: 'pd', tier: 2,
    label: 'PM VAL',
    levels: ['PM_VAL'],
    stop: '20pt',
    best: [],
    avoid: [],
    rules: [
      'Prior static figures (n=175, +$35 avg, 46% win) were computed against a mismatched combo_id and have been retired — they did not describe this setup.',
    ],
    note: 'Live-tracked under combo_id pm_val_solo. Sample is currently thin — read the live numbers above as insufficient, not as an edge, until more sessions accumulate.'
  },
  {
    id: 'or_lo_pwlo', cat: 'or', tier: 1,
    label: 'OR Low + PW Low',
    levels: ['OR_Lo', 'PW_Lo'],
    stop: 'both',
    best: [],
    avoid: [],
    rules: [
      'Mirror of OR High + PW High on the downside — not yet enough sessions to state directional rules.',
    ],
    note: 'Newly surfaced from the live backtest. Sample is too thin to draw conclusions yet — revisit once more sessions accumulate.'
  },
];

const CAT_LABELS = { or: 'OR Levels', on: 'ON Levels', acd: 'ACD', pd: 'PD/PM Levels' };
const STOP_TAG = { both: { label: 'both stops', color: '#22c55e' }, '10pt': { label: '10pt stop', color: '#f59e0b' }, '20pt': { label: '20pt stop', color: '#f59e0b' } };

export function LevelConfluenceReference() {
  const [cat, setCat] = React.useState('all');
  const [expanded, setExpanded] = React.useState(null);
  const [liveStats, setLiveStats] = React.useState(null);
  const [rerunning, setRerunning] = React.useState(false);

  React.useEffect(() => {
    fetch('/api/stats/combo-stats')
      .then(r => r.json())
      .then(rows => { if (Array.isArray(rows) && rows.length) setLiveStats(rows); })
      .catch(() => {});
  }, []);

  const mergeLive = (combo) => {
    const liveId = combo.liveId || combo.id;
    const live = liveStats ? liveStats.find(s => s.combo_id === liveId) : null;
    return {
      ...combo,
      avg: live ? Math.round(live.avg_pnl) : null,
      win: live ? Math.round(live.win_rate) : null,
      n: live ? live.n : null,
      _live: !!live,
      _liveLoaded: !!liveStats,
      _lastAnalyzed: live?.last_analyzed,
      _range: live ? `${live.session_range_start}→${live.session_range_end}` : null,
    };
  };

  const allCombos = LEVEL_COMBOS.map(mergeLive);
  const combos = cat === 'all' ? allCombos : allCombos.filter(c => c.cat === cat);
  const sessionRange = liveStats?.[0]?._range;

  const avgColor = (avg) => avg >= 80 ? '#22c55e' : avg >= 40 ? '#a3e635' : avg >= 15 ? '#f59e0b' : '#94a3b8';

  const confidenceTier = (n) => (n == null ? 'PROVISIONAL' : n >= 100 ? 'VALIDATED' : n >= 30 ? 'PROVISIONAL' : 'INSUFFICIENT');
  const TIER_COLOR = { VALIDATED: '#22c55e', PROVISIONAL: '#f59e0b', INSUFFICIENT: '#94a3b8' };

  const handleRerun = () => {
    setRerunning(true);
    fetch('/api/stats/combo-stats/rerun', { method: 'POST' })
      .then(r => r.json())
      .then(() => {
        setTimeout(() => {
          fetch('/api/stats/combo-stats').then(r => r.json()).then(rows => {
            if (Array.isArray(rows) && rows.length) setLiveStats(rows);
            setRerunning(false);
          }).catch(() => setRerunning(false));
        }, 90000);
      })
      .catch(() => setRerunning(false));
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6, flex: 1 }}>
          Combinatorial analysis — levels within 20pt proximity, outcome = NQ session open→close direction × $20/pt.
          {sessionRange && <span> Sessions: {sessionRange}.</span>}
          {' '}Describes session bias at level confluence, not tradeable entry/stop/RR performance.
        </div>
        <button onClick={handleRerun} disabled={rerunning}
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 5, cursor: rerunning ? 'default' : 'pointer',
            border: '1px solid rgba(139,92,246,0.4)', background: 'rgba(139,92,246,0.1)',
            color: rerunning ? '#64748b' : '#a78bfa', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {rerunning ? '⏳ Re-running (~90s)…' : '↻ Re-run backtest'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {['all', 'or', 'on', 'acd', 'pd'].map(c => (
          <button key={c} onClick={() => setCat(c)}
            style={{ fontSize: 12, padding: '3px 10px', borderRadius: 20, cursor: 'pointer',
              border: `1px solid ${cat === c ? '#8b5cf6' : 'var(--border-color)'}`,
              background: cat === c ? 'rgba(139,92,246,0.15)' : 'transparent',
              color: cat === c ? '#8b5cf6' : '#94a3b8', fontWeight: cat === c ? 700 : 400 }}>
            {c === 'all' ? 'All' : CAT_LABELS[c]}
          </button>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              {['Combo', 'Cat', 'n', 'Win %', 'Avg P&L', 'Tier'].map(h => (
                <th key={h} style={{ padding: '6px 12px', textAlign: h === 'Combo' ? 'left' : 'center',
                  fontSize: 12, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.05em',
                  textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {combos.map(c => {
              const isExp = expanded === c.id;
              const isLoading = !c._liveLoaded;
              const notBacktested = c._liveLoaded && !c._live;
              const tier = confidenceTier(c.n);
              const isInsufficient = !isLoading && !notBacktested && tier === 'INSUFFICIENT';
              const isProvisional  = !isLoading && !notBacktested && tier === 'PROVISIONAL';
              const isValidated    = !isLoading && !notBacktested && tier === 'VALIDATED';
              const dimmed = isInsufficient || notBacktested || isLoading;
              const tierColor = isValidated ? TIER_COLOR.VALIDATED : isProvisional ? TIER_COLOR.PROVISIONAL : TIER_COLOR.INSUFFICIENT;
              const tierLabel = isLoading ? '—' : notBacktested ? 'not tracked' : tier;
              return (
                <React.Fragment key={c.id}>
                  <tr
                    onClick={() => setExpanded(isExp ? null : c.id)}
                    style={{ borderBottom: '1px solid #1e293b', cursor: 'pointer', opacity: dimmed ? 0.45 : 1,
                      background: isExp ? 'rgba(51,65,85,0.3)' : 'transparent',
                      transition: 'background 0.1s' }}>
                    <td style={{ padding: '9px 12px' }}>
                      <div style={{ fontWeight: 600, color: dimmed ? '#64748b' : '#e2e8f0' }}>{c.label}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
                        {c.levels.join(' · ')}
                        {STOP_TAG[c.stop] && <span style={{ marginLeft: 6, color: STOP_TAG[c.stop].color }}>{STOP_TAG[c.stop].label}</span>}
                      </div>
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                      {CAT_LABELS[c.cat] || c.cat}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'center', fontFamily: 'monospace', color: '#94a3b8' }}>
                      {isLoading ? '…' : c.n ?? '—'}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'center', fontFamily: 'monospace',
                      color: !dimmed && c.win != null ? (c.win >= 55 ? '#22c55e' : c.win >= 45 ? '#f59e0b' : '#ef4444') : '#64748b' }}>
                      {!dimmed && c.win != null ? `${c.win}%` : '—'}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'center', fontFamily: 'monospace', fontWeight: 700,
                      color: !dimmed && c.avg != null ? avgColor(c.avg) : '#64748b' }}>
                      {!dimmed && c.avg != null ? `${c.avg >= 0 ? '+' : ''}$${c.avg}` : '—'}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: tierColor, padding: '2px 7px',
                        background: `${tierColor}18`, border: `1px solid ${tierColor}40`, borderRadius: 3,
                        letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                        {tierLabel}
                      </span>
                    </td>
                  </tr>
                  {isExp && (
                    <tr style={{ borderBottom: '1px solid #1e293b', background: 'rgba(15,23,42,0.5)' }}>
                      <td colSpan={6} style={{ padding: '10px 20px' }} onClick={e => e.stopPropagation()}>
                        {c.rules.map((r, i) => (
                          <div key={i} style={{ fontSize: 12, color: '#cbd5e1', padding: '3px 0', lineHeight: 1.5 }}>→ {r}</div>
                        ))}
                        {c.note && (
                          <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>{c.note}</div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: '#94a3b8' }}>
        <span><span style={{ color: TIER_COLOR.VALIDATED, fontWeight: 700 }}>●</span> validated n≥100</span>
        <span><span style={{ color: TIER_COLOR.PROVISIONAL, fontWeight: 700 }}>●</span> provisional n 30–99</span>
        <span><span style={{ color: TIER_COLOR.INSUFFICIENT, fontWeight: 700 }}>●</span> insufficient n&lt;30 — noise</span>
        <span style={{ marginLeft: 'auto' }}>Click row to see direction rules</span>
      </div>
    </div>
  );
}

function ConditionBacktest() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch(`${API_URL}/backtest/conditions`)
      .then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const [view, setView] = React.useState('daily');

  if (loading) return <div style={{ padding: 20, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>Running condition backtest…</div>;
  if (!data?.available) return null;

  const structureColor = { BRACKET: '#3b82f6', BRACKET_TILTING_UP: '#fbbf24', BRACKET_TILTING_DOWN: '#fbbf24', TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24' };
  const structureLabel = { BRACKET: '↔ Bracket', BRACKET_TILTING_UP: '↔ Bracket ↑tilt', BRACKET_TILTING_DOWN: '↔ Bracket ↓tilt', TRENDING_UP: '↑ Trending Up', TRENDING_DOWN: '↓ Trending Down', TRANSITIONAL: '⚡ Transitional' };
  const nlColor = n => n === 'BULLISH' ? '#22c55e' : n === 'BEARISH' ? '#ef4444' : '#fbbf24';

  const Stat = ({ label, result, note }) => {
    if (!result) return null;
    const wr = result.winRate;
    const color = wr >= 65 ? '#22c55e' : wr >= 50 ? '#fbbf24' : wr >= 35 ? '#f97316' : '#ef4444';
    const ptsColor = result.avgPts > 0 ? '#22c55e' : '#ef4444';
    return (
      <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.2)', border: `1px solid ${color}30`, borderRadius: 7 }}>
        <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 4, fontFamily: 'Arial, sans-serif' }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color, fontFamily: 'monospace' }}>{wr}%</span>
          <span style={{ fontSize: 13, color: ptsColor, fontFamily: 'monospace' }}>{result.avgPts > 0 ? '+' : ''}{result.avgPts}pts avg</span>
          <span style={{ fontSize: 13, color: '#94a3b8' }}>{result.wins}/{result.n} trades</span>
        </div>
        {note && <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 4, lineHeight: 1.5, fontFamily: 'Arial, sans-serif' }}>{note}</div>}
      </div>
    );
  };

  const f = data.fades;
  const a = data.aSignals;

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '18px 20px', marginTop: 16, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Backtest: Edge Trades vs Market Conditions
        </div>
        <div style={{ fontSize: 13, color: '#cbd5e1' }}>
          Last {data.totalDays} sessions · Win rate = session closed in the intended direction · Avg pts = daily close vs entry level
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {[['daily','Day-by-Day Log'],['summary','Aggregate Stats']].map(([v,l]) => (
          <button key={v} onClick={() => setView(v)}
            style={{ padding: '5px 14px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: `1px solid ${view===v ? '#3b82f6' : 'var(--border-color)'}`, background: view===v ? '#3b82f6' : 'var(--input-bg)', color: view===v ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif', fontWeight: view===v ? 600 : 400 }}>
            {l}
          </button>
        ))}
      </div>

      {view === 'daily' && data.dailyLog && (
        <div>
          <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 10, fontFamily: 'Arial, sans-serif' }}>
            Each row: what the Big Picture said that morning, the suggested edge, and what actually happened. Green = edge worked · Red = edge failed · Gray = no directional bet recommended.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                  {['Date','Structure','NL30','Suggested edge','Actual result','Outcome'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#cbd5e1', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.dailyLog.map((row, i) => (
                  <tr key={row.date} style={{ borderBottom: '1px solid rgba(100,116,139,0.12)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                    <td style={{ padding: '8px 10px', color: '#94a3b8', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 13 }}>{row.date}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: structureColor[row.structure] || '#94a3b8', fontWeight: 600 }}>{structureLabel[row.structure] || row.structure}</span>
                      <div style={{ fontSize: 13, color: '#94a3b8' }}>VA {row.dir5?.toLowerCase()} · {row.overlaps}/4 overlap</div>
                    </td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: nlColor(row.nlState), fontWeight: 600, fontSize: 13 }}>{row.nl30 > 0 ? '+' : ''}{row.nl30}</span>
                      <div style={{ fontSize: 13, color: '#94a3b8' }}>{row.nlState}</div>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#94a3b8', maxWidth: 260, lineHeight: 1.5 }}>{row.suggestedEdge}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <div style={{ color: row.ptsVsOpen > 0 ? '#22c55e' : row.ptsVsOpen < 0 ? '#ef4444' : '#94a3b8', fontWeight: 600, fontFamily: 'monospace' }}>
                        {row.ptsVsOpen > 0 ? '+' : ''}{row.ptsVsOpen}pts
                      </div>
                      <div style={{ fontSize: 13, color: '#cbd5e1' }}>{row.actualChar}</div>
                    </td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      {row.edgeWorked === true  && <span style={{ color: '#22c55e', fontWeight: 700 }}>✓ Worked</span>}
                      {row.edgeWorked === false && <span style={{ color: '#ef4444', fontWeight: 700 }}>✗ Failed</span>}
                      {row.edgeWorked === null  && <span style={{ color: '#94a3b8' }}>— No bet</span>}
                      {row.edgeResult && <div style={{ fontSize: 13, color: '#cbd5e1', maxWidth: 140, lineHeight: 1.4, marginTop: 2 }}>{row.edgeResult.slice(0, 50)}{row.edgeResult.length > 50 ? '…' : ''}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'summary' && (
        <div>
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>VAH/VAL Fade Trades</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              <Stat label="Fade VAH — any bracket" result={f.vah} note="Overall: fade from prior VAH when session opens near it" />
              <Stat label="Fade VAH — confirmed bracket" result={f.vahBracket} note="Clean bracket (≥4 overlapping day-pairs)" />
              <Stat label="Fade VAH — bracket tilting up ⚠" result={f.vahTilting} note="Bracket where value is migrating higher — the danger zone" />
              <Stat label="Fade VAL — any bracket" result={f.val} note="Overall: fade from prior VAL when session opens near it" />
              <Stat label="Fade VAL — confirmed bracket" result={f.valBracket} note="Clean bracket" />
            </div>
            {f.vahTilting && f.vahTilting.winRate === 0 && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 6, fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
                ⛔ VAH fade in a tilting bracket: <strong>{f.vahTilting.winRate}% win rate</strong> ({f.vahTilting.n} trades, avg {f.vahTilting.avgPts}pts). Data confirms: do not fade VAH when value is migrating higher.
              </div>
            )}
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>A Signal Quality by NL30 State</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              <Stat label="A Up — NL30 bullish (+9)" result={a.aUpBullish} note="A Up when 30-session trend is confirmed up" />
              <Stat label="A Up — NL30 ranging" result={a.aUpRanging} note="A Up with no trend tailwind" />
              <Stat label="A Up — NL30 bearish ⚠" result={a.aUpBearish} note="A Up counter-trend to 30-session downtrend" />
              <Stat label="A Down — NL30 bearish" result={a.aDownBearish} note="A Down when 30-session trend is confirmed down" />
              <Stat label="A Down — NL30 ranging" result={a.aDownRanging} note="A Down with no trend tailwind" />
              <Stat label="A Down — NL30 bullish ⚠" result={a.aDownBullish} note="A Down counter-trend in a bull environment" />
            </div>
            {a.aDownBullish && a.aDownBullish.n >= 2 && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 6, fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
                ⛔ A Down when NL30 bullish: <strong>{a.aDownBullish.winRate}% win rate</strong> ({a.aDownBullish.n} trades, avg {a.aDownBullish.avgPts}pts). The single most costly mistake in the data.
              </div>
            )}
          </div>

          <div style={{ fontSize: 13, color: '#94a3b8', borderTop: '1px solid var(--border-color)', paddingTop: 10, lineHeight: 1.7 }}>
            Methodology: Structure classified daily using prior 5 sessions' VA overlap and POC migration. Fade success = session closed inside prior value area. A signal success = session closed in signal direction. All data from your actual trading history.
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlaybookPage() {
  const [activeSection, setActiveSection] = React.useState(null);

  React.useEffect(() => {
    const hash = window.location.hash?.slice(1);
    if (hash) {
      setActiveSection(hash);
      setTimeout(() => {
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, []);

  const Section = ({ s }) => {
    const isOpen = activeSection === s.id || activeSection === null;
    return (
      <div id={s.id} style={{ background: 'var(--card-bg)', border: `1px solid ${s.color}30`, borderLeft: `4px solid ${s.color}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden', fontFamily: 'Arial, sans-serif' }}>
        <button onClick={() => setActiveSection(activeSection === s.id ? null : s.id)}
          style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ padding: '2px 8px', background: `${s.tagColor}20`, color: s.tagColor, borderRadius: 4, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em' }}>{s.tag}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{s.title}</div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 1 }}>{s.subtitle}</div>
            </div>
          </div>
          <span style={{ color: '#cbd5e1', fontSize: 13 }}>{activeSection === s.id ? '▲' : '▼'}</span>
        </button>

        {activeSection === s.id && (
          <div style={{ padding: '0 20px 20px', borderTop: `1px solid ${s.color}20` }}>
            <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic', margin: '12px 0 10px', fontFamily: 'Arial, sans-serif' }}>Source: {s.source}</div>
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.8, marginBottom: 16, padding: '10px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 6, fontFamily: 'Arial, sans-serif' }}>
              {s.context}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: s.warning ? 14 : 0 }}>
              {s.rules.map((r, i) => (
                <div key={i} style={{ padding: '10px 14px', background: `${s.color}06`, borderLeft: `2px solid ${s.color}50`, borderRadius: '0 6px 6px 0' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: s.color, marginBottom: 4 }}>{r.rule}</div>
                  <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7, fontFamily: 'Arial, sans-serif' }}>{r.detail}</div>
                </div>
              ))}
            </div>
            {s.warning && (
              <div style={{ marginTop: 14, padding: '12px 16px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', marginBottom: 6, letterSpacing: '0.05em' }}>⛔ WHY TRADERS GET BLOWN OUT HERE</div>
                <div style={{ fontSize: 13, color: '#fca5a5', lineHeight: 1.8, fontFamily: 'Arial, sans-serif' }}>{s.warning}</div>
              </div>
            )}
            {s.setup && (
              <div style={{ marginTop: 10, padding: '12px 16px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e', marginBottom: 6, letterSpacing: '0.05em' }}>✓ THE EDGE IN THIS ENVIRONMENT</div>
                <div style={{ fontSize: 13, color: '#86efac', lineHeight: 1.8, fontFamily: 'Arial, sans-serif' }}>{s.setup}</div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 900, margin: '0 auto', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>Trading Playbook</h2>
        <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>
          Static reference — how to trade each market environment and condition. Based on Dalton, Steidlmayer, Fisher, and Weis.<br/>
          <span style={{ color: '#94a3b8' }}>Click any section to expand. These are conditions and playbooks — not signals. Your A signal and opening read provide the actual entry trigger.</span>
        </div>
      </div>

      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 12, fontFamily: 'Arial, sans-serif' }}>
          Quick Reference — Every Condition at a Glance
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
              {['Condition', 'Blown out by', 'The edge'].map(h => (
                <th key={h} style={{ padding: '6px 12px', textAlign: 'left', color: '#cbd5e1', fontWeight: 700, fontSize: 13, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { state: 'BRACKET',             color: '#3b82f6', label: '↔ Bracket',             blown: 'Chasing breakouts that snap back repeatedly',                         edge: 'Fade VAH/VAL edges — defined targets, responsive strategy' },
              { state: 'BRACKET_TILTING_UP',  color: '#fbbf24', label: '↔ Bracket tilting up',  blown: 'Buying every VAH push thinking it\'s the breakout — 3 stops later',   edge: 'Wait for one full session of value above prior VAH, then shift' },
              { state: 'BRACKET_TILTING_DOWN',color: '#fbbf24', label: '↔ Bracket tilting down',blown: 'Shorting every VAL break that bounces back into value',                edge: 'Wait for one full session of value below prior VAL, then shift' },
              { state: 'TRENDING_UP',         color: '#22c55e', label: '↑ Trending Up',          blown: 'Shorting into strength + overstaying trend past absorption signals',    edge: 'A Up + C confirm + NL30 >+9 — hold past initial targets, trail to prior VAH' },
              { state: 'TRENDING_DOWN',       color: '#ef4444', label: '↓ Trending Down',        blown: 'Buying dips ("it\'s cheap") / averaging into a structural downtrend',   edge: 'A Down + C confirm + NL30 <-9 — trail stops to prior VAL' },
              { state: 'TRANSITIONAL',        color: '#fbbf24', label: '⚡ Transitional',        blown: 'Using either strategy with full size before the new regime confirms',   edge: 'Patience — first confirmed VA migration = early-trend entry, not the breakout itself' },
            ].map((row, i) => (
              <tr key={row.state} style={{ borderBottom: '1px solid var(--border-color)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: row.color, fontWeight: 700 }}>{row.label}</span>
                </td>
                <td style={{ padding: '9px 12px', color: '#fca5a5', lineHeight: 1.5 }}>{row.blown}</td>
                <td style={{ padding: '9px 12px', color: '#86efac', lineHeight: 1.5 }}>{row.edge}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <button onClick={() => setActiveSection(null)}
          style={{ padding: '4px 12px', fontSize: 13, borderRadius: 4, cursor: 'pointer', border: '1px solid var(--border-color)', background: activeSection === null ? '#3b82f6' : 'var(--input-bg)', color: activeSection === null ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
          All open
        </button>
        {PLAYBOOK_SECTIONS.map(s => (
          <button key={s.id} onClick={() => { setActiveSection(s.id); setTimeout(() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}
            style={{ padding: '4px 12px', fontSize: 13, borderRadius: 4, cursor: 'pointer', border: `1px solid ${s.color}40`, background: activeSection === s.id ? `${s.color}20` : 'var(--input-bg)', color: activeSection === s.id ? s.color : '#94a3b8', fontFamily: 'Arial, sans-serif', fontWeight: activeSection === s.id ? 700 : 400 }}>
            {s.tag}
          </button>
        ))}
      </div>

      <SetupPriorityReference />
      {PLAYBOOK_SECTIONS.map(s => <Section key={s.id} s={s} />)}
      <ConditionBacktest />
    </div>
  );
}

export function ImprovementsBacklogSection() {
  const [todos, setTodos] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [showAddForm, setShowAddForm] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState('');
  const [newCategory, setNewCategory] = React.useState('A: Real-Time Risk & Execution Guardrails');
  const [newImpact, setNewImpact] = React.useState('');
  const [newDescription, setNewDescription] = React.useState('');

  const loadTodos = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/settings/todos`);
      const d = await r.json();
      if (Array.isArray(d)) setTodos(d);
    } catch (e) {
      console.error('Failed to load todos:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { loadTodos(); }, [loadTodos]);

  const toggleTodo = async (todo) => {
    try {
      const r = await fetch(`${API_URL}/settings/todos/${todo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: !todo.completed }),
      });
      if (r.ok) {
        const updated = await r.json();
        setTodos(prev => prev.map(t => t.id === todo.id ? updated : t));
      }
    } catch (e) { console.error('Failed to toggle todo:', e); }
  };

  const handleAddTodo = async (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      const r = await fetch(`${API_URL}/settings/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, category: newCategory, impact: newImpact, description: newDescription }),
      });
      if (r.ok) {
        const created = await r.json();
        setTodos(prev => [...prev, created]);
        setNewTitle(''); setNewImpact(''); setNewDescription(''); setShowAddForm(false);
      }
    } catch (e) { console.error('Failed to add todo:', e); }
  };

  const handleDeleteTodo = async (id) => {
    if (!window.confirm('Are you sure you want to delete this custom task?')) return;
    try {
      const r = await fetch(`${API_URL}/settings/todos/${id}`, { method: 'DELETE' });
      if (r.ok) setTodos(prev => prev.filter(t => t.id !== id));
    } catch (e) { console.error('Failed to delete todo:', e); }
  };

  const categories = [
    'A: Real-Time Risk & Execution Guardrails',
    'B: Real-Time Setup & Analysis Edges',
    'C: Database & Ingestion Optimization',
    'D: Frontend Architecture & Code Quality',
    'E: Secondary Backtest & Reporting Improvements',
    'Custom Improvements',
  ];

  const groupedTodos = categories.reduce((acc, cat) => {
    acc[cat] = todos.filter(t => t.category.startsWith(cat.substring(0, 3)) || t.category === cat);
    return acc;
  }, {});

  const totalCount = todos.length;
  const completedCount = todos.filter(t => t.completed).length;
  const pctComplete = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1000, marginTop: 20 }}>
      <div className="settings-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 14 }}>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Execution & Codebase Improvements Checklist</span>
            <span style={{ fontWeight: 700, color: 'var(--accent-purple)' }}>{pctComplete}% Complete ({completedCount} / {totalCount} items)</span>
          </div>
          <div style={{ height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pctComplete}%`, background: 'linear-gradient(90deg, var(--accent-purple), #10b981)', transition: 'width 0.4s ease' }} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ marginLeft: 24, padding: '8px 16px', fontSize: 13 }} onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? 'Cancel' : 'Add Custom Task'}
        </button>
      </div>

      {showAddForm && (
        <div className="settings-card" style={{ border: '1px solid var(--accent-purple)', background: 'rgba(167,139,250,0.05)', padding: 20, borderRadius: 10 }}>
          <h3>Add New Custom Improvement Task</h3>
          <form onSubmit={handleAddTodo} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 2 }}>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' }}>Task Title *</label>
                <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} required placeholder="e.g. Implement alert audio notifications"
                  style={{ width: '100%', padding: '8px 12px', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: 'var(--text-primary)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' }}>Category</label>
                <select value={newCategory} onChange={e => setNewCategory(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: 'var(--text-primary)', height: 38 }}>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' }}>Expected Impact / Target Metric</label>
              <input type="text" value={newImpact} onChange={e => setNewImpact(e.target.value)} placeholder="e.g. 15% reduction in sizing errors"
                style={{ width: '100%', padding: '8px 12px', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: 'var(--text-primary)' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' }}>Description / Details</label>
              <textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="Provide context on what this task entails and how to verify..." rows={3}
                style={{ width: '100%', padding: '8px 12px', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: 'var(--text-primary)', resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowAddForm(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save Task</button>
            </div>
          </form>
        </div>
      )}

      {loading && <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>Loading improvements backlog...</div>}

      {!loading && categories.map(cat => {
        const list = groupedTodos[cat] || [];
        if (list.length === 0 && cat === 'Custom Improvements') return null;
        const catCompleted = list.filter(t => t.completed).length;
        const catTotal = list.length;
        return (
          <div key={cat} className="settings-card" style={{ borderLeft: '3px solid var(--accent-purple)', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderLeftWidth: 3, borderRadius: 10, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 10, marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{cat}</h3>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>{catCompleted} / {catTotal} completed</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {list.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>No tasks in this category.</div>}
              {list.map(todo => (
                <div key={todo.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 12px', background: todo.completed ? 'rgba(16,185,129,0.02)' : 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: 6, transition: 'all 0.2s ease' }}>
                  <input type="checkbox" checked={todo.completed} onChange={() => toggleTodo(todo)}
                    style={{ width: 16, height: 16, marginTop: 3, cursor: 'pointer', accentColor: '#10b981' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: todo.completed ? 'var(--text-muted)' : 'var(--text-primary)', textDecoration: todo.completed ? 'line-through' : 'none' }}>
                        {todo.priority && <span style={{ marginRight: 6, opacity: 0.6 }}>#{todo.priority}</span>}
                        {todo.title}
                      </span>
                      {todo.impact && (
                        <span style={{ fontSize: 11, background: todo.completed ? 'rgba(255,255,255,0.03)' : 'rgba(59,130,246,0.1)', color: todo.completed ? 'var(--text-muted)' : '#60a5fa', padding: '2px 8px', borderRadius: 4, whiteSpace: 'nowrap', fontWeight: 600 }}>
                          Impact: {todo.impact}
                        </span>
                      )}
                    </div>
                    {todo.description && (
                      <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4, textDecoration: todo.completed ? 'line-through' : 'none' }}>
                        {todo.description}
                      </p>
                    )}
                  </div>
                  {todo.is_custom && (
                    <button style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }} title="Delete task" onClick={() => handleDeleteTodo(todo.id)}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PlaybookWeeklyPatternsSection() {
  const [statsMap, setStatsMap] = React.useState({});
  const [edgesContext, setEdgesContext] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const PLAYBOOK_SETUPS = [
    { key: 'IB_BULLISH', label: 'Initial Balance Breakout Long ↑', desc: 'Sustained price break and acceptance above the 9:30–10:30 AM ET range high.', stop: 'Opposite side of range or IBM.', target: '100% / 200% expansions.' },
    { key: 'IB_BEARISH', label: 'Initial Balance Breakout Short ↓', desc: 'Sustained price break and acceptance below the 9:30–10:30 AM ET range low.', stop: 'Opposite side of range or IBM.', target: '100% / 200% expansions.' },
    { key: 'BRACKET_BREAKOUT_LONG', label: 'Bracket Breakout Long ↑', desc: 'Price closes above a multi-day horizontal consolidation boundary (bracket resistance).', stop: 'Re-entry back inside bracket.', target: 'Measured move equivalent to bracket width.' },
    { key: 'BRACKET_BREAKOUT_SHORT', label: 'Bracket Breakout Short ↓', desc: 'Price closes below a multi-day horizontal consolidation boundary (bracket support).', stop: 'Re-entry back inside bracket.', target: 'Measured move equivalent to bracket width.' },
    { key: 'OPEN_TEST_DRIVE_LONG', label: 'Open Test Drive Long ↑', desc: 'Price probes lower at the open, sweeps liquidity, then drives through the OR High extreme.', stop: 'Session low established during test phase.', target: 'Key structural targets (VAH, VAL, etc.).' },
    { key: 'OPEN_TEST_DRIVE_SHORT', label: 'Open Test Drive Short ↓', desc: 'Price probes higher at the open, sweeps liquidity, then drives through the OR Low extreme.', stop: 'Session high established during test phase.', target: 'Key structural targets (VAH, VAL, etc.).' },
    { key: 'OPEN_DRIVE_LONG', label: 'Open Drive Long ↑', desc: 'Conviction buying drives price directly through the OR High at the opening bell without counter-testing.', stop: 'Open price or opposite side of OR5.', target: 'ATR/weekly target extensions.' },
    { key: 'OPEN_DRIVE_SHORT', label: 'Open Drive Short ↓', desc: 'Conviction selling drives price directly through the OR Low at the opening bell without counter-testing.', stop: 'Open price or opposite side of OR5.', target: 'ATR/weekly target extensions.' },
    { key: 'TRT_LONG', label: 'Trapped Shorts (TRT Long) ↑', desc: 'An A Down fires but fails to confirm via C level, rejecting back through the OR High extreme.', stop: 'Session low.', target: 'T1 level on opposite side.' },
    { key: 'TRT_SHORT', label: 'Trapped Longs (TRT Short) ↓', desc: 'An A Up fires but fails to confirm via C level, rejecting back through the OR Low extreme.', stop: 'Session high.', target: 'T1 level on opposite side.' },
    { key: 'TRT_LONG_V2', label: 'TRT V2 Long ↑', desc: 'Earlier entry than classic TRT: A Down rejected before C level confirmation.', stop: 'Session low.', target: 'T1 level on opposite side.' },
    { key: 'TRT_SHORT_V2', label: 'TRT V2 Short ↓', desc: 'Earlier entry than classic TRT: A Up rejected before C level confirmation.', stop: 'Session high.', target: 'T1 level on opposite side.' },
    { key: 'TRT_MAH_LONG', label: 'MAH Reversal Long ↑', desc: 'A TRT setup that triggers at extreme 30-day Number Line overbought/oversold exhaustion zones.', stop: 'Reversal low.', target: 'T1 level or major daily pivot.' },
    { key: 'TRT_MAH_SHORT', label: 'MAH Reversal Short ↓', desc: 'A TRT setup that triggers at extreme 30-day Number Line overbought/oversold exhaustion zones.', stop: 'Reversal high.', target: 'T1 level or major daily pivot.' },
    { key: 'FAILED_AUCTION_LONG', label: 'Failed Auction Long ↑', desc: 'Price probes below previous range, fails to find acceptance, and reclaims range.', stop: 'Low of failed probe.', target: 'Opposite extreme of yesterday\'s range.' },
    { key: 'FAILED_AUCTION_SHORT', label: 'Failed Auction Short ↓', desc: 'Price probes above previous range, fails to find acceptance, and reclaims range.', stop: 'High of failed probe.', target: 'Opposite extreme of yesterday\'s range.' },
    { key: 'VALUE_AREA_RESPONSIVE_LONG', label: 'Value Area Responsive Long ↑', desc: 'Price opens/probes below yesterday\'s value area, rejects, and trades back inside.', stop: 'Session extreme outside yesterday\'s VA.', target: 'Yesterday\'s POC or opposite Value Area limit.' },
    { key: 'VALUE_AREA_RESPONSIVE_SHORT', label: 'Value Area Responsive Short ↓', desc: 'Price opens/probes above yesterday\'s value area, rejects, and trades back inside.', stop: 'Session extreme outside yesterday\'s VA.', target: 'Yesterday\'s POC or opposite Value Area limit.' },
    { key: 'A_UP_STRONG', label: 'A Up Strong ↑', desc: 'Immediate directional drive, price holds cleanly above OR High. High probability when aligned with trend.', stop: 'OR Low.', target: 'T1 target or full OR measured move.' },
    { key: 'A_DOWN_STRONG', label: 'A Down Strong ↓', desc: 'Immediate directional drive, price holds cleanly below OR Low. High probability when aligned with trend.', stop: 'OR High.', target: 'T1 target or full OR measured move.' },
    { key: 'A_UP_WEAK', label: 'A Up Weak (Counter) ↑', desc: 'Slow grind or counter-trend A Up. Stalls near the level. Lower follow-through probability.', stop: 'OR Low.', target: 'Tighter targets / conservative T1.' },
    { key: 'A_DOWN_WEAK', label: 'A Down Weak (Counter) ↓', desc: 'Slow grind or counter-trend A Down. Stalls near the level. Lower follow-through probability.', stop: 'OR High.', target: 'Tighter targets / conservative T1.' },
    { key: 'C_PAIRED_LONG', label: 'C Up Paired ↑', desc: 'C Up confirmed after an A Up fires, showing strong buyer absorption of any counter-moves.', stop: 'OR Low.', target: 'Weekly extension or 2R.' },
    { key: 'C_PAIRED_SHORT', label: 'C Down Paired ↓', desc: 'C Down confirmed after an A Down fires, showing strong seller absorption of any counter-moves.', stop: 'OR High.', target: 'Weekly extension or 2R.' },
    { key: 'C_REVERSAL_LONG', label: 'C Reversal Long ↑', desc: 'C Up fires in opposite direction of a failed A Down, confirming thesis reversed.', stop: 'Session low.', target: 'Opposite extreme of yesterday\'s range.' },
    { key: 'C_REVERSAL_SHORT', label: 'C Reversal Short ↓', desc: 'C Down fires in opposite direction of a failed A Up, confirming thesis reversed.', stop: 'Session high.', target: 'Opposite extreme of yesterday\'s range.' },
    { key: 'C_STANDALONE_UP', label: 'C Standalone Up ↑', desc: 'C Up fires but no A signal ever fired previously during the session.', stop: 'OR Low.', target: 'Prior day VAH or OR measured move.' },
    { key: 'C_STANDALONE_DOWN', label: 'C Standalone Down ↓', desc: 'C Down fires but no A signal ever fired previously during the session.', stop: 'OR High.', target: 'Prior day VAL or OR measured move.' },
    { key: 'GAP_FILL_LONG', label: 'Gap Fill Long ↑', desc: 'Price enters an unfilled down-gap zone from a previous session, triggering a long to fill up to the gap ceiling.', stop: '15 points below the gap floor entry limit.', target: 'Gap ceiling (prior session low).' },
    { key: 'GAP_FILL_SHORT', label: 'Gap Fill Short ↓', desc: 'Price enters an unfilled up-gap zone from a previous session, triggering a short to fill down to the gap floor.', stop: '15 points above the gap ceiling entry limit.', target: 'Gap floor (prior session high).' },
  ];

  const PRICE_ACTION_EDGES = [
    { key: 'gapUp', label: 'Gap Up Fills', desc: 'Market opens above yesterday\'s High and trades down to fill the gap (touch yesterday\'s High).', metric: 'gapUpFillPct', tip: `Gap Up Fill (66% - 69% Probability)\n\nTrigger: NQ opens above yesterday's High.\n\nMechanics: If the initial opening drive up fails to find aggressive buyers, a counter-offensive sell is triggered when the price reclaims the open. Target is yesterday's High (completing the gap fill).\n\nRisk: Stop-loss at session High. Target yesterday's High.` },
    { key: 'gapDown', label: 'Gap Down Fills', desc: 'Market opens below yesterday\'s Low and trades up to fill the gap (touch yesterday\'s Low).', metric: 'gapDownFillPct', tip: `Gap Down Fill (66% - 69% Probability)\n\nTrigger: NQ opens below yesterday's Low.\n\nMechanics: If the initial opening drive down fails to find aggressive sellers, a buy is triggered when the price reclaims the open. Target is yesterday's Low (completing the gap fill).\n\nRisk: Stop-loss at session Low. Target yesterday's Low.` },
    { key: 'sweeps', label: 'Failed sweeps (Liquidity Rejections)', desc: 'Market probes above/below yesterday\'s high/low but closes back inside yesterday\'s range.', metric: 'sweepPct', tip: `Failed Sweeps (~30% Occurrence)\n\nTrigger: Price sweeps yesterday's limits (High/Low) but fails to sustain acceptance, reversing back inside the range.\n\nMechanics: Reversal setup indicating lack of aggressive boundary participants. Target is the opposite side of the range.\n\nRisk: Tight stop-loss just beyond the failed sweep extreme.` },
    { key: 'pivot', label: '10:00 AM Pivot', desc: 'Session high or low printed within the 9:55 - 10:05 AM ET window (10:00 AM turning point).', metric: 'pivotPct', tip: `10:00 AM Pivot / Turning Point (~52% Probability)\n\nTrigger: Daily High or Low is established between 9:55 AM and 10:05 AM ET.\n\nMechanics: Morning retail drive exhausts as institutional volume enters. Often creates sharp rejections or double tops/bottoms.\n\nRisk: Enter reversal plays with stop-loss at the extreme of the 10:00 AM pivot wick.` },
    { key: 'wideOR', label: 'Wide OR Follow-thru', desc: 'Rate of successful breakout runs on days when the opening 5-minute range is wide (>= 91.5 pts).', metric: 'wideRunPct', tip: `Wide OR Breakout (<5% Success Rate)\n\nTrigger: Opening range (OR5) exceeds 91.5 pts.\n\nMechanics: Wide opening ranges indicate high volatility but also mean the day's expected extension has already occurred. Breakouts have an extremely high failure rate (>95%). Fades or Trapped setups (TRT) are the dominant edge.\n\nRisk: Avoid trend-following breakouts; enter only fading reversals with tight risk.` },
    { key: 'tightOR', label: 'Tight OR Follow-thru', desc: 'Rate of successful breakout runs on days when the opening 5-minute range is narrow (< 47.5 pts).', metric: 'tightRunPct', tip: `Tight OR Breakout (~12% Success Rate)\n\nTrigger: Opening range (OR5) is narrow (< 47.5 pts).\n\nMechanics: Narrow opening ranges indicate volatility compression/coiling, which leads to high-momentum breakouts with strong directional extension.\n\nRisk: Position sizing and risk parameters are standard. Enter on candle close outside the IB range.` },
  ];

  React.useEffect(() => {
    const loadAllStats = async () => {
      setLoading(true);
      try {
        const edgesRes = await fetch(`${API_URL}/antigravity/edges-context`);
        const edgesData = await edgesRes.json();
        setEdgesContext(edgesData);

        const setupKeys = PLAYBOOK_SETUPS.map(s => s.key);
        const statsResults = await Promise.all(
          setupKeys.map(async (key) => {
            try {
              const res = await fetch(`${API_URL}/setups/stats?type=${key}`);
              const data = await res.json();
              return { key, data };
            } catch (e) {
              return { key, data: null };
            }
          })
        );
        const newStatsMap = {};
        statsResults.forEach(({ key, data }) => { newStatsMap[key] = data; });
        setStatsMap(newStatsMap);
      } catch (e) {
        console.error('Failed to load playbook stats:', e);
      } finally {
        setLoading(false);
      }
    };
    loadAllStats();
  }, []);

  const getStatColor = (val) => {
    if (val == null) return 'var(--text-muted)';
    const rate = val > 1 ? val / 100 : val;
    if (rate >= 0.58) return '#22c55e';
    if (rate >= 0.48) return 'var(--text-primary)';
    return '#ef4444';
  };

  const getEdgeVal = (winKey, metric) => {
    const win = edgesContext?.windows?.[winKey];
    return win ? win[metric] : null;
  };

  const renderStatsGrid = (stats, isEdge = false, metric = '') => {
    let col30 = null, col60 = null, col90 = null, colAll = null;
    let cnt30 = null, cnt60 = null, cnt90 = null, cntAll = null;
    let isBaseline = false;

    if (isEdge) {
      col30 = getEdgeVal('last30', metric);
      col60 = getEdgeVal('last60', metric);
      col90 = getEdgeVal('last90', metric);
      colAll = getEdgeVal('allTime', metric);
    } else if (stats) {
      col30 = stats.d30 ? stats.d30.winRate : null;
      cnt30 = stats.d30 ? stats.d30.sessions : null;
      col60 = stats.d60 ? stats.d60.winRate : null;
      cnt60 = stats.d60 ? stats.d60.sessions : null;
      col90 = stats.d90 ? stats.d90.winRate : null;
      cnt90 = stats.d90 ? stats.d90.sessions : null;
      colAll = stats.allTime ? stats.allTime.winRate : null;
      cntAll = stats.allTime ? stats.allTime.sessions : null;
      isBaseline = stats.allTime?.isBaseline || false;
    }

    const columns = [
      { label: '30d', val: col30, count: cnt30 },
      { label: '60d', val: col60, count: cnt60 },
      { label: '90d', val: col90, count: cnt90 },
      { label: 'All-Time', val: colAll, count: cntAll, isBaseline },
    ];

    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, minWidth: 260 }}>
        {columns.map(col => (
          <div key={col.label} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', padding: '6px 4px', borderRadius: 6, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 2 }}>{col.label}</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: getStatColor(col.val) }}>
              {col.val != null ? `${Math.round(col.val * (isEdge ? 1 : 100))}%` : '—'}
            </div>
            {col.count != null && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                ({col.count}){col.isBaseline && <span title="Baseline win rate default" style={{ cursor: 'help' }}> (B)</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderDowStatsGrid = (dowNum) => {
    const getDowVal = (winKey) => {
      const stats = edgesContext?.tradeBacktest?.[winKey]?.dowStats?.[dowNum];
      return stats ? { winRate: stats.winRate, total: stats.total, avgPnl: stats.avgPnl } : null;
    };
    const columns = [
      { label: '30d', stats: getDowVal('last30') },
      { label: '60d', stats: getDowVal('last60') },
      { label: '90d', stats: getDowVal('last90') },
      { label: 'All-Time', stats: getDowVal('allTime') },
    ];
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, minWidth: 260 }}>
        {columns.map(col => (
          <div key={col.label} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', padding: '6px 4px', borderRadius: 6, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 2 }}>{col.label}</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: col.stats?.winRate != null ? getStatColor(col.stats.winRate / 100) : 'var(--text-muted)' }}>
              {col.stats?.winRate != null ? `${Math.round(col.stats.winRate)}%` : '—'}
            </div>
            {col.stats?.total != null && col.stats.total > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }} title={`Avg P&L: $${col.stats.avgPnl}`}>
                ({col.stats.total}t)
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const [guideTab, setGuideTab] = React.useState('verification');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1000, marginTop: 20 }}>
      <div className="settings-card" style={{ borderLeft: '3px solid #f59e0b', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderLeftWidth: 3, borderRadius: 10, padding: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 16, color: '#f59e0b' }}>
          📆 Weekly (Day-of-Week) Playbook Patterns & Stats
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[
            { day: 'Monday', dowNum: 1, name: 'Mean Reversion & Drive Alignment', wr: '21.9% WR', alert: '⚠️ Highest-Loss Day', desc: 'On Mondays, standard breakout plays have an extremely high failure rate. Instead, focus strictly on fading early range extensions.', rule: 'Use 50% size. Avoid breakouts before 11:00 AM ET. If a trend does form, it typically closes in the same direction as the first 15-minute drive.' },
            { day: 'Tuesday', dowNum: 2, name: 'Trend Initiation Sweet Spot', wr: 'Sweet Spot', alert: '✅ Mid-Week Trading', desc: 'Tuesdays are the start of mid-week liquidity. There is an elevated statistical probability of a clean, sustained trend day.', rule: 'Standard position sizes and risk parameters allowed. Play standard breakout and trend-following setups.' },
            { day: 'Wednesday', dowNum: 3, name: 'Mid-Week Trend Continuation', wr: 'Sweet Spot', alert: '✅ Trend Follow-Through', desc: 'Wednesdays show a strong statistical tendency for morning momentum to continue through the afternoon close ("Wednesday → AM Continues into PM").', rule: 'Standard position sizes. Ride morning momentum and avoid counter-trend fading of strong morning trends early in the PM session.' },
            { day: 'Thursday', dowNum: 4, name: 'Sweet Spot Consolidation', wr: 'Sweet Spot', alert: '✅ Mid-Week Trading', desc: 'Another consistent execution day. Price tends to respect volume profiles and established support/resistance zones.', rule: 'Standard sizing. Focus on key level touches (IB, VAH/VAL) and standard playbook setups.' },
            { day: 'Friday', dowNum: 5, name: 'Profit Taking & PM Reversals', wr: '74% Red Rate', alert: '⚠️ High-Risk Day', desc: 'Fridays have a historically high failure rate for your accounts, primarily due to overstaying positions late in the day.', rule: 'Keep stops tight and lock in gains early. Expect sharp afternoon reversals of the morning trend ("Friday → AM Reverses in PM") as institutions square books before the weekend.' },
          ].map(d => (
            <div key={d.day} style={{ display: 'flex', gap: 20, alignItems: 'center', justifyContent: 'space-between', padding: 12, background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
              <div style={{ flex: 1, marginRight: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {d.day} — <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{d.name}</span>
                  </span>
                  <span style={{ fontSize: 11, background: d.alert.startsWith('✅') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: d.alert.startsWith('✅') ? '#34d399' : '#f87171', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
                    {d.alert}
                  </span>
                </div>
                <p style={{ margin: '0 0 6px 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{d.desc}</p>
                <div style={{ fontSize: 11, color: '#60a5fa', background: 'rgba(59,130,246,0.05)', padding: '6px 10px', borderRadius: 4, borderLeft: '2px solid #3b82f6' }}>
                  <strong>Execution Rule:</strong> {d.rule}
                </div>
              </div>
              {renderDowStatsGrid(d.dowNum)}
            </div>
          ))}
        </div>
      </div>

      <div className="settings-card" style={{ borderLeft: '3px solid #6366f1', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderLeftWidth: 3, borderRadius: 10, padding: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 16, color: '#818cf8' }}>
          📊 Price-Action Edge Setups (Statistical Lookbacks)
        </h2>
        {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>Loading statistical edges...</div>}
        {!loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {PRICE_ACTION_EDGES.map(s => (
              <div key={s.key} style={{ display: 'flex', gap: 20, alignItems: 'center', justifyContent: 'space-between', padding: 12, background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                <div style={{ flex: 1, marginRight: 16 }}>
                  <h4 style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0 0 4px 0', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {s.label}
                    {s.tip && <InfoTooltip text={s.tip} />}
                  </h4>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{s.desc}</p>
                </div>
                {renderStatsGrid(null, true, s.metric)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-card" style={{ borderLeft: '3px solid #10b981', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderLeftWidth: 3, borderRadius: 10, padding: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 16, color: '#10b981' }}>
          🎯 ACD & Structural Setup Reference Guide
        </h2>
        {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>Loading setup statistics...</div>}
        {!loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {PLAYBOOK_SETUPS.map(s => (
              <div key={s.key} style={{ display: 'flex', gap: 20, alignItems: 'center', justifyContent: 'space-between', padding: 12, background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                <div style={{ flex: 1, marginRight: 16 }}>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{s.label}</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <p style={{ margin: '0 0 4px 0', color: 'var(--text-muted)', lineHeight: 1.4 }}>{s.desc}</p>
                    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '2px 12px', fontSize: 11 }}>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Stop-Loss:</span>
                      <span style={{ color: 'var(--accent-red)', fontWeight: 500 }}>{s.stop}</span>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Target:</span>
                      <span style={{ color: 'var(--accent-green)', fontWeight: 500 }}>{s.target}</span>
                    </div>
                    {statsMap[s.key]?.byDayType && (() => {
                      const bdt = statsMap[s.key].byDayType;
                      const buckets = ['TREND', 'BALANCE', 'TURBULENT'].map(dt => ({ dt, stat: bdt[dt] })).filter(b => b.stat?.winRate != null);
                      if (!buckets.length) return null;
                      return (
                        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, flexWrap: 'wrap', alignItems: 'center', background: 'rgba(99,102,241,0.03)', border: '1px solid rgba(99,102,241,0.1)', padding: '4px 8px', borderRadius: 4, width: 'fit-content' }}>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Day Type Edges:</span>
                          {buckets.map(({ dt, stat }) => {
                            const wr = Math.round(stat.winRate * 100);
                            const col = stat.winRate >= 0.58 ? '#22c55e' : stat.winRate >= 0.48 ? 'var(--text-primary)' : '#ef4444';
                            return (
                              <span key={dt} style={{ color: col, fontWeight: 700 }}>
                                {dt}: {wr}% <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>({stat.decidedN}t)</span>
                              </span>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </div>
                {renderStatsGrid(statsMap[s.key], false)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-card" style={{ borderLeft: '3px solid #8b5cf6', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderLeftWidth: 3, borderRadius: 10, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 16, color: '#a78bfa' }}>
          🧠 Antigravity Intelligence & Visual Validation Guide
        </h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: 8 }}>
          {[
            { key: 'verification', label: '🔍 How I See Setups' },
            { key: 'examples', label: '🏆 High-Probability Examples' },
            { key: 'scanning', label: '🤖 Perpetual Scanning & Alerts' },
          ].map(tab => (
            <button key={tab.key} onClick={() => setGuideTab(tab.key)}
              style={{ background: guideTab === tab.key ? 'rgba(139, 92, 246, 0.15)' : 'transparent', border: guideTab === tab.key ? '1px solid #8b5cf6' : '1px solid transparent', borderRadius: 4, padding: '6px 12px', fontSize: 12, fontWeight: 600, color: guideTab === tab.key ? '#cbd5e1' : 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.15s' }}>
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          {guideTab === 'verification' && (
            <div>
              <p style={{ marginTop: 0 }}><strong>How do you know I am actually seeing the exact setup?</strong></p>
              <p>Every trading setup is parsed deterministically using 1-minute historical price bars from your database. The system uses exact mathematical definitions:</p>
              <ul style={{ paddingLeft: 20, margin: '10px 0' }}>
                <li style={{ marginBottom: 6 }}><strong>Chronological Order of Level Touches:</strong> Reconstructed by checking every 1-minute bar's High/Low relative to key levels.</li>
                <li style={{ marginBottom: 6 }}><strong>Initial Balance (IB) Boundaries:</strong> Defined strictly as the high and low range printed during the first 60 minutes of the RTH session (9:30 AM – 10:30 AM ET).</li>
                <li style={{ marginBottom: 6 }}><strong>Value Area Boundaries:</strong> Calculated using the volume profile of the previous session to get the exact VAH, VAL, and POC.</li>
              </ul>
              <div style={{ background: 'rgba(0,0,0,0.15)', padding: 12, borderRadius: 6, border: '1px solid var(--border-color)', marginTop: 12 }}>
                <strong style={{ color: 'var(--text-primary)' }}>🛠 How to visually verify any setup:</strong>
                <p style={{ margin: '4px 0 0 0' }}>Go to the <strong>Chart Review</strong> tab or the <strong>Volume Profile</strong> sub-tab inside the Backtest page. Select or enter the date of any past session. The chart will render the exact Initial Balance (IB) range, overnight boundaries, yesterday's value areas, and draw line markers showing exactly where price touched them and triggered the setups.</p>
              </div>
            </div>
          )}
          {guideTab === 'examples' && (
            <div>
              <p style={{ marginTop: 0 }}>Here are the step-by-step logic walkthroughs of the highest-probability trading setups:</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ background: 'rgba(0,0,0,0.15)', padding: 12, borderRadius: 6, border: '1px solid var(--border-color)' }}>
                  <span style={{ fontSize: 12, color: '#10b981', fontWeight: 700, textTransform: 'uppercase' }}>Setup 1: Gap Down Fill (66% - 69% Probability)</span>
                  <p style={{ margin: '6px 0 4px 0', fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>Trigger: NQ opens below yesterday's low.</p>
                  <p style={{ margin: 0, color: 'var(--text-muted)' }}><strong>The Mechanics:</strong> If the initial opening drive down fails to find aggressive sellers and exhausting volumes are seen, a counter-offensive buy is triggered when the price reclaims the open. The target is yesterday's low (completing the gap fill).<br /><strong>Risk Parameter:</strong> Stop-loss goes at the established session low. Target yesterday's low.</p>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.15)', padding: 12, borderRadius: 6, border: '1px solid var(--border-color)' }}>
                  <span style={{ fontSize: 12, color: '#3b82f6', fontWeight: 700, textTransform: 'uppercase' }}>Setup 2: Trapped Shorts (TRT Long) (58%+ Probability)</span>
                  <p style={{ margin: '6px 0 4px 0', fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>Trigger: An A Down breakout fires but fails to confirm, then price reverses and takes out the IB High.</p>
                  <p style={{ margin: 0, color: 'var(--text-muted)' }}><strong>The Mechanics:</strong> Early sellers break below the IB Low (A Down), but buying pressure absorbs them. When the market reverses and reclaims the opening range high, those sellers are forced to buy to cover, creating a fast short squeeze.<br /><strong>Risk Parameter:</strong> Stop-loss goes at the session low. Target is the T1 expansion level.</p>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.15)', padding: 12, borderRadius: 6, border: '1px solid var(--border-color)' }}>
                  <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700, textTransform: 'uppercase' }}>Setup 3: 10:00 AM Pivot / Turning Point (~52% Probability)</span>
                  <p style={{ margin: '6px 0 4px 0', fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>Trigger: Price prints its daily session High or Low between 9:55 AM and 10:05 AM ET.</p>
                  <p style={{ margin: 0, color: 'var(--text-muted)' }}><strong>The Mechanics:</strong> The first 30 minutes of the session represent the initial retail drive. At 10:00 AM ET, institutional players enter the market, frequently creating a sharp rejection or reversal of the retail drive.<br /><strong>Execution Tip:</strong> Look for visual double tops/bottoms or volume exhaustion bars on the 1-minute chart at exactly 9:58 - 10:02 AM.</p>
                </div>
              </div>
            </div>
          )}
          {guideTab === 'scanning' && (
            <div>
              <p style={{ marginTop: 0 }}><strong>Can you perpetually keep looking at these and new high probability setups?</strong></p>
              <p>Yes! The server runs a perpetual background daemon process. During market hours (9:30 AM – 4:00 PM ET), this daemon acts as a real-time monitor:</p>
              <ul style={{ paddingLeft: 20, margin: '10px 0' }}>
                <li style={{ marginBottom: 6 }}><strong>Continuous Ingestion:</strong> It reads incoming 1-minute price bars as they are exported from Sierra Chart.</li>
                <li style={{ marginBottom: 6 }}><strong>Dynamic Updates:</strong> It updates the developing Value Area, Number Line (NL30), and checks for Initial Balance breakouts in real-time.</li>
                <li style={{ marginBottom: 6 }}><strong>Active Setup Writing:</strong> The moment a setup is mathematically detected, it is immediately written to the <code>active_setups</code> table in the database and broadcasted via WebSockets (Socket.io) to your browser, which flashes the alert on your screen.</li>
              </ul>
              <p>Because this setup is fully automated, the system is constantly looking at the market for you, compiling statistics, and refining target and stop levels based on ATR adjustments.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PatternStatsPanel() {
  const [stats, setStats]   = React.useState([]);
  const [lookback, setLookback] = React.useState(30);
  const [loading, setLoading]   = React.useState(true);
  const [fetchedAt, setFetchedAt] = React.useState(null);

  React.useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/pattern/stats?lookback=${lookback}`)
      .then(r => r.json()).then(d => { setStats(Array.isArray(d) ? d : []); setLoading(false); setFetchedAt(new Date()); })
      .catch(() => setLoading(false));
  }, [lookback]);

  const trendColor = { IMPROVING: '#22c55e', STABLE: '#94a3b8', DEGRADING: '#ef4444' };
  const trendIcon  = { IMPROVING: '↑ IMPROVING', STABLE: '→ STABLE', DEGRADING: '↓ DEGRADING' };
  const stateLabel = { BRACKET: '↔ Bracket', BRACKET_TILTING_UP: '↔ Bracket ↑', BRACKET_TILTING_DOWN: '↔ Bracket ↓', TRENDING_UP: '↑ Trend Up', TRENDING_DOWN: '↓ Trend Down', TRANSITIONAL: '⚡ Transitional' };

  const degrading = stats.filter(s => s.degrading_alert);

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '18px 22px', marginBottom: 20, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Pattern Stats — Rolling Performance by Structural State
            {fetchedAt && <span style={{ marginLeft: 10, fontWeight: 400 }}><FetchStamp at={fetchedAt} /></span>}
          </div>
          <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 2 }}>
            Based on your logged sessions with sufficient data (auction_reads + trades recorded)
            <InfoTooltip tooltip={{ text: 'Performance metrics grouped by structural state (Bracket, Trend, Transitional). Shows how your actual trading has performed in each environment. Updated nightly. Minimum sessions for meaningful stats: 5.', source: 'Based on your logged sessions — not theoretical backtests' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[30, 60, 90].map(d => (
            <button key={d} onClick={() => setLookback(d)}
              style={{ padding: '4px 12px', fontSize: 13, borderRadius: 4, cursor: 'pointer', border: `1px solid ${lookback===d ? '#3b82f6' : 'var(--border-color)'}`, background: lookback===d ? '#3b82f6' : 'var(--input-bg)', color: lookback===d ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {degrading.length > 0 && (
        <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#fca5a5', lineHeight: 1.7 }}>
          <strong style={{ color: '#ef4444' }}>⚠ DEGRADING conditions detected:</strong>{' '}
          {degrading.map(s => `${stateLabel[s.structural_state] || s.structural_state}: win rate dropped vs prior ${lookback}-day window`).join(' · ')}
          <br/><span style={{ color: '#94a3b8' }}>Review your approach in these environments.</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: '#cbd5e1', fontSize: 13 }}>Loading pattern stats…</div>
      ) : stats.length === 0 ? (
        <div style={{ color: '#cbd5e1', fontSize: 13 }}>No pattern stats yet — runs nightly after 4 PM ET. Use the backfill to populate historical data.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
              {['Structural State', 'Sessions', 'Win %', 'Avg P&L', 'T1 Hit %', 'Trend'].map(h => (
                <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#cbd5e1', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => {
              const isDegrad = s.degrading_alert;
              const isImprove = s.win_rate_trend === 'IMPROVING';
              const rowBg = isDegrad ? 'rgba(239,68,68,0.05)' : isImprove ? 'rgba(34,197,94,0.04)' : 'transparent';
              return (
                <tr key={s.structural_state} style={{ borderBottom: '1px solid rgba(100,116,139,0.1)', background: rowBg }}>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', fontWeight: 600 }}>{stateLabel[s.structural_state] || s.structural_state}</td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', fontFamily: 'monospace' }}>{s.total_sessions}</td>
                  <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: s.avg_win_rate >= 0.6 ? '#22c55e' : s.avg_win_rate >= 0.45 ? '#fbbf24' : '#ef4444', fontWeight: 700 }}>
                    {s.avg_win_rate != null ? (s.avg_win_rate * 100).toFixed(1) + '%' : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: s.avg_pnl_per_session > 0 ? '#22c55e' : '#ef4444' }}>
                    {s.avg_pnl_per_session != null ? (s.avg_pnl_per_session > 0 ? '+' : '') + Number(s.avg_pnl_per_session).toFixed(0) : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', fontFamily: 'monospace' }}>
                    {s.t1_hit_rate != null ? (s.t1_hit_rate * 100).toFixed(0) + '%' : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', color: trendColor[s.win_rate_trend] || '#64748b', fontWeight: s.win_rate_trend ? 700 : 400 }}>
                    {s.win_rate_trend ? trendIcon[s.win_rate_trend] : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ConditionBacktestInline() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [fetchedAt, setFetchedAt] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/backtest/conditions`)
      .then(r => r.json()).then(d => { setData(d); setLoading(false); setFetchedAt(new Date()); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 16, color: '#94a3b8', fontFamily: 'Arial, sans-serif', fontSize: 13 }}>Running condition backtest…</div>;
  if (!data?.available) return null;

  const f = data.fades; const a = data.aSignals;
  const log = data.dailyLog || [];

  const structureColor = { BRACKET: '#3b82f6', BRACKET_TILTING_UP: '#fbbf24', BRACKET_TILTING_DOWN: '#fbbf24', TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24' };
  const structureShort = { BRACKET: '↔ Bracket', BRACKET_TILTING_UP: '↔ Tilt ↑', BRACKET_TILTING_DOWN: '↔ Tilt ↓', TRENDING_UP: '↑ Trend', TRENDING_DOWN: '↓ Trend', TRANSITIONAL: '⚡ Trans.' };

  const KEY_FINDINGS = [
    { label: 'Fade VAH — clean bracket', stat: f.vahBracket, note: 'Confirmed bracket (≥4 overlapping days)' },
    { label: 'Fade VAH — bracket tilting up ⚠', stat: f.vahTilting, note: 'Value migrating higher — the trap' },
    { label: 'A Up — NL30 bullish', stat: a.aUpBullish, note: 'Signal with multi-session tailwind' },
    { label: 'A Down — NL30 bullish ⚠', stat: a.aDownBullish, note: 'Counter-trend short in bull environment' },
    { label: 'A Down — NL30 ranging', stat: a.aDownRanging, note: 'Short signal, no trend context' },
  ].filter(x => x.stat);

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '18px 22px', marginBottom: 20, fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Market Structure Backtest — {data.totalDays} Trading Days
            {fetchedAt && <span style={{ marginLeft: 10, fontWeight: 400 }}><FetchStamp at={fetchedAt} /></span>}
          </div>
          <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 2 }}>How well did the playbook's suggested edge actually work per condition?</div>
        </div>
        <button onClick={() => setExpanded(e => !e)}
          style={{ padding: '5px 14px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
          {expanded ? 'Hide day log' : 'Show day log'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 14 }}>
        {KEY_FINDINGS.map(({ label, stat, note }) => {
          const color = stat.winRate >= 60 ? '#22c55e' : stat.winRate >= 45 ? '#fbbf24' : '#ef4444';
          const ptsColor = stat.avgPts > 0 ? '#22c55e' : '#ef4444';
          return (
            <div key={label} style={{ padding: '10px 12px', background: `${color}08`, border: `1px solid ${color}30`, borderRadius: 7 }}>
              <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 4 }}>{label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 800, color, fontFamily: 'monospace' }}>{stat.winRate}%</span>
                <span style={{ fontSize: 13, color: ptsColor, fontFamily: 'monospace' }}>{stat.avgPts > 0 ? '+' : ''}{stat.avgPts}pts avg</span>
              </div>
              <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{stat.wins}/{stat.n} sessions · {note}</div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: expanded ? 14 : 0 }}>
        {f.vahTilting && f.vahTilting.n >= 3 && f.vahTilting.winRate <= 20 && (
          <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
            ⛔ <strong>Fading VAH in a tilting bracket: {f.vahTilting.winRate}% win rate</strong> over {f.vahTilting.n} sessions (avg {f.vahTilting.avgPts}pts). This is the condition that blew you out. The data confirms it — do not fade VAH when value is migrating higher.
          </div>
        )}
        {a.aDownBullish && a.aDownBullish.n >= 3 && a.aDownBullish.avgPts < 0 && (
          <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
            ⛔ <strong>A Down when NL30 bullish: {a.aDownBullish.winRate}% win rate</strong> over {a.aDownBullish.n} sessions (avg {a.aDownBullish.avgPts}pts). Counter-trend shorts in a bull environment have negative expectancy in your data.
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
          <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 8 }}>
            Green = edge worked · Red = edge failed · Gray = no directional bet recommended for that day
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                {['Date','Structure','NL30','Suggested edge','Pts','Outcome'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#cbd5e1', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {log.map((row, i) => (
                <tr key={row.date} style={{ borderBottom: '1px solid rgba(100,116,139,0.1)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', fontFamily: 'monospace', fontSize: 13, whiteSpace: 'nowrap' }}>{row.date}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: structureColor[row.structure] || '#94a3b8', fontWeight: 600, fontSize: 13 }}>{structureShort[row.structure] || row.structure}</span>
                  </td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: row.nl30 > 9 ? '#22c55e' : row.nl30 < -9 ? '#ef4444' : '#fbbf24', fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>
                      {row.nl30 > 0 ? '+' : ''}{row.nl30}
                    </span>
                  </td>
                  <td style={{ padding: '7px 10px', color: '#94a3b8', maxWidth: 280, lineHeight: 1.4, fontSize: 13 }}>{row.suggestedEdge}</td>
                  <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap', color: row.ptsVsOpen > 0 ? '#22c55e' : row.ptsVsOpen < 0 ? '#ef4444' : '#94a3b8' }}>
                    {row.ptsVsOpen > 0 ? '+' : ''}{row.ptsVsOpen}
                  </td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    {row.edgeWorked === true  && <span style={{ color: '#22c55e', fontWeight: 700 }}>✓ Worked</span>}
                    {row.edgeWorked === false && <span style={{ color: '#ef4444', fontWeight: 700 }}>✗ Failed</span>}
                    {row.edgeWorked === null  && <span style={{ color: '#94a3b8' }}>— No bet</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
