/**
 * Regex detector — wraps `pii-vault`'s `RegexRecognizer` and ships with a
 * curated set of patterns covering emails, SSNs, credit cards (Luhn-validated),
 * IPv4, phone numbers, API keys, IBANs and common Chinese PII.
 *
 * Callers can extend detection with `customPatterns` without touching the
 * recognizer directly. The detector is synchronous internally but exposes an
 * async signature to match the `PiiDetector` contract used everywhere else.
 *
 * Note on flag handling: `pii-vault` always compiles with the `g` flag itself,
 * so we pass regex sources without flags. Validators (`luhn`, `cn_id_checksum`,
 * `iban`, `uk_driving_licence`) are passed by name; arbitrary user validators
 * are invoked post-`analyze` in this wrapper.
 */

import type { CustomPattern, DetectOptions, PiiDetector, PiiMatch } from '../types.js';
import {
  Analyzer,
  EntityType,
  RecognizerResult,
  RegexRecognizer,
} from 'pii-vault';

/** Builtin validator names that pii-vault understands. */
type BuiltinValidator = 'luhn' | 'cn_id_checksum' | 'uk_driving_licence';

/**
 * CustomPattern extended with an optional `builtin` validator hint so
 * callers can opt into pii-vault's built-in checkers without writing
 * `validate: (v) => cnIdCheck(v)` themselves.
 */
type DefaultPattern = CustomPattern & { builtin?: BuiltinValidator };

/** Default patterns. Built-in so consumers do not have to re-invent them. */
const DEFAULT_PATTERNS: DefaultPattern[] = [
  { name: 'email', type: 'EMAIL', regex: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, score: 1 },
  {
    name: 'us_ssn',
    type: 'SSN',
    // 3-2-4 with dashes/spaces; reject obvious zeros.
    regex: /\b(?!000|666|9\d\d)\d{3}[-\s](?!00)\d{2}[-\s](?!0000)\d{4}\b/,
    score: 0.95,
  },
  {
    name: 'credit_card',
    type: 'CREDIT_CARD',
    // 13-19 digits with optional spaces/dashes; Luhn validated natively.
    regex: /\b(?:\d[ -]?){12,18}\d\b/,
    score: 0.9,
    builtin: 'luhn',
  },
  {
    name: 'ipv4',
    type: 'IP_ADDRESS',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/,
    score: 0.85,
  },
  {
    name: 'phone_cn',
    type: 'PHONE',
    // Chinese mobile: 1[3-9]xxxxxxxxx.
    regex: /\b1[3-9]\d{9}\b/,
    score: 0.85,
  },
  {
    name: 'id_card_cn',
    type: 'CN_ID_CARD',
    // 18 digits, last may be X. Validated by pii-vault's `cn_id_checksum`.
    regex: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
    score: 0.9,
    builtin: 'cn_id_checksum',
  },
  {
    name: 'iban',
    type: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/,
    score: 0.85,
  },
  {
    name: 'uk_dl',
    type: 'UK_DRIVING_LICENCE',
    regex: /\b(?:[A-Z]{2}\d{6}[A-Z]{2}|[A-Z]\d{7}[A-Z])\b/,
    score: 0.7,
    builtin: 'uk_driving_licence',
  },
  {
    name: 'openai_api_key',
    type: 'API_KEY',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    score: 0.9,
  },
  {
    name: 'anthropic_api_key',
    type: 'API_KEY',
    regex: /\bsk-ant-(?:api\d-)?[A-Za-z0-9_-]{20,}\b/,
    score: 0.9,
  },
  {
    name: 'github_token',
    type: 'API_KEY',
    regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    score: 0.9,
  },
  {
    name: 'aws_access_key',
    type: 'API_KEY',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    score: 0.9,
  },
];

