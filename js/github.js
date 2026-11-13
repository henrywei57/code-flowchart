// GitHub access: lists a public repository's files and fetches one file's
// text, straight from the browser with the unauthenticated REST API.
//
// Unauthenticated requests are limited to 60 per hour per IP address. Loading
// a repository costs one API call (the recursive Git Trees API); file contents
// come from raw.githubusercontent.com, which does not count against the limit.
//
// Private-repo support would mean adding an `Authorization` header here (and a
// token input in the UI); nothing else in the app needs to change.

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

export class GitHubError extends Error {
  /**
   * @param {string} message  Human-readable, shown in the UI as is
   * @param {{ kind?: string, status?: number, resetAt?: Date|null }} [details]
   */
  constructor(message, { kind = 'unknown', status = null, resetAt = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind; // invalid | not-found | rate-limit | empty | network | http
    this.status = status;
    this.resetAt = resetAt;
  }
}

/** Latest rate-limit info seen in an API response. */
export const rateLimit = { limit: null, remaining: null, resetAt: null };

const treeCache = new Map();
const fileCache = new Map();

/**
 * Accepts "owner/repo", "github.com/owner/repo", full URLs (including
 * /tree/<ref>/… and /blob/<ref>/<path>), and SSH clone URLs.
 * @returns {{ owner: string, repo: string, ref: string|null, path: string|null }}
 */
export function parseRepoInput(input) {
  let text = String(input || '').trim();
  if (!text) throw new GitHubError('Enter a repository, like "owner/repo" or a GitHub URL.', { kind: 'invalid' });

  text = text.replace(/^git@github\.com:/i, 'github.com/');
  text = text.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '');
  text = text.replace(/[?#].*$/, '').replace(/\/+$/, '');

  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2 || /^https?:/i.test(text)) {
    throw new GitHubError(`"${input}" doesn't look like a GitHub repository. Use "owner/repo" or a github.com URL.`, {
      kind: 'invalid',
    });
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) && /^[A-Za-z0-9._-]{1,100}$/.test(repo);
  if (!valid) {
    throw new GitHubError(`"${owner}/${repo}" isn't a valid GitHub repository name.`, { kind: 'invalid' });
  }

  let ref = null;
  let path = null;
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    ref = decodeURIComponent(parts[3]);
    path = parts.length > 4 ? parts.slice(4).map(decodeURIComponent).join('/') : null;
  }
  return { owner, repo, ref, path };
}

function readRateLimit(res) {
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (limit != null) rateLimit.limit = Number(limit);
  if (remaining != null) rateLimit.remaining = Number(remaining);
  if (reset != null) rateLimit.resetAt = new Date(Number(reset) * 1000);
}

function formatTime(date) {
  return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'later';
}

async function apiGet(path) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: { Accept: 'application/vnd.github+json' } });
  } catch {
    throw new GitHubError("Couldn't reach GitHub. Check your internet connection and try again.", { kind: 'network' });
  }
  readRateLimit(res);
  if (res.ok) return res.json();

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const apiMessage = (body && body.message) || '';
  if ((res.status === 403 || res.status === 429) && (rateLimit.remaining === 0 || /rate limit/i.test(apiMessage))) {
    throw new GitHubError(
      `GitHub's rate limit for anonymous use (${rateLimit.limit || 60} requests per hour) has been reached. ` +
        `It resets at ${formatTime(rateLimit.resetAt)}. Paste mode still works in the meantime.`,
      { kind: 'rate-limit', status: res.status, resetAt: rateLimit.resetAt },
    );
  }
  throw Object.assign(new GitHubError(apiMessage || `GitHub returned an error (HTTP ${res.status}).`, { kind: 'http', status: res.status }), {
    apiMessage,
  });
}

function sizeOk(file) {
  return typeof file.size === 'number';
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * List the JavaScript files in a public repository.
 * @param {{ owner: string, repo: string, ref?: string|null }} target
 * @param {{ extensions: string[] }} options
 */
export async function listRepoFiles({ owner, repo, ref }, { extensions }) {
  const treeRef = ref || 'HEAD';
  const key = `${owner}/${repo}@${treeRef}`.toLowerCase();
  if (treeCache.has(key)) return treeCache.get(key);

  let tree;
  try {
    tree = await apiGet(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`,
    );
  } catch (err) {
    if (err.kind === 'http' && err.status === 404) {
      throw new GitHubError(
        ref
          ? `Couldn't find "${owner}/${repo}" with branch or tag "${ref}". Check the spelling. Private repositories also show up as "not found", because this tool only reads public ones.`
          : `Couldn't find the repository "${owner}/${repo}". Check the spelling. Private repositories also show up as "not found", because this tool only reads public ones.`,
        { kind: 'not-found', status: 404 },
      );
    }
    if (err.kind === 'http' && err.status === 409) {
      throw new GitHubError(`"${owner}/${repo}" is empty; there are no files to analyze yet.`, { kind: 'empty', status: 409 });
    }
    if (err.kind === 'http' && err.status === 451) {
      throw new GitHubError(`"${owner}/${repo}" is unavailable for legal reasons.`, { kind: 'http', status: 451 });
    }
    if (err.kind === 'http' && err.status >= 500) {
      throw new GitHubError('GitHub is having trouble right now (server error). Try again in a minute.', {
        kind: 'http',
        status: err.status,
      });
    }
    throw err;
  }

  const lowerExts = extensions.map((e) => e.toLowerCase());
  const files = (tree.tree || [])
    .filter((item) => item.type === 'blob' && lowerExts.some((ext) => item.path.toLowerCase().endsWith(ext)))
    .map((item) => ({ path: item.path, size: sizeOk(item) ? item.size : null, sha: item.sha }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));

  const result = { owner, repo, ref: treeRef, files, truncated: !!tree.truncated };
  treeCache.set(key, result);
  return result;
}

/** Fetch one file's text (raw.githubusercontent.com first, the API as a fallback). */
export async function fetchFileText({ owner, repo, ref }, file) {
  const key = `${owner}/${repo}@${ref}:${file.path}`.toLowerCase();
  if (fileCache.has(key)) return fileCache.get(key);

  const rawUrl = `${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodePath(ref)}/${file.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  let text = null;
  try {
    const res = await fetch(rawUrl);
    if (res.ok) text = await res.text();
  } catch {
    /* fall back to the API below */
  }

  if (text == null) {
    if (!file.sha) throw new GitHubError(`Couldn't download "${file.path}".`, { kind: 'http' });
    const blob = await apiGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${file.sha}`);
    const binary = atob(String(blob.content || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    text = new TextDecoder('utf-8').decode(bytes);
  }

  fileCache.set(key, text);
  return text;
}

/** Link to a file on github.com. */
export function fileUrl({ owner, repo, ref }, path) {
  return `https://github.com/${owner}/${repo}/blob/${encodePath(ref)}/${encodePath(path)}`;
}

const GENERATED = [
  /(^|\/)node_modules\//,
  /(^|\/)(vendor|vendors|third[_-]?party|bower_components)\//i,
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.output|public\/build)\//i,
  /\.min\.(m|c)?js$/i,
  /(^|[./-])(bundle|chunk|vendor)[.-][\w.-]*\.js$/i,
  /\.(bundle|chunk)\.(m|c)?js$/i,
];

/** Heuristic: minified, bundled, or vendored code that is rarely worth charting. */
export function isLikelyGenerated(path) {
  return GENERATED.some((re) => re.test(path));
}
