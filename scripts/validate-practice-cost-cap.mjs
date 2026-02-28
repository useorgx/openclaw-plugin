#!/usr/bin/env node

import process from "node:process";

function pickString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readEnvNumber(name, fallback, bounds = {}) {
  const raw = pickString(process.env[name]);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (typeof bounds.min === "number" && parsed < bounds.min) return fallback;
  if (typeof bounds.max === "number" && parsed > bounds.max) return fallback;
  return parsed;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    if (!key) continue;
    if (rest.length > 0) {
      out[key] = rest.join("=");
      continue;
    }
    const next = argv[i + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = "true";
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const agents = Math.max(1, readNumber(args.agents, 7));
const minutesPerAgent = Math.max(0, readNumber(args.minutes_per_agent, 10));
const capUsd = Math.max(0, readNumber(args.cap_usd, 5));

const pricing = {
  gpt53CodexProxy: {
    input: readEnvNumber("ORGX_BUDGET_GPT53_CODEX_INPUT_PER_1M", 1.75, { min: 0 }),
    cachedInput: readEnvNumber("ORGX_BUDGET_GPT53_CODEX_CACHED_INPUT_PER_1M", 0.175, { min: 0 }),
    output: readEnvNumber("ORGX_BUDGET_GPT53_CODEX_OUTPUT_PER_1M", 14, { min: 0 }),
  },
  opus46: {
    input: readEnvNumber("ORGX_BUDGET_OPUS46_INPUT_PER_1M", 5, { min: 0 }),
    cachedInput: readEnvNumber("ORGX_BUDGET_OPUS46_CACHED_INPUT_PER_1M", 5, { min: 0 }),
    output: readEnvNumber("ORGX_BUDGET_OPUS46_OUTPUT_PER_1M", 25, { min: 0 }),
  },
};

const assumptions = {
  tokensPerHour: readEnvNumber("ORGX_BUDGET_TOKENS_PER_HOUR", 1_200_000, { min: 1 }),
  inputShare: readEnvNumber("ORGX_BUDGET_INPUT_TOKEN_SHARE", 0.86, { min: 0, max: 1 }),
  cachedInputShare: readEnvNumber("ORGX_BUDGET_CACHED_INPUT_SHARE", 0.15, { min: 0, max: 1 }),
  contingencyMultiplier: readEnvNumber("ORGX_BUDGET_CONTINGENCY_MULTIPLIER", 1.3, { min: 0.1 }),
};

const mix = {
  gpt53CodexProxy: readNumber(args.codex_mix, 0.7),
  opus46: readNumber(args.opus_mix, 0.3),
};

const mixTotal = mix.gpt53CodexProxy + mix.opus46;
const normalizedMix = mixTotal > 0
  ? {
      gpt53CodexProxy: mix.gpt53CodexProxy / mixTotal,
      opus46: mix.opus46 / mixTotal,
    }
  : { gpt53CodexProxy: 0.7, opus46: 0.3 };

function modelCostPerMillionTokensUsd(modelPricing) {
  const outputShare = Math.max(0, 1 - assumptions.inputShare);
  const uncachedShare = Math.max(0, 1 - assumptions.cachedInputShare);
  const effectiveInputRate =
    modelPricing.input * uncachedShare + modelPricing.cachedInput * assumptions.cachedInputShare;
  return assumptions.inputShare * effectiveInputRate + outputShare * modelPricing.output;
}

const blendedPerMillionUsd =
  normalizedMix.gpt53CodexProxy * modelCostPerMillionTokensUsd(pricing.gpt53CodexProxy) +
  normalizedMix.opus46 * modelCostPerMillionTokensUsd(pricing.opus46);

const tokensPerMinute = assumptions.tokensPerHour / 60;
const totalMinutes = agents * minutesPerAgent;
const dailyTokens = totalMinutes * tokensPerMinute;
const projectedUsd =
  (dailyTokens / 1_000_000) * blendedPerMillionUsd * assumptions.contingencyMultiplier;

const output = {
  pass: projectedUsd <= capUsd,
  capUsd: Number(capUsd.toFixed(4)),
  projectedDailyUsd: Number(projectedUsd.toFixed(4)),
  deltaUsd: Number((capUsd - projectedUsd).toFixed(4)),
  input: {
    agents,
    minutesPerAgent,
    totalMinutes,
  },
  assumptions: {
    tokensPerHour: assumptions.tokensPerHour,
    inputShare: assumptions.inputShare,
    cachedInputShare: assumptions.cachedInputShare,
    contingencyMultiplier: assumptions.contingencyMultiplier,
    modelMix: normalizedMix,
    blendedPerMillionUsd: Number(blendedPerMillionUsd.toFixed(4)),
  },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!output.pass) process.exitCode = 2;
