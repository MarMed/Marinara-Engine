// ──────────────────────────────────────────────
// Routes: Text-to-Speech
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ttsConfigSchema,
  TTS_SETTINGS_KEY,
  TTS_API_KEY_MASK,
  type TTSSource,
  type TTSConfig,
  type TTSVoicesResponse,
} from "@marinara-engine/shared";
import { createAppSettingsStorage } from "../services/storage/app-settings.storage.js";
import { encryptApiKey, decryptApiKey } from "../utils/crypto.js";
import { isTtsLocalUrlsEnabled } from "../config/runtime-config.js";
import { safeFetch } from "../utils/security.js";

// OpenAI built-in voices used as fallback when the provider has no /audio/voices endpoint
const OPENAI_FALLBACK_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

const TTS_SOURCE_DEFAULTS: Record<TTSSource, { baseUrl: string; model: string }> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "tts-1",
  },
  elevenlabs: {
    baseUrl: "https://api.elevenlabs.io",
    model: "eleven_multilingual_v2",
  },
  pockettts: {
    baseUrl: "http://localhost:8000",
    model: "pocket-tts",
  },
  nanogpts: {
    baseUrl: "https://nano-gpt.com/api/v1",
    model: "Kokoro-82m",
  },
};

const ELEVENLABS_NON_TTS_MODELS = new Set(["eleven_ttv_v3", "eleven_multilingual_ttv_v2"]);
const ELEVENLABS_TTS_MODEL_ALIASES: Record<string, string> = {
  tts_v3: "eleven_v3",
  elevenlabs_v3: "eleven_v3",
  elevenlabs_tts_v3: "eleven_v3",
};
const NANOGPT_TTS_MODEL_ALIASES: Record<string, string> = {
  eleven_v3: "Elevenlabs-V3",
  "elevenlabs-v3": "Elevenlabs-V3",
  elevenlabs_v3: "Elevenlabs-V3",
  elevenlabs_tts_v3: "Elevenlabs-V3",
  eleven_turbo_v2_5: "Elevenlabs-Turbo-V2.5",
  eleven_flash_v2_5: "Elevenlabs-Turbo-V2.5",
};
const NANOGPT_ELEVENLABS_VOICES = [
  "Adam",
  "Alice",
  "Antoni",
  "Aria",
  "Arnold",
  "Bella",
  "Bill",
  "Brian",
  "Callum",
  "Charlie",
  "Charlotte",
  "Chris",
  "Daniel",
  "Domi",
  "Dorothy",
  "Drew",
  "Elli",
  "Emily",
  "Eric",
  "Ethan",
  "Fin",
  "Freya",
  "George",
  "Gigi",
  "Giovanni",
  "Grace",
  "James",
  "Jeremy",
  "Jessica",
  "Joseph",
  "Josh",
  "Laura",
  "Liam",
  "Lily",
  "Matilda",
  "Matthew",
  "Michael",
  "Nicole",
  "Rachel",
  "River",
  "Roger",
  "Ryan",
  "Sam",
  "Sarah",
  "Thomas",
  "Will",
];
const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;

const speakSchema = z.object({
  text: z.string().min(1).max(4096),
  speaker: z.string().max(120).optional(),
  tone: z.string().max(80).optional(),
  voice: z.string().max(200).optional(),
});

type VoiceOption = NonNullable<TTSVoicesResponse["voiceOptions"]>[number];

// ── Helpers ─────────────────────────────────────

function parseStoredConfig(raw: string | null) {
  if (!raw) return ttsConfigSchema.parse({});
  try {
    return ttsConfigSchema.parse(JSON.parse(raw));
  } catch {
    return ttsConfigSchema.parse({});
  }
}

/**
 * Resolve the stored config and decrypt the API key.
 * Returns config with the plain-text key (never sent to client).
 */
