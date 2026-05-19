import type { AIProvider, TextOptions, ImageOptions } from "../types";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Model family detection ──────────────────────────────────────────────────

type ModelFamily = "wan" | "qwen" | "zimage";

function getModelFamily(model: string): ModelFamily {
  if (model.startsWith("wan")) return "wan";
  if (model.startsWith("z-image")) return "zimage";
  return "qwen"; // qwen-image-*
}

// ── Aspect-ratio → pixel size mappings ──────────────────────────────────────

const WAN_ASPECT_RATIO_MAP: Record<string, string> = {
  "1:1": "1024*1024",
  "16:9": "1280*720",
  "9:16": "720*1280",
  "4:3": "1024*768",
  "3:4": "768*1024",
  "3:2": "1080*720",
  "2:3": "720*1080",
};

const QWEN_ASPECT_RATIO_MAP: Record<string, string> = {
  "1:1": "2048*2048",
  "16:9": "2048*1152",
  "9:16": "1152*2048",
  "4:3": "2048*1536",
  "3:4": "1536*2048",
  "3:2": "2048*1365",
  "2:3": "1365*2048",
};

const ZIMAGE_ASPECT_RATIO_MAP: Record<string, string> = {
  "1:1": "1024*1024",
  "16:9": "1536*1024",
  "9:16": "1024*1536",
  "4:3": "1024*768",
  "3:4": "768*1024",
  "3:2": "1536*1024",
  "2:3": "1024*1536",
};

/** DashScope expects `width*height`; callers often pass OpenAI-style `WxH`. */
function normalizeDashScopePixelSize(size: string): string {
  const trimmed = size.trim();
  const m = trimmed.match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (m) return `${m[1]}*${m[2]}`;
  return trimmed;
}

/** Parse `W*H` or `WxH` (after normalize) into pixels. */
function parsePixelPair(size: string): { w: number; h: number } | null {
  const s = normalizeDashScopePixelSize(size);
  const m = s.match(/^(\d+)\*(\d+)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  return { w, h };
}

/** qwen-image-* (e.g. qwen-image-max): each side must stay in [512, 2048]. */
function isWithinQwenImageBounds(w: number, h: number): boolean {
  return w >= 512 && h >= 512 && w <= 2048 && h <= 2048;
}

function mapAspectToSize(
  family: ModelFamily,
  aspectRatio: string,
): string | undefined {
  switch (family) {
    case "wan":
      return WAN_ASPECT_RATIO_MAP[aspectRatio];
    case "qwen":
      return QWEN_ASPECT_RATIO_MAP[aspectRatio];
    case "zimage":
      return ZIMAGE_ASPECT_RATIO_MAP[aspectRatio];
  }
}

function resolveSize(
  family: ModelFamily,
  size?: string,
  aspectRatio?: string,
): string | undefined {
  if (size) {
    const normalized = normalizeDashScopePixelSize(size);
    if (family === "qwen") {
      const pair = parsePixelPair(normalized);
      if (pair && isWithinQwenImageBounds(pair.w, pair.h)) {
        return normalized;
      }
      // Callers often pass OpenAI cinema sizes (e.g. 2560x1440); qwen-image API caps at 2048 per side.
    } else {
      return normalized;
    }
  }

  if (aspectRatio) {
    const mapped = mapAspectToSize(family, aspectRatio);
    if (mapped) return mapped;
  }

  switch (family) {
    case "wan":
      return "1024*1024";
    case "qwen":
      return "2048*2048";
    case "zimage":
      return "1024*1536";
  }
}

// ── DashScope response types ────────────────────────────────────────────────

interface DashScopeImageResponse {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{ image?: string }>;
      };
    }>;
  };
  code?: string;
  message?: string;
}

