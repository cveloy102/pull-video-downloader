'use strict';

// Picks the one video a person most likely wants from everything the built-in
// browser caught on a page (ads, previews, the same video in several qualities).

const AD_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|imasdk\.googleapis\.com|adservice\.google\.[a-z.]+|adfox\.ru|adfox\.yandex\.ru|an\.yandex\.ru|ads\.adfox\.ru|adriver\.ru|betweendigital\.com|mediasniper\.ru|adhigh\.net|smartadserver\.com|spotxchange\.com|springserve\.com|moatads\.com|adsrvr\.org|advertising\.com|teads\.tv|vidazoo\.com|outbrain\.com|taboola\.com)$/i;
const AD_PATH = /(^|[/_.-])(ads?|adv|advert|preroll|pre-roll|midroll|vast|vpaid|promo)([/_.-]|$)/i;
const SHORT_SECONDS = 45;

function looksLikeAd(candidate) {
  let url;
  try { url = new URL(candidate.url); } catch { return false; }
  return AD_HOST.test(url.hostname) || /^ads?\./i.test(url.hostname) || AD_PATH.test(url.pathname);
}

function words(text) {
  return new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));
}

// Share of page-title words that appear in the candidate title (0..1).
function titleMatch(candidate, pageTitle) {
  const page = words(pageTitle);
  if (!page.size) return 0;
  const own = words(candidate.title);
  let hits = 0;
  for (const word of page) if (own.has(word)) hits++;
  return hits / page.size;
}

function score(candidate, pageTitle) {
  const probe = candidate.probe || {};
  const ad = looksLikeAd(candidate);
  let value = 0;
  if (ad) value -= 100;
  if (candidate.kind === 'audio') value -= 25;
  if (['hls', 'dash', 'mss'].includes(candidate.kind)) value += 6;
  if (probe.status === 'failed') value -= 40;
  if (Number.isFinite(probe.duration) && probe.duration > 0) {
    value += probe.duration < SHORT_SECONDS ? -30 : Math.min(probe.duration / 60, 30);
  }
  if (probe.height) value += Math.min(probe.height, 2160) / 120;
  if (probe.variants > 1) value += 3;
  value += titleMatch(candidate, pageTitle) * 8;
  return { value, ad, short: Number.isFinite(probe.duration) && probe.duration > 0 && probe.duration < SHORT_SECONDS };
}

// Two candidates are the same video in different qualities when they come
// from the same host and have (nearly) the same known duration.
function sameVideo(a, b) {
  const da = a.probe?.duration; const db = b.probe?.duration;
  return a.host === b.host && Number.isFinite(da) && Number.isFinite(db) && da > 0 && Math.abs(da - db) <= 1.5;
}

function rankCandidates(candidates = [], pageTitle = '') {
  const scored = candidates.map((candidate) => ({ candidate, ...score(candidate, pageTitle) }))
    .sort((a, b) => b.value - a.value);
  const probing = scored.some(({ candidate }) => !candidate.probe || candidate.probe.status === 'probing');
  // Keep only the best-scoring copy of each video; the rest stay under "other options".
  const unique = [];
  const duplicates = [];
  for (const item of scored) (unique.some((kept) => sameVideo(kept.candidate, item.candidate)) ? duplicates : unique).push(item);
  const eligible = unique.filter((item) => !item.ad && item.candidate.probe?.status === 'ready' && item.candidate.kind !== 'audio');
  const top = eligible[0] || null;
  // High confidence: a real-length, non-ad video was measured. Short clips can
  // still be the answer (a clip site), but they are never downloaded automatically.
  const confidence = top && !top.short ? 'high' : top ? 'low' : 'none';
  const label = (item) => ({ id: item.candidate.id, ad: item.ad, short: item.short, duplicate: duplicates.includes(item) });
  return {
    best: top ? top.candidate.id : null,
    confidence,
    probing,
    others: [...unique, ...duplicates].filter((item) => item !== top).map(label)
  };
}

module.exports = { rankCandidates, looksLikeAd, titleMatch, SHORT_SECONDS };