async function loadConfig(storage: ReturnType<typeof createAppSettingsStorage>) {
  const raw = await storage.get(TTS_SETTINGS_KEY);
  const cfg = parseStoredConfig(raw);
  cfg.apiKey = decryptApiKey(cfg.apiKey);
  return cfg;
}

function responseFromVoiceOptions(
  source: TTSSource,
  voiceOptions: VoiceOption[],
  fromProvider: boolean,
): TTSVoicesResponse {
  return {
    voices: voiceOptions.map((v) => v.id),
    voiceOptions,
    fromProvider,
    source,
  };
}

const KOKORO_VOICES = [
  // American English (Female)
  { id: "af_heart", name: "af_heart (US Female - Heart)", category: "Kokoro US Female" },
  { id: "af_alloy", name: "af_alloy (US Female - Alloy)", category: "Kokoro US Female" },
  { id: "af_bella", name: "af_bella (US Female - Bella)", category: "Kokoro US Female" },
  { id: "af_nicole", name: "af_nicole (US Female - Nicole)", category: "Kokoro US Female" },
  { id: "af_sarah", name: "af_sarah (US Female - Sarah)", category: "Kokoro US Female" },
  { id: "af_sky", name: "af_sky (US Female - Sky)", category: "Kokoro US Female" },
  { id: "af_aoede", name: "af_aoede (US Female - Aoede)", category: "Kokoro US Female" },
  { id: "af_jessica", name: "af_jessica (US Female - Jessica)", category: "Kokoro US Female" },
  { id: "af_kore", name: "af_kore (US Female - Kore)", category: "Kokoro US Female" },
  { id: "af_nova", name: "af_nova (US Female - Nova)", category: "Kokoro US Female" },
  { id: "af_river", name: "af_river (US Female - River)", category: "Kokoro US Female" },

  // American English (Male)
  { id: "am_adam", name: "am_adam (US Male - Adam)", category: "Kokoro US Male" },
  { id: "am_michael", name: "am_michael (US Male - Michael)", category: "Kokoro US Male" },
  { id: "am_echo", name: "am_echo (US Male - Echo)", category: "Kokoro US Male" },
  { id: "am_eric", name: "am_eric (US Male - Eric)", category: "Kokoro US Male" },
  { id: "am_fenrir", name: "am_fenrir (US Male - Fenrir)", category: "Kokoro US Male" },
  { id: "am_liam", name: "am_liam (US Male - Liam)", category: "Kokoro US Male" },
  { id: "am_onyx", name: "am_onyx (US Male - Onyx)", category: "Kokoro US Male" },
  { id: "am_puck", name: "am_puck (US Male - Puck)", category: "Kokoro US Male" },
  { id: "am_santa", name: "am_santa (US Male - Santa)", category: "Kokoro US Male" },

  // British English (Female)
  { id: "bf_emma", name: "bf_emma (UK Female - Emma)", category: "Kokoro UK Female" },
  { id: "bf_isabella", name: "bf_isabella (UK Female - Isabella)", category: "Kokoro UK Female" },
  { id: "bf_alice", name: "bf_alice (UK Female - Alice)", category: "Kokoro UK Female" },
  { id: "bf_lily", name: "bf_lily (UK Female - Lily)", category: "Kokoro UK Female" },

  // British English (Male)
  { id: "bm_george", name: "bm_george (UK Male - George)", category: "Kokoro UK Male" },
  { id: "bm_lewis", name: "bm_lewis (UK Male - Lewis)", category: "Kokoro UK Male" },
  { id: "bm_daniel", name: "bm_daniel (UK Male - Daniel)", category: "Kokoro UK Male" },
  { id: "bm_fable", name: "bm_fable (UK Male - Fable)", category: "Kokoro UK Male" },

  // Other languages
  { id: "jf_alpha", name: "jf_alpha (Japanese Female)", category: "Kokoro Japanese" },
  { id: "jm_kumo", name: "jm_kumo (Japanese Male)", category: "Kokoro Japanese" },
  { id: "zf_xiaobei", name: "zf_xiaobei (Chinese Female)", category: "Kokoro Chinese" },
  { id: "zm_yunjian", name: "zm_yunjian (Chinese Male)", category: "Kokoro Chinese" },
  { id: "ef_dora", name: "ef_dora (Spanish Female)", category: "Kokoro Spanish" },
  { id: "em_alex", name: "em_alex (Spanish Male)", category: "Kokoro Spanish" },
  { id: "ff_siwis", name: "ff_siwis (French Female)", category: "Kokoro French" },
  { id: "hf_alpha", name: "hf_alpha (Hindi Female)", category: "Kokoro Hindi" },
  { id: "hm_omega", name: "hm_omega (Hindi Male)", category: "Kokoro Hindi" },
  { id: "if_sara", name: "if_sara (Italian Female)", category: "Kokoro Italian" },
  { id: "pf_dora", name: "pf_dora (Portuguese Female)", category: "Kokoro Portuguese" }
];

