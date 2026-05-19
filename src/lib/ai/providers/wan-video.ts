import type { VideoProvider, VideoGenerateParams, VideoGenerateResult } from "../types";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

// Convert a local file path to a data: URL; http(s) URLs are returned as-is
function toImageUrl(imagePathOrUrl: string): string {
  if (imagePathOrUrl.startsWith("http://") || imagePathOrUrl.startsWith("https://")) {
    return imagePathOrUrl;
  }
  const ext = path.extname(imagePathOrUrl).toLowerCase().replace(".", "");
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/png";
  const base64 = fs.readFileSync(imagePathOrUrl, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

// Map ratio string to wan2.6 size string
function ratioToSize(ratio: string): string {
  const map: Record<string, string> = {
    "16:9": "1280*720",
    "9:16": "720*1280",
    "1:1": "960*960",
    "4:3": "1088*832",
    "3:4": "832*1088",
  };
  return map[ratio] ?? "1280*720";
}

// Normalise ratio to one of the values accepted by wan2.7
function normaliseRatio(ratio: string): string {
  const supported = ["16:9", "9:16", "1:1", "4:3", "3:4"];
  return supported.includes(ratio) ? ratio : "16:9";
}

/** Ensure Base URL is exactly `.../api/v1` (DashScope 要求地域与 API Key 一致). */
function normalizeDashscopeBaseUrl(base: string): string {
  let u = base.trim().replace(/\/+$/, "");
  const servicesIdx = u.indexOf("/services/");
  if (servicesIdx !== -1) u = u.slice(0, servicesIdx);
  if (!/\/api\/v1$/i.test(u)) {
    u = u.replace(/\/api\/?$/i, "");
    if (!u.endsWith("/api/v1")) u = `${u}/api/v1`;
  }
  return u.replace(/\/+$/, "");
}

/** Parse DashScope JSON error body for clearer messages. */
function formatWanSubmitFailure(
  status: number,
  errText: string,
  submitUrl: string,
  bodyModel: string,
): string {
  let apiDetail = errText.trim().slice(0, 800);
  if (apiDetail) {
    try {
      const j = JSON.parse(apiDetail) as {
        message?: string;
        code?: string;
        request_id?: string;
      };
      if (j.message || j.code) {
        apiDetail = [j.code, j.message, j.request_id ? `request_id=${j.request_id}` : ""]
          .filter(Boolean)
          .join(" | ");
      }
    } catch {
      // keep raw text
    }
  } else {
    apiDetail = "(empty response body)";
  }

  const lowerDetail = apiDetail.toLowerCase();
  const looksInvalidKey =
    status === 401 ||
    lowerDetail.includes("invalidapikey") ||
    lowerDetail.includes("invalid api-key");

  let regionHint = "";
  if (status === 404) {
    regionHint =
      " 常见原因：① API Key 与 Base URL 地域不一致（国际/新加坡 Key 须用 https://dashscope-intl.aliyuncs.com/api/v1）；② Base URL 填错或少写了 /api/v1；③ 公司代理把请求转到错误网关。";
  } else if (looksInvalidKey) {
    regionHint =
      " 请核对：① 设置里 **「视频」** 供应商填的是百炼控制台复制的 **API-KEY**（多为 sk- 开头），不要用文本/OpenAI 的 Key、不要用应用 AppId/AppSecret 代替；② 去掉首尾空格后重试；③ 若 Key 在国际/新加坡控制台创建，Base URL 须为 https://dashscope-intl.aliyuncs.com/api/v1；④ 图片能生成仅说明「图片」Key 有效，**视频** 可单独配置另一组 Key/Base URL。";
  }

  return `WanVideo submit failed: HTTP ${status} — ${apiDetail}${regionHint} | POST ${submitUrl} | body.model=${bodyModel}`;
}

/** 万相 2.7 新版图生视频（首帧 / 首尾帧 / 参考图）统一用 wan2.7-i2v，见阿里云文档。 */
const WAN27_IMAGE_MODEL = "wan2.7-i2v";

export class WanVideoProvider implements VideoProvider {
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
      process.env.WAN_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      ""
    ).trim();
    this.baseUrl = normalizeDashscopeBaseUrl(
      params?.baseUrl ||
        process.env.WAN_BASE_URL ||
        "https://dashscope.aliyuncs.com/api/v1",
    );
    this.model = params?.model || process.env.WAN_MODEL || "wan2.1-i2v-plus";
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  // Detect whether this instance is running a wan2.7 model
  private get isWan27(): boolean {
    return this.model.startsWith("wan2.7");
  }

  async generateVideo(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    let body: Record<string, unknown>;

    if ("firstFrame" in params) {
      // ── Keyframe mode ──
      body = this.buildKeyframeBody(
        params as VideoGenerateParams & { firstFrame: string; lastFrame: string }
      );
    } else if (params.initialImage) {
      // ── Reference image mode (initial image, optional extra refs) ──
      body = this.buildReferenceBody(
        params as VideoGenerateParams & { initialImage: string }
      );
    } else {
      // ── Text-to-video mode ──
      body = this.buildTextBody(params);
    }

    console.log(
      `[WanVideo] Submitting task: configuredModel=${this.model}, ratio=${params.ratio}, baseUrl=${this.baseUrl}, body.model=${(body as { model?: string }).model ?? "(none)"}`,
    );

    const submitUrl = `${this.baseUrl}/services/aigc/video-generation/video-synthesis`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => "");
      const bodyModel = String((body as { model?: string }).model ?? "");
      const msg = formatWanSubmitFailure(submitRes.status, errText, submitUrl, bodyModel);
      console.error(`[WanVideo] ${msg}`);
      throw new Error(msg);
    }

    const submitResult = (await submitRes.json()) as {
      output?: { task_id?: string };
    };

    const taskId = submitResult.output?.task_id;
    if (!taskId) {
      throw new Error(
        `WanVideo: no task_id in response: ${JSON.stringify(submitResult)}`
      );
    }

    console.log(`[WanVideo] Task submitted: ${taskId}`);

    const videoUrl = await this.pollForResult(taskId);

    // Download and persist video
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      throw new Error(`WanVideo: failed to download video (${videoRes.status})`);
    }
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const filename = `${genId()}.mp4`;
    const dir = path.join(this.uploadDir, "videos");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    console.log(`[WanVideo] Saved to ${filepath}`);
    return { filePath: filepath };
  }

  // ── Body builders ──────────────────────────────────────────────────────────

  private buildKeyframeBody(
    params: VideoGenerateParams & { firstFrame: string; lastFrame: string }
  ): Record<string, unknown> {
    if (this.isWan27) {
      // 万相 2.7 首尾帧：官方为 wan2.7-i2v + media[]（非 wan2.7-r2v）
      return {
        model: WAN27_IMAGE_MODEL,
        input: {
          prompt: params.prompt,
          media: [
            { type: "first_frame", url: toImageUrl(params.firstFrame) },
            { type: "last_frame", url: toImageUrl(params.lastFrame) },
          ],
        },
        parameters: {
          resolution: "720P",
          ratio: normaliseRatio(params.ratio),
          duration: params.duration || 5,
        },
      };
    }

    // wan2.6 / wan2.1: image-to-video, uses img_url for first frame only
    return {
      model: this.model,
      input: {
        prompt: params.prompt,
        img_url: toImageUrl(params.firstFrame),
      },
      parameters: {
        size: ratioToSize(params.ratio),
        duration: params.duration || 5,
      },
    };
  }

  private buildReferenceBody(
    params: VideoGenerateParams & { initialImage: string }
  ): Record<string, unknown> {
    if (this.isWan27) {
      // wan2.7: reference_image via media[]
      const media: { type: string; url: string }[] = [
        { type: "reference_image", url: toImageUrl(params.initialImage) },
      ];

      if (params.referenceImages && params.referenceImages.length > 0) {
        for (const refImg of params.referenceImages.slice(0, 8)) {
          media.push({ type: "reference_image", url: toImageUrl(refImg) });
        }
      }

      return {
        model: WAN27_IMAGE_MODEL,
        input: {
          prompt: params.prompt,
          media,
        },
        parameters: {
          resolution: "720P",
          ratio: normaliseRatio(params.ratio),
          duration: params.duration || 5,
        },
      };
    }

    // wan2.6 / wan2.1: img_url for initial image
    return {
      model: this.model,
      input: {
        prompt: params.prompt,
        img_url: toImageUrl(params.initialImage),
      },
      parameters: {
        size: ratioToSize(params.ratio),
        duration: params.duration || 5,
      },
    };
  }

  private buildTextBody(params: VideoGenerateParams): Record<string, unknown> {
    // Choose t2v variant: wan2.7-t2v for wan2.7 base, otherwise use model as-is
    const model = this.isWan27 ? "wan2.7-t2v" : this.model;

    if (this.isWan27) {
      return {
        model,
        input: {
          prompt: params.prompt,
        },
        parameters: {
          resolution: "720P",
          ratio: normaliseRatio(params.ratio),
          duration: params.duration || 5,
        },
      };
    }

    return {
      model,
      input: {
        prompt: params.prompt,
      },
      parameters: {
        size: ratioToSize(params.ratio),
        duration: params.duration || 5,
      },
    };
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  private async pollForResult(taskId: string): Promise<string> {
    const maxAttempts = 360;   // 30 min — Wan models are slower
    const interval = 5_000;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      const res = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        console.warn(`[WanVideo] Poll ${i + 1}: HTTP ${res.status}, retrying…`);
        continue;
      }

      const result = (await res.json()) as {
        output?: {
          task_id?: string;
          task_status?: string;
          video_url?: string;
          message?: string;
        };
        usage?: unknown;
      };

      const status = result.output?.task_status ?? "UNKNOWN";
      console.log(`[WanVideo] Poll ${i + 1}: status=${status}`);

      if (status === "SUCCEEDED") {
        const videoUrl = result.output?.video_url;
        if (!videoUrl) {
          throw new Error(
            `WanVideo: SUCCEEDED but no video_url in response: ${JSON.stringify(result)}`
          );
        }
        return videoUrl;
      }

      if (status === "FAILED") {
        throw new Error(
          `WanVideo generation failed: ${result.output?.message ?? "unknown error"}`
        );
      }

      // PENDING / RUNNING → keep polling
    }

    throw new Error("WanVideo generation timed out after 30 minutes");
  }
}
