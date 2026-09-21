/* Talking to Claude from the server.
 *
 * The page can ask Claude in two ways:
 *   - published as a Claude artifact, the browser asks Claude directly
 *   - served by this backend, the browser posts to /api/ask and this file calls
 *     the Anthropic API with the key in ANTHROPIC_API_KEY
 *
 * Without a key, /api/ask returns 503 and the page hides the feature.
 */
const API_URL = "https://api.anthropic.com/v1/messages";
// Override with ANTHROPIC_MODEL if a newer model is out; `curl https://api.anthropic.com/v1/models`
// with your key lists what your account can use.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

export const askEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** Send one prompt, get the reply text back. Throws on a failed request. */
export async function askClaude(prompt, { maxTokens = 2000, signal } = {}) {
  if (!askEnabled()) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

/** Same, but for a prompt that asks for JSON: returns the parsed value. */
export async function askClaudeJson(prompt, opts) {
  const text = await askClaude(prompt, opts);
  return parseJson(text);
}

/** Models sometimes wrap JSON in prose or a code fence. Take the JSON out. */
export function parseJson(text) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return undefined; } };
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) { const v = tryParse(fence[1].trim()); if (v !== undefined) return v; }
  const start = Math.min(...[text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0));
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (isFinite(start) && end > start) { const v = tryParse(text.slice(start, end + 1)); if (v !== undefined) return v; }
  throw new Error("Claude's reply was not JSON");
}
