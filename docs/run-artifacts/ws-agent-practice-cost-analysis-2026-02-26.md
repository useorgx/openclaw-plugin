# WS Slice Cost Analysis: Agent Practice Regimens

Date: 2026-02-26
Workstream: Agent Practice Regimens (`0b28b2ae-3ad0-4066-8a06-7f9be4c0f6df`)
Task target: Run cost analysis under `$5/day` total (`58c9228d-e23b-4f76-b573-d678069d0bc8`)

## Scope

Validated daily practice-run cost ceiling for all 7 agents using this repo's existing mission-control token-cost assumptions from `src/http/helpers/mission-control.ts`.

## Method

Added CLI utility:
- `scripts/validate-practice-cost-cap.mjs`

Utility mirrors current default assumptions:
- tokens/hour: `1,200,000`
- input share: `0.86`
- cached input share: `0.15`
- contingency multiplier: `1.3`
- model mix: `70%` GPT-5.3 Codex proxy + `30%` Opus 4.6

## Verification Runs

Command:

```bash
node scripts/validate-practice-cost-cap.mjs --agents=7 --minutes_per_agent=10 --cap_usd=5
```

Observed:
- projected daily cost: `$8.4144`
- result: `FAIL` (over cap by `$3.4144`)

Ceiling check:

```bash
for m in 5 6 7; do node scripts/validate-practice-cost-cap.mjs --agents=7 --minutes_per_agent=$m --cap_usd=5 || true; done
```

Observed:
- `5` min/agent/day => `$4.2072` (`PASS`)
- `6` min/agent/day => `$5.0486` (`FAIL`)
- `7` min/agent/day => `$5.8901` (`FAIL`)

## Conclusion

Under current default pricing assumptions in the plugin, the safe practice budget is:
- **max 5 minutes per agent/day** across 7 agents to stay below `$5/day` total.

If a 10-minute daily regimen is required, either:
- lower token throughput assumptions, or
- override budget env pricing/mix assumptions, or
- raise the daily cap above `$8.42`.
