# Audit of Grok's critique of the AMT runs (2026-10-28)

Source: the user pasted Grok's answer to the self-contained prompt (no file access, so it reviewed the described design, not the code). Checked against this repo's code and results. To be compared with Gemini (`GEMINI_CRITIQUE_AUDIT_20261028.md`) and the queued DeepSeek critique.

## Agrees with Gemini (adopt)
Outcome mismatch (fixed-window drift vs structural outcomes) ranked first; acceptance should be time and volume not one close; a 65-point zig-zag is not an AMT turn; pooling without day-type stratification; predictive AMT is unproven (descriptive is near-tautological); hindsight-free checkpoints (10:30 / 11:30 / 13:00) with outcomes measured only afterward; at most 4-6 faithful tests; hold-out sealed and opened once; the TPO 80% rule first; ask the trader how they actually use AMT.
Useful additions: open the hold-out once for the WHOLE battery after it is frozen (not per test); a pre-registered battery should stop when successive nulls are consistent; require TPO and volume value areas to agree before any "value" claim.

## Errors / weak points (do not adopt as written)
- **Test 2 is undefined at its own decision time:** "at 10:30 classify 0, 1 or >=2 extensions of the IB". The IB ends at 10:29, so an extension count at 10:30 is always 0. The state needs a later checkpoint (for example 11:30).
- **"Poor high / poor low (single-print extremes)" is a terminology error.** In AMT, single prints at an extreme are EXCESS (a tail); a POOR extreme is the absence of excess (flat, multiple-TPO top or bottom). Gemini defined it correctly.
- **"Not testable: true excess ... composite multi-day profiles":** wrong. The PRIOR session's profile is complete at the next open, so its excess and poor extremes are fully known and testable for next-day behaviour; multi-day composite profiles are computable from the 1-minute bars we have. (Developing excess within the day is checkpoint-testable too.)
- **Test 3's outcome ("new extreme of the day before 15:00") is partly circular:** an accepted excursion beyond a reference very often IS the day's extreme.
- **Acceptance fix is circular:** "derive time-outside X from quantiles of time-outside on prior ACCEPTED excursions" uses the label to define the label; and "volume >= Y% of the reference node's volume" is undefined for a prior value-area edge.
- **"Opens outside value are the high-signal cases" is asserted, not shown:** S1 already included every open outside value (ABOVE/BELOW) and found nothing on open-to-close drift (a different outcome, so not decisive, but the claim is unsupported).
- **Thresholds still hand-picked:** "support if hold-out excess >= +10 pp", "cost-adjusted floor 0.03-0.04 ATR20", "X ticks". Directionally sensible, not data-derived.
- **Its alternative (volatility / range-expansion framework) is not new here:** overnight range -> wider RTH range was found in Part A, a GARCH volatility-regime monitor and a volatility-regime EV effect already exist in this repo, and range prediction gives size and stops but not direction. It answers sizing, not entries.
- **"Earlier 80% rule test ... does speak against a naive version":** slightly too strong; VBP Test B was NOT SHOWN with a resolution of about 17 points, not a rejection.
- Its statement that no rigorous predictive study of AMT states exists is plausible but unverifiable here; treat it as an unsupported literature claim.
- Power figure for Test 1 (about 10 pp detectable at 150 events) checks out arithmetically (binomial SE about 4 pp, 80% power).
