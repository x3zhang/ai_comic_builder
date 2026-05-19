import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { jsonrepair } from "jsonrepair";
import type { LanguageModel } from "ai";

export interface ProviderConfig {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  modelId: string;
}

export function createLanguageModel(config: ProviderConfig): LanguageModel {
  switch (config.protocol) {
    case "openai": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      return provider.chat(config.modelId);
    }
    case "gemini": {
      const provider = createGoogleGenerativeAI({
        apiKey: config.apiKey,
      });
      return provider(config.modelId);
    }
    default:
      throw new Error(`Unsupported protocol: ${config.protocol}`);
  }
}

/**
 * JSON.parse disallows literal U+0000–U+001F inside double-quoted string values.
 * LLMs often paste screenplay/dialogue with raw newlines. Walk the payload and
 * escape those bytes only while inside a string (honouring JSON backslash escapes).
 */
function escapeControlCharsInsideJsonStrings(jsonLike: string): string {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < jsonLike.length) {
    const c = jsonLike[i]!;

    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      i++;
      continue;
    }

    // inString
    if (c === "\\") {
      out += c;
      i++;
      if (i >= jsonLike.length) break;
      const esc = jsonLike[i]!;
      out += esc;
      i++;
      if ("\"\\/bfnrt".includes(esc)) continue;
      if (esc === "u" && i + 4 <= jsonLike.length) {
        const hex = jsonLike.slice(i, i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += hex;
          i += 4;
        }
      }
      continue;
    }

    if (c === '"') {
      inString = false;
      out += c;
      i++;
      continue;
    }

    const code = c.charCodeAt(0);
    if (code >= 0 && code <= 0x1f) {
      if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += c;
    }
    i++;
  }
  return out;
}

/**
 * Strip markdown code fences from AI response if present.
 */
export function extractJSON(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = match ? match[1].trim() : text.trim();
  // Remove lone control chars that are never valid as raw bytes in JSON text
  const stripped = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return escapeControlCharsInsideJsonStrings(stripped);
}

/**
 * Parse JSON from LLM output: strip fences, escape raw newlines in strings, then
 * JSON.parse; on failure run jsonrepair (trailing commas, truncated edges, etc.).
 */
export function parseJsonFromLlmText(text: string): unknown {
  let s = extractJSON(text);
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  try {
    return JSON.parse(s);
  } catch (e1) {
    const m1 = e1 instanceof Error ? e1.message : String(e1);
    let repaired: string;
    try {
      repaired = jsonrepair(s);
    } catch {
      throw new Error(`JSON parse failed: ${m1}`);
    }
    try {
      return JSON.parse(repaired);
    } catch (e3) {
      const m3 = e3 instanceof Error ? e3.message : String(e3);
      throw new Error(`JSON parse failed: ${m1}; after jsonrepair: ${m3}`);
    }
  }
}

/**
 * Parse a top-level JSON array from LLM output. Tries the full response first
 * (fenced JSON, whole-array body); if that is not an array, falls back to the
 * first `[...]` slice so prose before/after still works. Uses the same repair
 * path as {@link parseJsonFromLlmText}.
 */
export function parseJsonArrayFromLlmText(text: string): unknown[] {
  const tryArray = (s: string): unknown[] | null => {
    try {
      const v = parseJsonFromLlmText(s);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };

  const fromFull = tryArray(text);
  if (fromFull) return fromFull;

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("No JSON array found in model response");
  }

  try {
    const fromSlice = parseJsonFromLlmText(jsonMatch[0]);
    if (Array.isArray(fromSlice)) return fromSlice;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new Error(`JSON array parse failed: ${m}`);
  }

  throw new Error("Model response did not contain a JSON array");
}