/** Aliyun DashScope multimodal image API — JSON error body on non-2xx. */
function tryParseDashScopeErrorBody(
  errText: string,
): { code?: string; message?: string } | null {
  try {
    const j = JSON.parse(errText) as { code?: string; message?: string };
    if (j && typeof j === "object" && (j.code != null || j.message != null)) {
      return j;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** User-facing / log-friendly text for known DashScope image error codes. */
function formatDashScopeImageApiError(
  code: string | undefined,
  message: string | undefined,
): string {
  switch (code) {
    case "DataInspectionFailed":
      return [
        "阿里云内容安全审核未通过（DataInspectionFailed）。",
        "常见原因：镜头描述、首尾帧提示词、台词或剧情中含暴力/敏感等表述；或注入的角色参考图被判定不适宜。",
        "请改写该镜头的 scene 与首尾帧描述（可弱化冲突描写、避免露骨词汇）后重试；若仍失败可尝试更换参考图或关闭部分角色参考。",
        `官方说明: ${message ?? "见阿里云文档 inappropriate-content"}`,
      ].join(" ");
    default:
      if (!code) return message ?? "unknown";
      return `DashScope image error [${code}]: ${message ?? "unknown"}`;
  }
}

// ── Provider ────────────────────────────────────────────────────────────────

export class DashScopeImageProvider implements AIProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private uploadDir: string;

  constructor(params?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    uploadDir?: string;
  }) {
    this.apiKey = (
      params?.apiKey ||
      process.env.DASHSCOPE_API_KEY ||
      ""
    ).trim();
    this.baseUrl = (
      params?.baseUrl ||
      process.env.DASHSCOPE_BASE_URL ||
      "https://dashscope.aliyuncs.com/api/v1"
    ).replace(/\/+$/, "");
    this.model =
      params?.model || process.env.DASHSCOPE_IMAGE_MODEL || "qwen-image-2.0-pro";
    this.uploadDir =
      params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  async generateText(
    _prompt: string,
    _options?: TextOptions,
  ): Promise<string> {
    throw new Error("DashScope image models do not support text generation");
  }

  async generateImage(
    prompt: string,
    options?: ImageOptions,
  ): Promise<string> {
    const model = options?.model || this.model;
    const family = getModelFamily(model);
    const size = resolveSize(family, options?.size, options?.aspectRatio);

    // Build parameters object based on model family
    const parameters: Record<string, unknown> = {};
    if (size) parameters.size = size;

    switch (family) {
      case "wan":
        parameters.n = 1;
        break;
      case "qwen":
        parameters.n = 1;
        break;
      case "zimage":
        // z-image-turbo does not support n parameter
        break;
    }

    const body = {
      model,
      input: {
        messages: [
          {
            role: "user",
            content: [{ text: prompt }],
          },
        ],
      },
      parameters,
    };

    console.log(
      `[DashScopeImage] Generating: model=${model}, family=${family}, size=${size}`,
    );

    const url = `${this.baseUrl}/services/aigc/multimodal-generation/generation`;
    const max429Attempts = 8;
    let res: Response | undefined;
    let errText = "";

    for (let attempt = 0; attempt < max429Attempts; attempt++) {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) break;

      errText = await res.text().catch(() => "");
      const is429 = res.status === 429;
      const isThrottling =
        is429 ||
        errText.includes("Throttling") ||
        errText.includes("RateQuota");

      if (isThrottling && attempt < max429Attempts - 1) {
        let waitMs =
          2000 * 2 ** attempt + Math.floor(Math.random() * 1000);
        const ra = res.headers.get("Retry-After");
        if (ra) {
          const sec = Number.parseInt(ra, 10);
          if (!Number.isNaN(sec) && sec > 0) {
            waitMs = Math.max(waitMs, sec * 1000);
          }
        }
        console.warn(
          `[DashScopeImage] ${res.status} rate limit (${attempt + 1}/${max429Attempts}), waiting ${Math.round(waitMs / 1000)}s…`,
        );
        await sleep(waitMs);
        continue;
      }

      const parsed = tryParseDashScopeErrorBody(errText);
      throw new Error(
        parsed?.code
          ? formatDashScopeImageApiError(parsed.code, parsed.message)
          : `DashScope image request failed: ${res.status} ${errText}`,
      );
    }

    if (!res?.ok) {
      const parsed = tryParseDashScopeErrorBody(errText);
      throw new Error(
        parsed?.code
          ? formatDashScopeImageApiError(parsed.code, parsed.message)
          : `DashScope image request failed: ${errText || "unknown"}`,
      );
    }

    const json = (await res.json()) as DashScopeImageResponse;

    // Check for API-level error
    if (json.code) {
      throw new Error(formatDashScopeImageApiError(json.code, json.message));
    }

    const imageUrl =
      json.output?.choices?.[0]?.message?.content?.[0]?.image;
    if (!imageUrl) {
      throw new Error(
        `DashScope image: no image URL in response: ${JSON.stringify(json)}`,
      );
    }

    // Download and save to local storage
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      throw new Error(
        `DashScope image: failed to download image (${imageRes.status})`,
      );
    }
    const buffer = Buffer.from(await imageRes.arrayBuffer());
    const ext = imageUrl.split("?")[0].split(".").pop() || "png";
    const filename = `${genId()}.${ext}`;
    const dir = path.join(this.uploadDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    console.log(`[DashScopeImage] Saved to ${filepath}`);
    return filepath;
  }
}
