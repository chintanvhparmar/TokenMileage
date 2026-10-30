// Tavily client (https://docs.tavily.com): web search and page extraction for model research.
// Only model names and vendor domains are ever sent; never prompt text or anything from a chat.
import { getSettings } from '../shared/settings.js';
import { logUsage } from './usageLog.js';

const BASE = 'https://api.tavily.com';
const TIMEOUT_MS = 25000;

export class TavilyError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'no_key' | 'auth' | 'http' | 'network'
  }
}

// stats (optional): per-run totals, { tavily_calls, tavily_credits }.
async function call(path, body, stats) {
  const { tavilyKey } = await getSettings();
  if (!tavilyKey) throw new TavilyError('Add your Tavily API key in TokenMileage options', 'no_key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tavilyKey}` },
      body: JSON.stringify({ ...body, include_usage: true }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new TavilyError(e.name === 'AbortError' ? 'Tavily timed out' : 'Could not reach Tavily', 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const auth = res.status === 401 || res.status === 403;
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new TavilyError(auth ? 'Tavily API key was rejected' : `Tavily returned HTTP ${res.status} ${detail}`, auth ? 'auth' : 'http');
  }
  const data = await res.json();
  const credits = data.usage?.credits ?? null;
  await logUsage({ feature: 'research', service: 'tavily', endpoint: path.slice(1), credits });
  if (stats) {
    stats.tavily_calls = (stats.tavily_calls ?? 0) + 1;
    stats.tavily_credits = (stats.tavily_credits ?? 0) + (credits ?? 0);
  }
  return data;
}

// Basic search (1 credit), restricted to the given domains. Returns [{ title, url, content }].
export async function search(query, domains, maxResults = 5, stats) {
  const data = await call('/search', {
    query,
    search_depth: 'basic',
    max_results: maxResults,
    chunks_per_source: 3,
    include_domains: domains,
  }, stats);
  return (data.results ?? []).map(({ title, url, content }) => ({ title, url, content }));
}

// Extracts up to 3 pages (1 credit per 5 pages), keeping only the chunks most relevant to `query`.
// Returns { pages: [{ url, text }], failed: [url] }.
export async function extract(urls, query, stats) {
  const data = await call('/extract', {
    urls: urls.slice(0, 3),
    query,
    chunks_per_source: 5,
    extract_depth: 'basic',
    format: 'markdown',
  }, stats);
  return {
    pages: (data.results ?? []).map((r) => ({ url: r.url, text: r.raw_content ?? '' })),
    failed: (data.failed_results ?? []).map((r) => r.url),
  };
}

// Options-page check: one 1-credit search.
export async function testTavily() {
  const results = await search('Anthropic Claude models overview', ['anthropic.com'], 1);
  return { ok: true, results: results.length };
}
