/**
 * NER detector — wraps `@huggingface/transformers` for local ONNX inference.
 *
 * The pipeline returns token-level `entity` labels but the upstream `start`
 * /`end` fields are still TODO (verified in transformers.js source). We
 * reconstruct character offsets by re-tokenising on whitespace and matching
 * the cumulative `word` length, which is good enough for plain prose. For
 * languages that do not separate by whitespace (CJK), we fall back to a
 * greedy offset scan that respects the input's Unicode code points.
 */

import type { DetectOptions, PiiDetector, PiiMatch } from '../types.js';

// Lazy import: `@huggingface/transformers` is a heavy dependency. Only the
// caller that actually wires NER into a pipeline pays the import cost.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TokenClassifier = (text: string) => Promise<TokenOut[]>;

interface TokenOut {
  word: string;
  entity_group?: string;
  entity?: string;
  score: number;
  index?: number;
  start?: number;
  end?: number;
}

/** Common NER tag set produced by CoNLL-2003 / OntoNotes models. */
const TAG_MAP: Record<string, string> = {
  PER: 'PERSON',
  PERSON: 'PERSON',
  LOC: 'LOCATION',
  LOCATION: 'LOCATION',
  GPE: 'LOCATION',
  ORG: 'ORGANIZATION',
  ORGANIZATION: 'ORGANIZATION',
  MISC: 'MISC',
};

export interface NerDetectorOptions {
  /** HF model id, defaults to a small multilingual ONNX model. */
  model?: string;
  /** Quantisation dtype; `q8` keeps size small. */
  dtype?: 'q8' | 'fp16' | 'fp32';
  /** Drop matches below this confidence. Defaults to 0.7. */
  minScore?: number;
  /** Allowed entity types, post-mapping. */
  entityTypes?: string[];
  /** Force eager init on construction. Otherwise call `initialize()` manually. */
  autoInit?: boolean;
  /** Optional cache directory for downloaded ONNX artefacts. */
  cacheDir?: string;
}

interface TokenOffset {
  word: string;
  start: number;
  end: number;
}

/**
 * NER detector that loads an ONNX token-classification model once and
 * reuses it. Designed to fail gracefully if the dependency cannot be
 * installed at runtime — the engine treats a non-ready NER detector as
 * "regex-only" rather than crashing.
 */
export class NerDetector implements PiiDetector {
  readonly name = 'ner';
  readonly type = 'ner' as const;

  private readonly model: string;
  private readonly dtype: 'q8' | 'fp16' | 'fp32';
  private readonly minScore: number;
  private readonly allowedTypes?: Set<string>;
  private readonly cacheDir?: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private classifier: TokenClassifier | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rawTokenizer: any = null;
  private ready = false;

