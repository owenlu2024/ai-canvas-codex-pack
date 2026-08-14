const h3SectionOrder = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "integrated_multimodal_description",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music"
] as const;

function displayKey(key: string) {
  const trimmed = key.trim();
  if (/^(?:Picture|Subject|Video|Audio)\s*\d+$/i.test(trimmed)) return `<${trimmed}>`;
  return trimmed;
}

function scalarText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function renderStructuredValue(value: unknown, depth = 0): string {
  const scalar = scalarText(value);
  if (scalar) return scalar;
  if (Array.isArray(value)) {
    return value
      .map((item) => renderStructuredValue(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const orderedKeys = depth === 0
    ? [...h3SectionOrder.filter((key) => key in record), ...keys.filter((key) => !h3SectionOrder.includes(key as typeof h3SectionOrder[number]))]
    : keys;
  return orderedKeys
    .map((key) => {
      const rendered = renderStructuredValue(record[key], depth + 1);
      if (!rendered) return "";
      const label = displayKey(key);
      return rendered.includes("\n") || (record[key] && typeof record[key] === "object")
        ? `${label}:\n${rendered}`
        : `${label}: ${rendered}`;
    })
    .filter(Boolean)
    .join(depth === 0 ? "\n\n" : "\n");
}

function parseJsonCandidate(value: string) {
  const cleaned = value.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  const candidates = [cleaned];
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) candidates.push(cleaned.slice(jsonStart, jsonEnd + 1));
  for (const candidate of candidates) {
    try {
      return { cleaned, parsed: JSON.parse(candidate) as unknown };
    } catch {
      // Compatible LLM APIs may return plain text even when JSON mode was requested.
    }
  }
  return { cleaned, parsed: undefined };
}

export function normalizeMinimaxH3Prompt(value: string) {
  const { cleaned, parsed } = parseJsonCandidate(value);
  if (parsed === undefined) return cleaned;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "prompt" in parsed) {
    const promptValue = (parsed as Record<string, unknown>).prompt;
    if (typeof promptValue === "string") {
      const nested = parseJsonCandidate(promptValue);
      return nested.parsed === undefined ? nested.cleaned : renderStructuredValue(nested.parsed).trim();
    }
    return renderStructuredValue(promptValue).trim();
  }
  return renderStructuredValue(parsed).trim();
}

export function looksLikeUnparsedJsonPrompt(value: string) {
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}
