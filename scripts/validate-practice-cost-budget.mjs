#!/usr/bin/env node

const DAILY_BUDGET_USD = 5.0;

const PRACTICE_DAILY_CAPS_USD = {
  "orgx-engineering": 0.8,
  "orgx-product": 0.7,
  "orgx-design": 0.7,
  "orgx-marketing": 0.7,
  "orgx-sales": 0.6,
  "orgx-operations": 0.7,
  "orgx-orchestrator": 0.7,
};

const entries = Object.entries(PRACTICE_DAILY_CAPS_USD).sort((a, b) => a[0].localeCompare(b[0]));
const total = entries.reduce((sum, [, value]) => sum + value, 0);
const remaining = DAILY_BUDGET_USD - total;
const pass = total <= DAILY_BUDGET_USD;

console.log("OrgX Practice Cost Budget Validation");
console.log("-----------------------------------");
for (const [agentId, cap] of entries) {
  console.log(`${agentId.padEnd(18)} $${cap.toFixed(2)}/day`);
}
console.log("-----------------------------------");
console.log(`Total planned cap: $${total.toFixed(2)}/day`);
console.log(`Budget target:     $${DAILY_BUDGET_USD.toFixed(2)}/day`);
console.log(`Headroom:          $${remaining.toFixed(2)}/day`);
console.log(`Result:            ${pass ? "PASS" : "FAIL"}`);

if (!pass) {
  process.exitCode = 1;
}