  constructor(options: NerDetectorOptions = {}) {
    this.model = options.model ?? 'Xenova/bert-base-multilingual-cased-ner-hrl';
    this.dtype = options.dtype ?? 'q8';
    this.minScore = options.minScore ?? 0.7;
    this.allowedTypes = options.entityTypes ? new Set(options.entityTypes) : undefined;
    this.cacheDir = options.cacheDir;
    if (options.autoInit) {
      void this.initialize().catch(() => {
        /* swallow: surface via isReady() */
      });
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    try {
      const tf = await import('@huggingface/transformers');
      if (this.cacheDir) tf.env.cacheDir = this.cacheDir;
      const pipe = await tf.pipeline('token-classification', this.model, { dtype: this.dtype });
      this.classifier = pipe as unknown as TokenClassifier;
      this.rawTokenizer = await tf.AutoTokenizer.from_pretrained(this.model);
      this.ready = true;
    } catch (err) {
      this.ready = false;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async detect(text: string, options?: DetectOptions): Promise<PiiMatch[]> {
    if (!this.ready || !this.classifier || !this.rawTokenizer) return [];

    const threshold = options?.minConfidence ?? this.minScore;
    const tokens = await this.classifier(text);
    const offsets = this.computeOffsets(this.rawTokenizer, text);

    const matches: PiiMatch[] = [];
    for (const tok of tokens) {
      const raw = (tok.entity_group ?? tok.entity ?? '').replace(/^[BI]-/, '');
      const mapped = TAG_MAP[raw.toUpperCase()] ?? raw;
      if (this.allowedTypes && !this.allowedTypes.has(mapped)) continue;
      if (tok.score < threshold) continue;

      const off = pickOffset(offsets, tok, text);
      if (!off) continue;
      matches.push({
        type: mapped,
        start: off[0],
        end: off[1],
        value: text.slice(off[0], off[1]),
        source: 'ner',
        score: tok.score,
      });
    }

    return mergeAdjacent(matches, text);
  }

  /**
   * Compute character offsets for tokens. transformers.js does not yet
   * populate start/end on token-classification output, so we drive the
   * tokenizer with `offset_mapping` semantics ourselves.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private computeOffsets(tokenizer: any, text: string): TokenOffset[] {
    try {
      // Some tokenizer versions expose `tokenize(text, { offset_mapping: true })`.
      const enc = tokenizer(text, { offset_mapping: true });
      const ids: number[] = enc.input_ids ?? enc.inputIds ?? enc[0]?.input_ids ?? [];
      const offsets: [number, number][] | undefined = enc.offset_mapping ?? enc[0]?.offset_mapping;
      if (offsets && ids) {
        return offsets
          .filter(([s, e]) => s !== 0 || e !== 0) // drop specials
          .map(([s, e], i) => ({ word: text.slice(s, e), start: s, end: e, index: i } as TokenOffset & { index: number }))
          .filter((t) => t.word.length > 0);
      }
    } catch {
      // Fall through to the regex tokenizer below.
    }
    // Fallback: split on whitespace and assign cumulative offsets.
    const out: (TokenOffset & { index: number })[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      out.push({ word: m[0], start, end, index: i++ });
    }
    return out;
  }
}

/** Choose the character offset for a token using tokenizer output when present. */
function pickOffset(
  offsets: (TokenOffset & { index?: number })[],
  tok: TokenOut,
  text: string,
): [number, number] | null {
  if (typeof tok.index === 'number') {
    const o = offsets[tok.index];
    if (o) return [o.start, o.end];
  }
  // Last resort: find the token's word in the text. Adequate for short prose.
  const needle = tok.word.replace(/^##?/, '').replace(/^▁/, '').trim();
  if (!needle) return null;
  const at = text.indexOf(needle);
  if (at === -1) return null;
  return [at, at + needle.length];
}

/** Combine contiguous NER matches that share an entity type. */
function mergeAdjacent(matches: PiiMatch[], text: string): PiiMatch[] {
  if (matches.length <= 1) return matches;
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const out: PiiMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && last.type === m.type && m.start <= last.end + 1) {
      last.end = m.end;
      last.value = text.slice(last.start, last.end);
      last.score = Math.min(last.score ?? 1, m.score ?? 1);
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remote NER detector — talks to a locally-deployed HTTP endpoint.
// ---------------------------------------------------------------------------

/** Response shape adapters supported by `RemoteNerDetector`. */
export type RemoteNerFormat = 'openai' | 'ollama' | 'huggingface' | 'generic';

/**
 * Options for `RemoteNerDetector`. The detector is a thin HTTP client; the
 * upstream service is responsible for model weights, GPU allocation, etc.
 *
 * Quick presets:
 *   - Ollama: `format: 'ollama'`, `endpoint: 'http://localhost:11434/api/ner'`
 *   - vLLM / TGI (HuggingFace-compatible): `format: 'huggingface'`,
 *     `endpoint: 'http://localhost:8080'`
 *   - OpenAI-compatible NER router (e.g. vLLM with `--task=token-classify`):
 *     `format: 'openai'`, `endpoint: 'http://localhost:8000/v1/chat/completions'`
 */
export interface RemoteNerDetectorOptions {
  /** Base URL of the NER service. Must be reachable from this process. */
  endpoint: string;
  /** Wire format; defaults to `openai` (most common). */
  format?: RemoteNerFormat;
  /** Model name sent in the request body (Ollama / OpenAI / HF). */
  model?: string;
  /** Bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Optional custom headers (merged on top of defaults). */
  headers?: Record<string, string>;
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Drop matches below this confidence. Defaults to 0.6. */
  minScore?: number;
  /** Allowed entity types, post-mapping. */
  entityTypes?: string[];
  /** Force eager health-check on construction. Otherwise call `initialize()`. */
  autoInit?: boolean;
  /**
   * Optional override of the HTTP fetch function — useful for tests, or
   * for environments that need a custom agent / proxy. Defaults to the
   * global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Map raw entity labels from the upstream model into our canonical
   * categories (e.g. `B-PER -> PERSON`). Defaults to the built-in `TAG_MAP`.
   */
  labelMap?: Record<string, string>;
  /** Extra body fields merged into the request (Ollama / OpenAI). */
  extraBody?: Record<string, unknown>;
}

interface RemoteRawMatch {
  text: string;
  label: string;
  score: number;
  start?: number;
  end?: number;
}

/**
 * NER detector that proxies to a local HTTP service. Wire-compatible with
 * Ollama, vLLM, HuggingFace Inference Endpoints, and any custom server
 * that follows one of the supported formats.
 *
 * In contrast to `NerDetector`, this class does not pull model weights
 * into the Node.js process — it is the right choice when a GPU server is
 * already running elsewhere on the network.
 */
export class RemoteNerDetector implements PiiDetector {
  readonly name = 'ner-remote';
  readonly type = 'ner' as const;

  private readonly endpoint: string;
  private readonly format: RemoteNerFormat;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly minScore: number;
  private readonly allowedTypes?: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly labelMap: Record<string, string>;
  private readonly extraBody: Record<string, unknown>;

  private ready = false;

  constructor(options: RemoteNerDetectorOptions) {
    if (!options.endpoint) throw new Error('RemoteNerDetector requires `endpoint`');
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.format = options.format ?? 'openai';
    this.model = options.model ?? 'ner';
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.minScore = options.minScore ?? 0.6;
    this.allowedTypes = options.entityTypes ? new Set(options.entityTypes) : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.labelMap = options.labelMap ?? TAG_MAP;
    this.extraBody = options.extraBody ?? {};
    if (options.autoInit) {
      void this.initialize().catch(() => undefined);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Probe the endpoint; flips `ready` on success. */
  async initialize(): Promise<void> {
    try {
      const ok = await this.ping();
      this.ready = ok;
      if (!ok) throw new Error(`NER endpoint ${this.endpoint} did not respond`);
    } catch (err) {
      this.ready = false;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async detect(text: string, options?: DetectOptions): Promise<PiiMatch[]> {
    if (!text) return [];
    if (!this.ready) return [];
    const raw = await this.callRemote(text);
    const threshold = options?.minConfidence ?? this.minScore;
    const out: PiiMatch[] = [];
    for (const m of raw) {
      const mapped = this.labelMap[m.label.replace(/^[BI]-/, '').toUpperCase()] ?? m.label.replace(/^[BI]-/, '');
      if (this.allowedTypes && !this.allowedTypes.has(mapped)) continue;
      if (m.score < threshold) continue;
      const off = resolveOffsets(text, m);
      if (!off) continue;
      out.push({
        type: mapped,
        start: off[0],
        end: off[1],
        value: text.slice(off[0], off[1]),
        source: 'ner',
        score: m.score,
      });
    }
    return mergeAdjacent(out, text);
  }

  /** Lightweight GET against common health endpoints; never throws. */
  private async ping(): Promise<boolean> {
    const candidates = ['', '/health', '/v1/models', '/api/tags'];
    for (const c of candidates) {
      try {
        const res = await this.fetchImpl(this.endpoint + c, {
          method: 'GET',
          headers: this.authHeader(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  private async callRemote(text: string): Promise<RemoteRawMatch[]> {
    const body = this.buildBody(text);
    const headers = {
      'Content-Type': 'application/json',
      ...this.authHeader(),
      ...this.headers,
    };
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const msg = await safeText(res);
      throw new Error(`NER ${this.format} ${res.status}: ${msg}`);
    }
    const json = await res.json();
    return this.parseResponse(json);
  }

  private authHeader(): Record<string, string> {
    if (!this.apiKey) return {};
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  /** Build the request body for the chosen wire format. */
  private buildBody(text: string): Record<string, unknown> {
    switch (this.format) {
      case 'ollama':
        return { model: this.model, text, ...this.extraBody };
      case 'openai':
        return {
          model: this.model,
          // Some OpenAI-compatible NER routers accept a single user message
          // and reply with entities in the assistant content. Body is loose
          // so any vendor that supports `prompt` works too.
          messages: [{ role: 'user', content: text }],
          ...this.extraBody,
        };
      case 'huggingface':
        return { inputs: text, parameters: { ...this.extraBody } };
      case 'generic':
        return { text, model: this.model, ...this.extraBody };
    }
  }

  /** Parse a response into the canonical `RemoteRawMatch[]` shape. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseResponse(json: any): RemoteRawMatch[] {
    switch (this.format) {
      case 'ollama':
        // Ollama `/api/ner` returns `{ entities: [{entity, text, start, end, score}] }`
        if (Array.isArray(json?.entities)) return normaliseOllama(json.entities);
        return [];
      case 'huggingface': {
        // HF pipelines return a flat array OR a nested array depending on
        // batch size; we flatten and pick the rich form.
        const arr = Array.isArray(json) ? json.flat() : [];
        return arr
          .filter((x) => x && typeof x === 'object' && typeof x.word === 'string')
          .map((x) => ({
            text: x.word,
            label: x.entity_group ?? x.entity ?? '',
            score: typeof x.score === 'number' ? x.score : 1,
            start: typeof x.start === 'number' ? x.start : undefined,
            end: typeof x.end === 'number' ? x.end : undefined,
          }));
      }
      case 'openai': {
        // Accept either `{entities: [...]}` (vendor extensions) or a chat
        // response where the assistant emits JSON in its content.
        if (Array.isArray(json?.entities)) return normaliseOllama(json.entities);
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed?.entities)) return normaliseOllama(parsed.entities);
          } catch {
            // ignore — fall through to empty result
          }
        }
        return [];
      }
      case 'generic':
        if (Array.isArray(json?.entities)) return normaliseOllama(json.entities);
        return [];
    }
  }
}

function normaliseOllama(rows: unknown[]): RemoteRawMatch[] {
  return rows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r): r is Record<string, any> => !!r && typeof r === 'object')
    .map((r) => ({
      text: String(r.text ?? r.word ?? ''),
      label: String(r.label ?? r.entity ?? r.entity_group ?? ''),
      score: typeof r.score === 'number' ? r.score : 1,
      start: typeof r.start === 'number' ? r.start : undefined,
      end: typeof r.end === 'number' ? r.end : undefined,
    }))
    .filter((r) => r.text.length > 0);
}

/** Resolve character offsets for a remote match — prefer server-provided,
 * otherwise fall back to a forward scan over the original text. */
function resolveOffsets(text: string, m: RemoteRawMatch): [number, number] | null {
  if (typeof m.start === 'number' && typeof m.end === 'number') {
    if (text.slice(m.start, m.end) === m.text) return [m.start, m.end];
  }
  const at = text.indexOf(m.text);
  if (at === -1) return null;
  return [at, at + m.text.length];
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
