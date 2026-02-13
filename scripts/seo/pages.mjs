import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDir, writeText } from "./util.mjs";
import { inferIntent } from "./cluster.mjs";

function safeSlug(input) {
  return String(input ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function fillTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ""));
  }
  return out;
}

function defaultSchema({ brandName, pageUrl, pageTitle, primaryKeyword }) {
  const now = new Date().toISOString();
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: pageTitle,
    description: `${pageTitle} — ${brandName}`,
    url: pageUrl,
    dateModified: now,
    about: primaryKeyword,
  };
}

export function generateLandingPages({
  outDir,
  templatePath,
  target,
  calendarRows,
}) {
  const tpl = readFileSync(templatePath, "utf8");
  ensureDir(outDir);

  const written = [];
  for (const row of calendarRows) {
    const primary = row.primary_keyword;
    const intent = inferIntent(primary);
    const slug = row.slug || safeSlug(primary);
    const title = row.title || `${primary} | ${target.brandName}`;
    const h1 = row.h1 || primary;
    const pageUrl = `https://${target.domain}/${slug}`;

    const schema = defaultSchema({
      brandName: target.brandName,
      pageUrl,
      pageTitle: title,
      primaryKeyword: primary,
    });

    const vars = {
      slug,
      title,
      meta_description:
        row.meta_description ||
        `${target.brandName} for ${primary}. ${target.productOneLiner}`,
      primary_keyword: primary,
      cluster_id: row.cluster_id || "",
      h1,
      intro:
        row.intro ||
        `This page targets the "${intent}" intent for **${primary}**. Replace this intro with product-specific copy and proof.`,
      benefit_1: row.benefit_1 || "Clear visibility into work in progress",
      benefit_2: row.benefit_2 || "Faster execution with guardrails",
      benefit_3: row.benefit_3 || "Lower cost via smart routing and reuse",
      use_cases:
        row.use_cases ||
        `Add 3-5 concrete use cases for "${primary}" and link to the relevant product docs.`,
      how_it_works:
        row.how_it_works ||
        "Explain the 3-step flow (connect, run, monitor). Add screenshots and a short GIF where possible.",
      faq_q1: row.faq_q1 || `What is ${primary}?`,
      faq_a1:
        row.faq_a1 ||
        `Define the term in 2-3 sentences, then show how ${target.brandName} helps.`,
      faq_q2: row.faq_q2 || `How do I get started with ${primary}?`,
      faq_a2:
        row.faq_a2 ||
        "Provide a minimal setup checklist and link to onboarding docs.",
      faq_q3: row.faq_q3 || `Is ${primary} worth it for small teams?`,
      faq_a3:
        row.faq_a3 ||
        "Answer with a concrete example and a short ROI statement.",
      schema_json: JSON.stringify(schema, null, 2),
    };

    const content = fillTemplate(tpl, vars);
    const filename = join(outDir, `${slug}.md`);
    writeText(filename, content);
    written.push({ slug, filename });
  }

  return written;
}