function fallbackVoices(source: TTSSource, model?: string): TTSVoicesResponse {
  if (source === "elevenlabs") {
    return responseFromVoiceOptions(source, [], false);
  }

  if (source === "pockettts") {
    const voices = [
      "alba",
      "anna",
      "azelma",
      "bill_boerst",
      "caro_davy",
      "charles",
      "cosette",
      "eponine",
      "eve",
      "fantine",
      "george",
      "jane",
      "jean",
      "javert",
      "marius",
      "mary",
      "michael",
      "paul",
      "peter_yearsley",
      "stuart_bell",
      "vera",
    ];
    return responseFromVoiceOptions(
      source,
      voices.map((voice) => ({ id: voice, name: voice, category: "PocketTTS built-in" })),
      false,
    );
  }

  if (source === "nanogpts") {
    const lowerModel = (model || "").toLowerCase();
    if (lowerModel.includes("elevenlabs") || lowerModel.includes("eleven_")) {
      return responseFromVoiceOptions(
        source,
        NANOGPT_ELEVENLABS_VOICES.map((voice) => ({ id: voice, name: voice, category: "NanoGPT ElevenLabs" })),
        false,
      );
    }
    if (lowerModel.includes("tts-1") || lowerModel.includes("gpt-4o")) {
      return responseFromVoiceOptions(
        source,
        OPENAI_FALLBACK_VOICES.map((voice) => ({ id: voice, name: voice, category: "NanoGPT OpenAI" })),
        false,
      );
    }
    // Default to Kokoro
    return responseFromVoiceOptions(
      source,
      KOKORO_VOICES,
      false,
    );
  }

  return responseFromVoiceOptions(
    source,
    OPENAI_FALLBACK_VOICES.map((voice) => ({ id: voice, name: voice })),
    false,
  );
}

function configuredBaseUrl(cfg: TTSConfig) {
  const fallbackBase = TTS_SOURCE_DEFAULTS[cfg.source].baseUrl;
  return (cfg.baseUrl || fallbackBase).replace(/\/+$/, "");
}

function allowLocalTtsUrl(cfg: TTSConfig) {
  return cfg.source === "pockettts" || isTtsLocalUrlsEnabled();
}

function elevenLabsApiRoot(baseUrl: string) {
  return baseUrl.replace(/\/v\d+$/, "");
}

function isNanoGptBaseUrl(baseUrl: string) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "nano-gpt.com" || hostname.endsWith(".nano-gpt.com");
  } catch {
    return baseUrl.toLowerCase().includes("nano-gpt.com");
  }
}

function nanoGptApiRoot(baseUrl: string) {
  return baseUrl.replace(/\/v\d+$/, "");
}

