import { describe, expect, it } from 'vitest';
import { RemoteNerDetector } from '../src/detectors/ner-detector.js';
import type { PiiMatch } from '../src/types.js';

interface MockResponse {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: () => Promise<any>;
  text: () => Promise<string>;
}

function mockFetch(responder: (url: string, init?: RequestInit) => MockResponse | Promise<MockResponse>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const r = await responder(u, init);
    return r as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('RemoteNerDetector', () => {
  it('calls the OpenAI-compatible endpoint and maps labels', async () => {
    const det = new RemoteNerDetector({
      endpoint: 'http://localhost:9999/ner',
      format: 'openai',
      model: 'pii-ner',
      apiKey: 'sk-test',
      autoInit: false,
      minScore: 0.5,
      fetchImpl: mockFetch(async (url, init) => {
        if (init?.method === 'GET') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        expect(init?.body).toBeDefined();
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe('pii-ner');
        expect(body.messages[0].content).toContain('Alice');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            entities: [
              { text: 'Alice', label: 'B-PER', score: 0.97, start: 0, end: 5 },
              { text: 'Acme Corp', label: 'B-ORG', score: 0.88, start: 18, end: 27 },
            ],
          }),
          text: async () => '',
        };
      }),
    });
    await det.initialize();
    const matches: PiiMatch[] = await det.detect('Alice works at Acme Corp in Berlin.');
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ type: 'PERSON', value: 'Alice', source: 'ner', score: 0.97 });
    expect(matches[1]).toMatchObject({ type: 'ORGANIZATION', value: 'Acme Corp', source: 'ner', score: 0.88 });
  });

  it('parses the Ollama `/api/ner` shape', async () => {
    const det = new RemoteNerDetector({
      endpoint: 'http://localhost:11434/api/ner',
      format: 'ollama',
      model: 'llama3-ner',
      autoInit: false,
      fetchImpl: mockFetch(async (url, init) => {
        if (init?.method === 'GET') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        expect(url).toContain('/api/ner');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            entities: [{ entity: 'PER', text: 'Bob', score: 0.92, start: 0, end: 3 }],
          }),
          text: async () => '',
        };
      }),
    });
    await det.initialize();
    const matches = await det.detect('Bob met Alice.');
    expect(matches[0]?.type).toBe('PERSON');
    expect(matches[0]?.value).toBe('Bob');
  });

  it('parses the HuggingFace pipeline shape with offset_mapping', async () => {
    const det = new RemoteNerDetector({
      endpoint: 'http://localhost:8080/',
      format: 'huggingface',
      autoInit: false,
      fetchImpl: mockFetch(async (_url, init) => {
        if (init?.method === 'GET') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        return {
          ok: true,
          status: 200,
          json: async () => [
            { entity_group: 'PER', word: 'Carol', score: 0.91, start: 4, end: 9 },
            { entity_group: 'LOC', word: 'Paris', score: 0.85, start: 14, end: 19 },
          ],
          text: async () => '',
        };
      }),
    });
    await det.initialize();
    const matches = await det.detect('met Carol in Paris today');
    expect(matches.find((m) => m.type === 'PERSON')?.value).toBe('Carol');
    expect(matches.find((m) => m.type === 'LOCATION')?.value).toBe('Paris');
  });

  it('falls back to text.indexOf when offsets are missing', async () => {
    const det = new RemoteNerDetector({
      endpoint: 'http://localhost:9999/ner',
      format: 'generic',
      autoInit: false,
      fetchImpl: mockFetch(async (_url, init) => {
        if (init?.method === 'GET') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        return {
          ok: true,
          status: 200,
          json: async () => ({ entities: [{ text: 'Dave', label: 'PER', score: 0.8 }] }),
          text: async () => '',
        };
      }),
    });
    await det.initialize();
    const matches = await det.detect('say hi to Dave tomorrow');
    expect(matches[0]).toMatchObject({ type: 'PERSON', value: 'Dave', start: 10, end: 14 });
  });

  it('filters by minScore and entityTypes', async () => {
    const det = new RemoteNerDetector({
      endpoint: 'http://localhost:9999/ner',
      format: 'openai',
      entityTypes: ['PERSON'],
      minScore: 0.95,
      autoInit: false,
      fetchImpl: mockFetch(async (_url, init) => {
        if (init?.method === 'GET') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            entities: [
              { text: 'Eve', label: 'PER', score: 0.7, start: 0, end: 3 },
              { text: 'Frank', label: 'PER', score: 0.99, start: 8, end: 13 },
              { text: 'Acme', label: 'ORG', score: 0.99, start: 18, end: 22 },
            ],
          }),
          text: async () => '',
        };
      }),
    });
    await det.initialize();
    const matches = await det.detect('Eve met Frank at Acme');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe('Frank');
  });

  it('throws and stays unready when the endpoint is unreachable', async () => {
    const det = new RemoteNerDetector({
      endpoint: 'http://localhost:65535/ner',
      format: 'openai',
      autoInit: false,
      fetchImpl: mockFetch(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    await expect(det.initialize()).rejects.toBeDefined();
    expect(det.isReady()).toBe(false);
    expect(await det.detect('hello')).toEqual([]);
  });
});
