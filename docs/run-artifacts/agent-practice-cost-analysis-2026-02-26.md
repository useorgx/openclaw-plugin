# Agent Practice Cost Analysis (Under $5/day)

- Date: 2026-02-26
- Initiative: `7906cc8b-d60c-43d6-b714-8a91502d6ceb`
- Workstream: `0b28b2ae-3ad0-4066-8a06-7f9be4c0f6df`
- Task target: `Run cost analysis — validate practice runs staying under $5/day total across all agents` (`58c9228d-e23b-4f76-b573-d678069d0bc8`)

## Source Assumptions (from code defaults)

From `src/http/helpers/mission-control.ts`:

- Pricing per 1M tokens:
  - GPT-5.3 Codex proxy: input `$1.75`, cached input `$0.175`, output `$14.00`
  - Opus 4.6: input `$5.00`, cached input `$5.00`, output `$25.00`
- Token shape: `86%` input, `14%` output
- Cached input share: `15%`
- Model mix: `70%` GPT-5.3 Codex proxy, `30%` Opus 4.6
- Contingency multiplier: `1.3`

## Blended Cost Derivation

1. Effective input rate:
- GPT proxy: `1.75 * 0.85 + 0.175 * 0.15 = 1.51375`
- Opus: `5.00 * 0.85 + 5.00 * 0.15 = 5.00`

2. Per-model all-token rate (`86%` input + `14%` output):
- GPT proxy: `0.86 * 1.51375 + 0.14 * 14 = 3.261825` USD / 1M
- Opus: `0.86 * 5 + 0.14 * 25 = 7.8` USD / 1M

3. Blended base rate:
- `0.70 * 3.261825 + 0.30 * 7.8 = 4.6232775` USD / 1M

4. Blended contingency-adjusted rate:
- `4.6232775 * 1.3 = 6.01026075` USD / 1M

## Budget Envelope for $5/day

- Max tokens/day for `$5.00` budget:
  - `5 / 6.01026075 * 1,000,000 = 831,911` tokens/day
- For 7 agents, equal-share daily cap:
  - `831,911 / 7 = 118,844` tokens/day/agent

## Recommended Practice Regimen Cap

Conservative cap that remains under budget:

- `2` practice runs/agent/day
- `50,000` tokens max per run

Daily total:

- Tokens: `7 * 2 * 50,000 = 700,000`
- Estimated cost: `700,000 / 1,000,000 * 6.01026075 = $4.2072/day`
- Budget headroom vs `$5/day`: `$0.7928/day` (~`15.9%`)

## Xandy-Specific Planning Note

For Xandy's daily routing + cross-domain synthesis practice, use:

- Default cap: `50,000` tokens/run
- Soft warning: `40,000` tokens/run
- Stretch cap only when needed: up to `60,000` tokens/run, offset by reducing one lower-priority run elsewhere that day.

This keeps cross-domain synthesis quality room while preserving total portfolio spend.

## Verification

Recompute with:

```bash
node -e "const g={input:1.75,cachedInput:0.175,output:14},o={input:5,cachedInput:5,output:25};const inputShare=0.86,cachedShare=0.15,mixG=0.7,mixO=0.3,cont=1.3;const per=(p)=>inputShare*(p.input*(1-cachedShare)+p.cachedInput*cachedShare)+(1-inputShare)*p.output;const blended=(mixG*per(g)+mixO*per(o))*cont;const tokens=7*2*50000;const cost=tokens/1e6*blended;console.log(JSON.stringify({blendedUsdPer1M:blended,maxTokensAt5:5/blended*1e6,scenarioTokens:tokens,scenarioCostUsd:cost},null,2));"
```

Expected result (rounded):

- `blendedUsdPer1M`: `6.0103`
- `maxTokensAt5`: `~831,911`
- `scenarioTokens`: `700,000`
- `scenarioCostUsd`: `~4.2072`