function nanoGptV1BaseUrl(baseUrl: string) {
  const root = nanoGptApiRoot(baseUrl);
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

function normalizeElevenLabsTtsModelId(model: string) {
  const trimmed = model.trim();
  return ELEVENLABS_TTS_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function normalizeNanoGptTtsModelId(model: string) {
  const trimmed = model.trim();
  return NANOGPT_TTS_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readLabels(value: unknown): Record<string, string | number | boolean | null> | null {
  const obj = asObject(value);
  if (!obj) return null;

  const labels = Object.fromEntries(
    Object.entries(obj).filter((entry): entry is [string, string | number | boolean | null] => {
      const [, labelValue] = entry;
      return (
        labelValue === null ||
        typeof labelValue === "string" ||
        typeof labelValue === "number" ||
        typeof labelValue === "boolean"
      );
    }),
  );

  return Object.keys(labels).length > 0 ? labels : null;
}

function parseVoiceOption(value: unknown): VoiceOption | null {
  if (typeof value === "string") {
    return value.trim() ? { id: value, name: value } : null;
  }

  const obj = asObject(value);
  if (!obj) return null;

  const id =
    readString(obj["voice_id"]) ?? readString(obj["voiceId"]) ?? readString(obj["id"]) ?? readString(obj["name"]);
  if (!id) return null;

  const name = readString(obj["name"]) ?? id;
  return {
    id,
    name,
    description: readString(obj["description"]) ?? null,
    previewUrl: readString(obj["preview_url"]) ?? readString(obj["previewUrl"]) ?? null,
    category: readString(obj["category"]) ?? null,
    labels: readLabels(obj["labels"]),
  };
}

function parseVoiceOptions(data: unknown): VoiceOption[] {
  const list = Array.isArray(data)
    ? data
    : (() => {
        const obj = asObject(data);
        const voices = obj?.["voices"] ?? obj?.["data"];
        return Array.isArray(voices) ? voices : [];
      })();

  return list.map(parseVoiceOption).filter((voice): voice is VoiceOption => Boolean(voice));
}

function mergeVoiceOptions(voiceOptions: VoiceOption[]): VoiceOption[] {
  const byId = new Map<string, VoiceOption>();
  for (const option of voiceOptions) {
    const existing = byId.get(option.id);
    if (!existing) {
      byId.set(option.id, option);
      continue;
    }

    byId.set(option.id, {
      ...existing,
      ...option,
      description: option.description ?? existing.description ?? null,
      previewUrl: option.previewUrl ?? existing.previewUrl ?? null,
      category: option.category ?? existing.category ?? null,
      labels: { ...(existing.labels ?? {}), ...(option.labels ?? {}) },
    });
  }
  return [...byId.values()];
}

function elevenLabsHeaders(apiKey: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["xi-api-key"] = apiKey;
  return headers;
}

function openAiHeaders(apiKey: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function nanoGptHeaders(apiKey: string) {
  const headers = openAiHeaders(apiKey);
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

function optionalBearerHeaders(apiKey: string) {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function openAiModelSupportsSpeechInstructions(model: string) {
  return /^gpt-4o/i.test(model.trim());
}

function articleForWord(value: string) {
  return /^[aeiou]/i.test(value.trim()) ? "an" : "a";
}

function readProviderErrorDetail(body: string): string {
  if (!body.trim()) return "";

  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const directDetail = readString(data.detail);
    const error = asObject(data.error);
    const detail = asObject(data.detail);
    const errorMessage = readString(error?.message) ?? readString(error?.status);
    const detailMessage = readString(detail?.message) ?? readString(detail?.status);
    return (
      readString(data.message) ??
      readString(data.error) ??
      errorMessage ??
      directDetail ??
      detailMessage ??
      body.slice(0, 500)
    );
  } catch {
    return body.slice(0, 500);
  }
}

export function isAllowedTTSAudioContentType(contentType: string | null): boolean {
  const normalized = contentType?.toLowerCase() ?? "";
  return normalized.includes("audio/") || normalized.includes("application/octet-stream");
}

function audioFormatMimeType(format: string): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

function buildSpeechInstructions(input: { speaker?: string; tone?: string; includeSpeaker?: boolean }) {
  const parts: string[] = [];
  if (input.includeSpeaker !== false && input.speaker?.trim()) {
    parts.push(`Voice the line as ${input.speaker.trim()}.`);
  }
  const tone = input.tone?.trim();
  if (tone) {
    parts.push(`Use ${articleForWord(tone)} ${tone} tone.`);
  }
  if (parts.length === 0) return undefined;
  parts.push("Do not read speaker names, brackets, markup, or stage directions aloud.");
  return parts.join(" ");
}

function toElevenLabsCueTag(value: string): string | null {
  const tag = value
    .trim()
    .replace(/^[\[\]"']+|[\]\]"']+$/g, "")
    .replace(/\s+/g, " ");
  if (!tag || /[\r\n<>]/.test(tag)) return null;

  const normalized = tag.toLowerCase();
  if (/^(main|side|extra|action|thought|whisper(?::.+)?)$/.test(normalized)) return null;

  return `[${tag}]`;
}

export function buildElevenLabsTextInput(text: string, tone?: string): string {
  const tags = (tone ?? "")
    .split(",")
    .map(toElevenLabsCueTag)
    .filter((tag): tag is string => Boolean(tag));
  if (tags.length === 0) return text;

  const prefix = tags.join(" ");
  const trimmedText = text.trimStart();
  if (trimmedText.toLowerCase().startsWith(prefix.toLowerCase())) return text;
  return `${prefix} ${text}`;
}

export function resolveTTSRequestVoice(configuredVoice: string, requestedVoice?: string | null): string {
  const trimmedRequest = requestedVoice?.trim();
  return trimmedRequest || configuredVoice;
}

async function fetchElevenLabsVoiceOptions(
  baseUrl: string,
  apiKey: string,
  query: Record<string, string> = {},
): Promise<VoiceOption[]> {
  const voiceOptions: VoiceOption[] = [];
  let nextPageToken: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${elevenLabsApiRoot(baseUrl)}/v2/voices`);
    url.searchParams.set("page_size", "100");
    url.searchParams.set("include_total_count", "false");
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    if (nextPageToken) {
      url.searchParams.set("next_page_token", nextPageToken);
    }

    const res = await safeFetch(url, {
      headers: elevenLabsHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
      policy: {
        allowLocal: isTtsLocalUrlsEnabled(),
        allowedProtocols: ["https:", "http:"],
        flagName: "TTS_LOCAL_URLS_ENABLED",
      },
      maxResponseBytes: 2 * 1024 * 1024,
    });

    if (!res.ok) throw new Error(`ElevenLabs voices request failed (${res.status})`);

    const data = await res.json();
    voiceOptions.push(...parseVoiceOptions(data));

    const obj = asObject(data);
    const hasMore = obj?.has_more === true;
    nextPageToken = readString(obj?.next_page_token) ?? null;
    if (!hasMore || !nextPageToken) break;
  }

  return voiceOptions;
}

async function fetchNanoGptAudioModels(cfg: TTSConfig): Promise<any[]> {
  if (!cfg.apiKey) return [];
  const base = configuredBaseUrl(cfg);
  const root = nanoGptApiRoot(base);
  const url = `${root}/v1/audio-models`;

  try {
    const res = await safeFetch(url, {
      headers: nanoGptHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(10_000),
      policy: {
        allowLocal: allowLocalTtsUrl(cfg),
        allowedProtocols: ["https:", "http:"],
        flagName: "TTS_LOCAL_URLS_ENABLED",
      },
      maxResponseBytes: 1 * 1024 * 1024,
    });
    if (!res.ok) return [];
    const json = await res.json() as any;
    if (json && Array.isArray(json.data)) {
      return json.data;
    }
  } catch (err) {
    // Fail silently
  }
  return [];
}

async function fetchNanoGptModels(cfg: TTSConfig): Promise<string[]> {
  const models = await fetchNanoGptAudioModels(cfg);
  return models.map((m: any) => m.id).filter(Boolean);
}

async function fetchProviderVoices(cfg: TTSConfig): Promise<TTSVoicesResponse> {
  if (!cfg.enabled) return fallbackVoices(cfg.source, cfg.model);

  const base = configuredBaseUrl(cfg);

  if (cfg.source === "pockettts") {
    return fallbackVoices(cfg.source, cfg.model);
  }

  if (cfg.source === "nanogpts") {
    const allModels = await fetchNanoGptAudioModels(cfg);
    const models = allModels.map((m: any) => m.id).filter(Boolean);

    // Find the currently selected model's details
    const selectedModel = (cfg.model || "Kokoro-82m").trim();
    const resolvedModel = normalizeNanoGptTtsModelId(selectedModel);
    const modelEntry = allModels.find(
      (m: any) => m.id && m.id.toLowerCase() === resolvedModel.toLowerCase(),
    );

    let voiceOptions: VoiceOption[] = [];
    let fromProvider = false;

    if (modelEntry && modelEntry.supported_parameters && Array.isArray(modelEntry.supported_parameters.voices)) {
      const voicesList = modelEntry.supported_parameters.voices as string[];
      voiceOptions = voicesList.map((v) => ({
        id: v,
        name: v,
        category: `NanoGPT ${modelEntry.name || modelEntry.id}`,
      }));
      fromProvider = true;
    }

    // Fallback if no voices could be loaded from API
    if (voiceOptions.length === 0) {
      const fallbackRes = fallbackVoices(cfg.source, cfg.model);
      voiceOptions = fallbackRes.voiceOptions || [];
      fromProvider = fallbackRes.fromProvider;
    }

    return {
      voices: voiceOptions.map((v) => v.id),
      voiceOptions,
      fromProvider,
      source: cfg.source,
      models: models.length > 0 ? models : undefined,
    };
  }

  if (cfg.source === "elevenlabs") {
    if (!cfg.apiKey) return fallbackVoices(cfg.source);

    if (isNanoGptBaseUrl(base)) {
      return responseFromVoiceOptions(
        cfg.source,
        NANOGPT_ELEVENLABS_VOICES.map((voice) => ({ id: voice, name: voice, category: "NanoGPT ElevenLabs" })),
        true,
      );
    }

    const [defaultVoices, accountVoices] = await Promise.all([
      fetchElevenLabsVoiceOptions(base, cfg.apiKey, { voice_type: "default" }).catch(() => []),
      fetchElevenLabsVoiceOptions(base, cfg.apiKey).catch(() => []),
    ]);
    const voices = mergeVoiceOptions([...defaultVoices, ...accountVoices]);
    return voices.length > 0 ? responseFromVoiceOptions(cfg.source, voices, true) : fallbackVoices(cfg.source);
  }

  const res = await safeFetch(`${base}/audio/voices`, {
    headers: openAiHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(10_000),
    policy: {
      allowLocal: allowLocalTtsUrl(cfg),
      allowedProtocols: ["https:", "http:"],
      flagName: "TTS_LOCAL_URLS_ENABLED",
    },
    maxResponseBytes: 2 * 1024 * 1024,
  });

  if (!res.ok) return fallbackVoices(cfg.source);

  const voices = parseVoiceOptions(await res.json());
  return voices.length > 0 ? responseFromVoiceOptions(cfg.source, voices, true) : fallbackVoices(cfg.source);
}

// ── Routes ──────────────────────────────────────

export async function ttsRoutes(app: FastifyInstance) {
  const storage = createAppSettingsStorage(app.db);

  /**
   * GET /api/tts/config
   * Returns TTS config with the API key masked.
   */
  app.get("/config", async () => {
    const raw = await storage.get(TTS_SETTINGS_KEY);
    const cfg = parseStoredConfig(raw);
    // Mask the stored (encrypted) key — just tell client whether one is saved
    const hasKey = Boolean(cfg.apiKey);
    return { ...cfg, apiKey: hasKey ? TTS_API_KEY_MASK : "" };
  });

  /**
   * PUT /api/tts/config
   * Saves TTS config. Encrypts the API key before storage.
   * If apiKey equals the mask, the existing key is kept unchanged.
   */
  app.put("/config", async (req, reply) => {
    const input = ttsConfigSchema.parse(req.body);

    if (input.apiKey === TTS_API_KEY_MASK) {
      // Client sent the mask back — preserve the existing encrypted key
      const existing = parseStoredConfig(await storage.get(TTS_SETTINGS_KEY));
      input.apiKey = existing.apiKey; // already encrypted blob
    } else {
      input.apiKey = encryptApiKey(input.apiKey);
    }

    await storage.set(TTS_SETTINGS_KEY, JSON.stringify(input));
    return reply.status(204).send();
  });

  /**
   * GET /api/tts/voices
   * Fetches available voices from the configured provider.
   */
  app.get("/voices", async (req) => {
    const query = req.query as Record<string, string>;
    const cfg = await loadConfig(storage);

    if (query.source) cfg.source = query.source as TTSSource;
    if (query.baseUrl) cfg.baseUrl = query.baseUrl;
    if (query.model) cfg.model = query.model;

    // Force enabled to true so that fetchProviderVoices attempts to contact the provider
    // for this request, regardless of whether TTS is globally enabled in the database.
    cfg.enabled = true;

    try {
      return await fetchProviderVoices(cfg);
    } catch {
      return fallbackVoices(cfg.source, cfg.model);
    }
  });

  /**
   * POST /api/tts/speak
   * Proxies a TTS request to the configured provider and streams the audio back.
   */
  app.post("/speak", async (req, reply) => {
    const { text, speaker, tone, voice } = speakSchema.parse(req.body);

    const cfg = await loadConfig(storage);

    if (!cfg.enabled) {
      return reply.status(400).send({ error: "TTS is not enabled" });
    }

    if (cfg.source === "elevenlabs" && !cfg.apiKey) {
      return reply.status(400).send({ error: "ElevenLabs API key is not configured" });
    }

    const requestVoice = resolveTTSRequestVoice(cfg.voice, voice);

    if (cfg.source === "elevenlabs" && !requestVoice) {
      return reply.status(400).send({ error: "ElevenLabs voice is not selected" });
    }

    const base = configuredBaseUrl(cfg);
    const useNanoGptSpeech = cfg.source === "nanogpts" || isNanoGptBaseUrl(base);
    const usePocketTtsSpeech = cfg.source === "pockettts";
    const configuredModel = (cfg.model || TTS_SOURCE_DEFAULTS[cfg.source].model).trim();
    const model = useNanoGptSpeech
      ? normalizeNanoGptTtsModelId(configuredModel)
      : cfg.source === "elevenlabs"
        ? normalizeElevenLabsTtsModelId(configuredModel)
        : configuredModel;
    const normalizedModel = model.toLowerCase();
    if (cfg.source === "elevenlabs" && !useNanoGptSpeech && ELEVENLABS_NON_TTS_MODELS.has(normalizedModel)) {
      return reply.status(400).send({
        error: `ElevenLabs model "${model}" cannot generate text-to-speech`,
        detail: `That model is for Text to Voice / voice design. Use "eleven_v3" for Eleven v3 speech, or "eleven_multilingual_v2", "eleven_flash_v2_5", or "eleven_turbo_v2_5" for regular TTS.`,
      });
    }

    const audioFormat = cfg.audioFormat ?? "mp3";
    const url = useNanoGptSpeech
      ? `${nanoGptV1BaseUrl(base)}/audio/speech`
      : usePocketTtsSpeech
        ? `${base}/tts`
        : cfg.source === "elevenlabs"
          ? `${elevenLabsApiRoot(base)}/v1/text-to-speech/${encodeURIComponent(requestVoice)}?output_format=mp3_44100_128`
          : `${base}/audio/speech`;
    const providerText = cfg.source === "elevenlabs" ? buildElevenLabsTextInput(text, tone) : text;
    const elevenLabsLanguageCode = cfg.elevenLabsLanguageCode?.trim();
    const includeSpeakerInstructions = cfg.source !== "elevenlabs";
    const speechInstructions = useNanoGptSpeech
      ? buildSpeechInstructions({ speaker, tone, includeSpeaker: includeSpeakerInstructions })
      : cfg.source === "openai" && openAiModelSupportsSpeechInstructions(cfg.model)
        ? buildSpeechInstructions({ speaker, tone })
        : undefined;

    let providerRes: Response;
    try {
      const pocketTtsForm = usePocketTtsSpeech ? new FormData() : null;
      if (pocketTtsForm) {
        pocketTtsForm.set("text", providerText);
        if (requestVoice.trim()) pocketTtsForm.set("voice_url", requestVoice.trim());
        if (audioFormat !== "mp3") pocketTtsForm.set("output_format", audioFormat);
      }

      providerRes = await safeFetch(url, {
        method: "POST",
        headers: useNanoGptSpeech
          ? nanoGptHeaders(cfg.apiKey)
          : usePocketTtsSpeech
            ? optionalBearerHeaders(cfg.apiKey)
            : cfg.source === "elevenlabs"
              ? elevenLabsHeaders(cfg.apiKey)
              : openAiHeaders(cfg.apiKey),
        body: pocketTtsForm
          ? pocketTtsForm
          : useNanoGptSpeech
            ? JSON.stringify({
                model,
                input: providerText,
                voice: requestVoice || "alloy",
                speed: cfg.speed,
                response_format: audioFormat,
                ...(speechInstructions ? { instructions: speechInstructions } : {}),
              })
            : cfg.source === "elevenlabs"
              ? JSON.stringify({
                  text: providerText,
                  model_id: model,
                  ...(elevenLabsLanguageCode ? { language_code: elevenLabsLanguageCode } : {}),
                  voice_settings: {
                    stability: cfg.elevenLabsStability,
                    speed: cfg.speed,
                  },
                })
              : JSON.stringify({
                  model,
                  input: providerText,
                  voice: requestVoice,
                  speed: cfg.speed,
                  response_format: audioFormat,
                  ...(speechInstructions ? { instructions: speechInstructions } : {}),
                }),
        signal: AbortSignal.timeout(60_000),
        policy: {
          allowLocal: allowLocalTtsUrl(cfg),
          allowedProtocols: ["https:", "http:"],
          flagName: "TTS_LOCAL_URLS_ENABLED",
        },
        maxResponseBytes: MAX_TTS_AUDIO_BYTES,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.name === "TimeoutError" ? "TTS request timed out" : "TTS provider unreachable";
      req.log.error(err, "TTS provider request failed");
      return reply.status(502).send({ error: msg });
    }

    if (!providerRes.ok) {
      const body = await providerRes.text().catch(() => "");
      return reply
        .status(502)
        .send({ error: `TTS provider returned ${providerRes.status}`, detail: readProviderErrorDetail(body) });
    }

    const contentType = providerRes.headers.get("content-type");
    if (!isAllowedTTSAudioContentType(contentType)) {
      const body = await providerRes.text().catch(() => "");
      return reply.status(502).send({
        error: "TTS provider returned a non-audio response",
        detail: readProviderErrorDetail(body) || `Content-Type: ${contentType || "missing"}`,
      });
    }

    const audioBuffer = await providerRes.arrayBuffer();
    reply.header("Content-Type", contentType?.startsWith("audio/") ? contentType : audioFormatMimeType(audioFormat));
    reply.header("Content-Length", String(audioBuffer.byteLength));
    return reply.send(Buffer.from(audioBuffer));
  });
}
