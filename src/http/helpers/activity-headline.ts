import { callLlm } from "./llm-client.js";

const ACTIVITY_HEADLINE_MAX_INPUT_CHARS = 8_000;
const DEFAULT_ACTIVITY_HEADLINE_MODEL = "openai/gpt-4.1-nano";

export type ActivityHeadlineSource = "llm" | "heuristic";

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdownLite(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function cleanActivityHeadline(value: string): string {
  const lines = stripMarkdownLite(value)
    .split("\n")
    .map((line) => normalizeSpaces(line))
    .filter((line) => line.length > 0 && !/^\|?[:\-| ]+\|?$/.test(line));
  const headline = lines[0] ?? "";
  if (!headline) return "";
  if (headline.length <= 108) return headline;
  return `${headline.slice(0, 107).trimEnd()}…`;
}

function heuristicActivityHeadline(text: string, title?: string | null): string {
  const cleanedText = cleanActivityHeadline(text);
  if (cleanedText.length > 0) return cleanedText;
  const cleanedTitle = cleanActivityHeadline(title ?? "");
  if (cleanedTitle.length > 0) return cleanedTitle;
  return "Activity update";
}

export async function summarizeActivityHeadline(input: {
  text: string;
  title?: string | null;
  type?: string | null;
}): Promise<{ headline: string; source: ActivityHeadlineSource; model: string | null }> {
  const normalizedText = normalizeSpaces(input.text).slice(0, ACTIVITY_HEADLINE_MAX_INPUT_CHARS);
  const normalizedTitle = normalizeSpaces(input.title ?? "");
  const normalizedType = normalizeSpaces(input.type ?? "");

  const userPrompt = [
    "Create one short activity title for a dashboard header.",
    "Rules:",
    "- Max 96 characters.",
    "- Keep key numbers/status markers (for example: 15 tasks, 0 blocked).",
    "- No markdown, no quotes, no trailing period unless needed.",
    "- Prefer plain language over jargon.",
    "",
    `Type: ${normalizedType || "activity"}`,
    normalizedTitle ? `Current title: ${normalizedTitle}` : "",
    "Full detail:",
    normalizedText,
  ]
    .filter(Boolean)
    .join("\n");

  const model =
    process.env.ORGX_ACTIVITY_SUMMARY_MODEL?.trim() || DEFAULT_ACTIVITY_HEADLINE_MODEL;

  const response = await callLlm(
    {
      taskId: "activity_headline",
      systemPrompt:
        "You write concise activity headers for operational dashboards. Return only the header text.",
      userPrompt,
      model,
      temperature: 0.1,
      maxTokens: 48,
      timeoutMs: 4_000,
    },
    () => heuristicActivityHeadline(normalizedText, normalizedTitle),
    (raw) => cleanActivityHeadline(raw) || null,
  );

  return { headline: response.result, source: response.source, model: response.model };
}