export interface RegexDetectorOptions {
  /** Patterns to add on top of the defaults. */
  customPatterns?: CustomPattern[];
  /** Replace defaults entirely instead of extending. */
  replaceDefaults?: boolean;
  /** Minimum score threshold (defaults to 0.5). */
  minScore?: number;
  /** Languages hint, forwarded but currently advisory. */
  language?: string;
}

/** Recognizer instance plus optional user-supplied post-match validator. */
interface ExtendedRecognizer {
  // pii-vault's RegexRecognizer type is structural — we treat it opaquely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognizer: any;
  /** Custom (non-builtin) validator invoked after `analyze` returns. */
  customValidator?: (value: string) => boolean;
}

/**
 * RegexDetector exposes `pii-vault`'s regex layer through our detector
 * contract, plus a built-in catalogue of patterns and a hook for custom
 * post-match validators.
 */
export class RegexDetector implements PiiDetector {
  readonly name = 'regex';
  readonly type = 'regex' as const;

  private readonly analyzer: Analyzer;
  private readonly extended: ExtendedRecognizer[];
  private readonly minScore: number;

  constructor(options: RegexDetectorOptions = {}) {
    const raw: DefaultPattern[] = options.replaceDefaults
      ? ((options.customPatterns ?? []) as DefaultPattern[])
      : [...DEFAULT_PATTERNS, ...((options.customPatterns ?? []) as DefaultPattern[])];

    this.extended = raw.map((p) => ({
      recognizer: buildRecognizer(p),
      customValidator: p.validate,
    }));

    // pii-vault's Analyzer resolves overlaps deterministically across all
    // registered recognizers; we just post-filter with custom validators
    // and convert to our own shape.
    this.analyzer = new Analyzer(this.extended.map((e) => e.recognizer));
    this.minScore = options.minScore ?? 0.5;
  }

  isReady(): boolean {
    return true;
  }

  async detect(text: string, options?: DetectOptions): Promise<PiiMatch[]> {
    const requested = options?.entityTypes?.map((t) => new EntityType(t));
    const threshold = options?.minConfidence ?? this.minScore;
    const result = this.analyzer.analyze(text, requested, threshold);

    const matches: PiiMatch[] = [];
    for (const r of result.entities) {
      const match = this.toMatch(text, r);
      if (match) matches.push(match);
    }
    return matches;
  }

  private toMatch(text: string, r: RecognizerResult): PiiMatch | null {
    const type = r.entityType.toString();
    const value = text.slice(r.start, r.end);
    const validator = this.extended.find((e) => e.recognizer.name === r.recognizerName)?.customValidator;
    if (validator && !validator(value)) return null;
    return {
      type,
      start: r.start,
      end: r.end,
      value,
      source: 'regex',
      score: r.score,
    };
  }
}

/**
 * Compile a `CustomPattern` and hand it to `pii-vault` via JSON.
 * Flags are stripped because pii-vault always compiles with `g`.
 */
function buildRecognizer(p: DefaultPattern): InstanceType<typeof RegexRecognizer> {
  const source = typeof p.regex === 'string' ? stripFlags(p.regex) : p.regex.source;
  const def: Record<string, unknown> = {
    name: p.name,
    entity_type: p.type,
    version: '1.0',
    patterns: [{ name: p.name, regex: source, score: p.score ?? 1 }],
  };
  // Map well-known custom validators to pii-vault's string identifiers so
  // they run inside the recognizer itself (no round-trip overhead).
  if (p.builtin === 'luhn') def['validators'] = ['luhn'];
  else if (p.builtin === 'cn_id_checksum') def['validators'] = ['cn_id_checksum'];
  else if (p.builtin === 'uk_driving_licence') def['validators'] = ['uk_driving_licence'];
  return RegexRecognizer.fromJson(JSON.stringify(def));
}

/** Strip trailing `/flags` from a regex literal string. */
function stripFlags(source: string): string {
  if (!source.startsWith('/')) return source;
  const lastSlash = source.lastIndexOf('/');
  if (lastSlash <= 0) return source;
  return source.slice(1, lastSlash);
}
