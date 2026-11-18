/**
 * Safe document fetcher used by the PDF preview.
 *
 * Why this exists: the eTenders document links are served as downloads and live on
 * another site, so a browser can't show them inline. We fetch the file server-side
 * and hand it back as a normal response the browser can preview.
 *
 * It is NOT an open proxy: only https URLs on an allow-list of government hosts are
 * fetched (redirects are re-checked at every hop), and size/time are capped.
 */
import https from 'https';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const MAX_DOC_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const UA = 'MadeWellTenders/1.0 (+https://madewell.co.za)';

export function allowedHosts() {
  const extra = (process.env.DOC_PROXY_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ['etenders.gov.za', 'treasury.gov.za', ...extra];
}

/** true if `urlStr` is an allowed URL (https + allow-listed host or subdomain, no credentials). */
export function isAllowedUrl(urlStr, { hosts = allowedHosts(), protocols = ['https:'] } = {}) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (!protocols.includes(u.protocol)) return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith('.' + h));
}

function nodeGet(urlStr, protocols) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Accept: '*/*', 'User-Agent': UA, Connection: 'close' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, redirect: new URL(res.headers.location, urlStr).toString() });
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_DOC_BYTES) {
            req.destroy(new Error('too_large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, contentType: res.headers['content-type'] || '', buffer: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Fallback for servers with odd TLS setups that Node refuses but curl accepts. */
async function curlGet(urlStr) {
  const tmp = path.join(os.tmpdir(), 'mw-doc-' + crypto.randomBytes(8).toString('hex'));
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sS', '--max-time', String(Math.ceil(TIMEOUT_MS / 1000)),
        '--max-filesize', String(MAX_DOC_BYTES),
        '--max-redirs', '0', // we follow redirects ourselves so every hop is allow-list checked
        '--proto', '=https',
        '-A', UA,
        '-o', tmp,
        '-w', '%{http_code}\t%{redirect_url}\t%{content_type}',
        urlStr,
      ],
      { timeout: TIMEOUT_MS + 2000 }
    );
    const [code, redirect, contentType] = stdout.split('\t');
    const status = parseInt(code, 10) || 0;
    if (status >= 300 && status < 400 && redirect) return { status, redirect };
    return { status, contentType: contentType || '', buffer: fs.readFileSync(tmp) };
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

/**
 * Fetch an allow-listed document. Returns { buffer, contentType, finalUrl }.
 * Throws Error with .code in: 'not_allowed' | 'too_large' | 'upstream_<status>' | 'failed'
 */
export async function fetchDocument(urlStr, opts = {}) {
  const policy = { hosts: opts.hosts || allowedHosts(), protocols: opts.protocols || ['https:'] };
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(current, policy)) {
      const e = new Error('URL not allowed'); e.code = 'not_allowed'; throw e;
    }
    let r;
    try {
      r = await nodeGet(current, policy.protocols);
    } catch (err) {
      if (err.message === 'too_large') { const e = new Error('File too large'); e.code = 'too_large'; throw e; }
      if (opts.noCurl) { const e = new Error(err.message); e.code = 'failed'; throw e; }
      try {
        r = await curlGet(current);
      } catch (err2) {
        const e = new Error(err2.message || err.message); e.code = /filesize/i.test(String(err2.message)) ? 'too_large' : 'failed'; throw e;
      }
    }
    if (r.redirect) { current = r.redirect; continue; }
    if (r.status < 200 || r.status >= 300) { const e = new Error('Upstream ' + r.status); e.code = 'upstream_' + r.status; throw e; }
    return { buffer: r.buffer, contentType: r.contentType, finalUrl: current };
  }
  const e = new Error('Too many redirects'); e.code = 'failed'; throw e;
}

/** Does this look like a PDF? (the %PDF- marker may sit a little way into the file) */
export function looksLikePdf(buf) {
  return buf.subarray(0, 1024).indexOf('%PDF-') !== -1;
}
