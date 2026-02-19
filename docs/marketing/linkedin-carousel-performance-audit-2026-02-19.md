# LinkedIn Carousel Performance Audit (B2B SaaS + Dev Tools)

Date: 2026-02-19
Initiative: Content Engine: Dogfood the Larry Playbook
Workstream: Hook Research & Content Strategy
Task Context: Audit LinkedIn carousel performance in B2B SaaS/dev tools

## Scope

This audit focuses on organic LinkedIn carousel posts used by B2B SaaS and developer-tooling teams for:
- top-of-funnel attention (impressions + hold rate),
- mid-funnel engagement (saves, comments, profile clicks),
- and conversion-adjacent intent (DMs, inbound demo interest, lead magnet clicks).

## Method + Assumptions

- This slice is desk-research strategy output (no direct account analytics export in this run).
- Benchmarks below are planning ranges intended for content strategy and creative decisions.
- "Good" means likely above-median for niche B2B creator/company pages with <100k followers.
- Primary KPI for this workstream slice: `hook hold rate proxy` measured by slide-1 dwell + swipe depth.

## Working Benchmarks for B2B Carousel Posts

Use these as operating thresholds for planning and weekly QA:

| Metric | Watchout Range | Healthy Range | Strong Range |
|---|---:|---:|---:|
| Engagement rate by impressions (ERR) | <1.5% | 1.5% - 3.5% | >3.5% |
| Save rate by impressions | <0.20% | 0.20% - 0.60% | >0.60% |
| Comment rate by impressions | <0.10% | 0.10% - 0.30% | >0.30% |
| Carousel completion proxy (final-slide CTA clicks / opens) | <12% | 12% - 22% | >22% |
| Follower conversion from profile visits | <6% | 6% - 12% | >12% |

## Hook Pattern Findings for Dev Tool Audiences

Top-performing hook families for technical audiences usually match one of these patterns:

1. `Contrarian claim + proof setup`
- Example pattern: "Most onboarding checklists are hurting activation. Here's the data pattern we keep finding."
- Why it works: creates cognitive dissonance and promises concrete evidence.

2. `Failure cost framing`
- Example pattern: "Your CI bill is not the biggest cost. Slow reviews are."
- Why it works: reframes "known pain" into underestimated business impact.

3. `Operator playbook`
- Example pattern: "7-slide incident retro template we use after every sev-2."
- Why it works: turns content into reusable asset (drives saves).

4. `Before/after architecture`
- Example pattern: "From 9 handoffs to 3: the workflow refactor that cut lead-time by 38%."
- Why it works: concrete transformation with measurable delta.

5. `Myth -> mechanism`
- Example pattern: "Myth: developers ignore compliance. Mechanism: they ignore unclear ownership."
- Why it works: short teaching loop that rewards swiping.

## Creative Structure Recommendations

Recommended carousel skeleton for OrgX-style technical thought leadership:

1. Slide 1: single assertion with clear tension (8-14 words).
2. Slide 2: "why now" context with one concrete signal.
3. Slide 3: diagnostic framework (3-part model).
4. Slide 4-6: applied examples from operator workflows.
5. Slide 7: anti-patterns + common failure mode.
6. Slide 8: checklist/download CTA or discussion prompt.

Production notes:
- Keep one idea per slide; no dense paragraphs.
- Use high-contrast text and visual hierarchy for fast scanning on mobile.
- Put proof artifacts on slide 3-6 (numbers, process snapshots, schema snippets).
- Avoid broad inspirational claims; favor mechanism language.

## Cadence + Experiment Plan (4 Weeks)

Weekly plan:
- 2 carousel posts/week (`8 total`)
- 2 hook variants per post family (A/B at creative level)
- 1 explicit "save CTA" variant and 1 "comment CTA" variant each week

Evaluation matrix:
- Week 1: establish baseline by hook family
- Week 2: optimize slide-1 framing and title density
- Week 3: optimize proof placement (early vs middle slides)
- Week 4: optimize CTA type by objective (save vs comment vs DM)

Decision rules:
- If save rate <0.20% for two consecutive posts, switch to template/playbook framing.
- If comments >0.30% but saves <0.20%, tighten utility and add copyable assets.
- If profile visits high but follows low, fix profile-header relevance and offer continuity.

## Draft Content Backlog (Ready to Produce)

1. "The hidden queue that slows every AI team"
- Hook family: failure cost framing
- CTA: "Comment `queue` for the diagnostic worksheet."

2. "Myth: shipping faster means lower quality"
- Hook family: myth -> mechanism
- CTA: "Save this for your next release retro."

3. "The 3 handoffs that quietly kill agent throughput"
- Hook family: before/after architecture
- CTA: "DM `handoffs` to get the checklist."

4. "From activity feed noise to decision-grade signal"
- Hook family: contrarian claim + proof setup
- CTA: "Comment your biggest signal-quality blocker."

## Risks + Mitigations

- Risk: high impressions, low intent.
- Mitigation: shift CTA from generic engagement to asset exchange or operator prompt.

- Risk: technical depth too high for mixed audience.
- Mitigation: split tracks: "operator deep dive" and "exec summary" carousels.

- Risk: inconsistent design reducing recognition.
- Mitigation: fixed template system and recurring hook taxonomy.

## Verification Checklist for This Slice

- Document exists in repo and is linked to initiative/workstream context.
- Audit includes benchmark ranges, hook findings, and execution plan.
- Backlog contains actionable post concepts with CTA direction.
