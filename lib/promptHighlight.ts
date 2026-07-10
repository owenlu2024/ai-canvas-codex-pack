function escapePromptHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildVisibleTextPromptRichHtml(prompt: string) {
  if (!/(VISIBLE_TEXT_TO_RENDER|画面文字清单|画面文案|ON[-_\s]*IMAGE\s*TEXT|TEXT_RENDERING_RULE|文字渲染规则)/i.test(prompt)) return undefined;

  const lines = prompt.split(/\r?\n/);
  let highlighting = false;
  return lines.map((line) => {
    const isVisibleTextStart = /^\s*(?:【?\s*(?:VISIBLE_TEXT_TO_RENDER|画面文字清单|画面文案|ON[-_\s]*IMAGE\s*TEXT)\s*】?)\s*[:：]?/i.test(line);
    const isTextRule = /^\s*(?:TEXT_RENDERING_RULE|文字渲染规则)\s*[:：]?/i.test(line);
    const startsNextSection = highlighting && line.trim() && (
      /^(?:Image Role References|Image References|Reference Image Usage|Product Lock|Usage|Resolution|Aspect Ratio|Goal|Composition|Lighting|Prompt|Design Style Reference|Downstream Generation Rule)\s*[:：]/i.test(line) ||
      /^(?:参考图用途|引用图片|图片引用|输出规格|用途|分辨率|画幅比例|目标|构图|光影|提示词|风格参考|设计规范|商品锁定)\s*[:：]/.test(line)
      || /^\s*【[^】]+】\s*$/.test(line)
    ) && !/^\s*[-*]/.test(line) && !isTextRule;

    if (isVisibleTextStart) highlighting = true;
    else if (startsNextSection) highlighting = false;

    const escaped = escapePromptHtml(line);
    return (highlighting && !isVisibleTextStart) || isTextRule
      ? `<span style="color:#FF3B30;font-weight:700">${escaped}</span>`
      : escaped;
  }).join("<br>");
}
