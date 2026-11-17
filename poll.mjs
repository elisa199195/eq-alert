// GitHub Actions poller: every 5 minutes, fetch P2PQuake history, apply the
// same rules as the local monitor, and post to the Feishu bot.
//
//   node poll.mjs            # normal run (secrets from env)
//   node poll.mjs --dry-run  # print what would be sent, no state change
//
// env: FEISHU_WEBHOOK (required), FEISHU_SECRET (optional, 签名校验)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCALE_RANK = { 0: 0, 10: 10, 20: 20, 30: 30, 40: 40, 45: 50, 46: 50, 50: 55, 55: 60, 60: 65, 70: 70, 99: 70 };
const MIN_RANK = 50;
const MIN_MAGNITUDE_EXCLUSIVE = 6.0;
const HISTORY_URL = 'https://api.p2pquake.net/v2/history?codes=551&codes=556&limit=100';
const MAX_AGE_MS = Number(process.env.MAX_AGE_MS ?? 20 * 60 * 1000); // test override
const STATE_DIR = process.env.STATE_DIR ?? 'state';
const STATE_FILE = path.join(STATE_DIR, 'seen.json');
const RANK_LABEL = { 50: '震度5弱', 55: '震度5強', 60: '震度6弱', 65: '震度6強', 70: '震度7' };

function scaleRank(value) {
  const n = Number(value);
  return Number.isFinite(n) ? (SCALE_RANK[Math.trunc(n)] ?? 0) : 0;
}

function labelFromRank(rank) {
  return RANK_LABEL[rank] ?? (rank > 0 ? `震度${Math.floor(rank / 10)}` : '震度不明');
}

// "2026/11/17 13:24:00" is JST.
function parseJst(value) {
  const m = String(value ?? '').match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

function magnitudeOf(hypo) {
  const n = Number(hypo?.magnitude);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function depthOf(hypo) {
  const n = Number(hypo?.depth);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function evaluate(item) {
  const code = Number(item?.code);
  if (code === 551) {
    const eq = item.earthquake ?? {};
    const hypo = eq.hypocenter ?? {};
    const rank = scaleRank(eq.maxScale);
    const magnitude = magnitudeOf(hypo);
    if (rank < MIN_RANK && !(magnitude !== null && magnitude > MIN_MAGNITUDE_EXCLUSIVE)) return null;
    const epoch = parseJst(eq.time);
    return {
      kind: '地震情報',
      source: 'result',
      key: Number.isFinite(epoch) ? `p2p:quake:${epoch}` : `p2p:quake:${item.id}`,
      eventId: String(item.id ?? ''),
      epoch,
      epicenter: String(hypo.name ?? ''),
      depthKm: depthOf(hypo),
      magnitude,
      maxRank: rank,
      maxIntensity: labelFromRank(rank),
      serial: '',
      comment: eq.domesticTsunami === 'None' ? 'この地震による津波の心配はありません' : '',
    };
  }
  if (code === 556) {
    if (item.test === true || item.cancelled === true) return null;
    const issue = item.issue ?? {};
    if (Number(issue.serial) > 1) return null;
    const eq = item.earthquake ?? {};
    const hypo = eq.hypocenter ?? {};
    let rank = 0;
    for (const area of item.areas ?? []) {
      rank = Math.max(rank, scaleRank(area?.scaleTo), scaleRank(area?.scaleFrom));
    }
    const magnitude = magnitudeOf(hypo);
    if (rank < MIN_RANK && !(magnitude !== null && magnitude > MIN_MAGNITUDE_EXCLUSIVE)) return null;
    const epoch = parseJst(eq.originTime);
    return {
      kind: '緊急地震速報（警報）',
      source: 'eew',
      key: `p2p:eew:${issue.eventId ?? epoch ?? item.id}`,
      eventId: String(issue.eventId ?? ''),
      epoch,
      epicenter: String(hypo.name ?? ''),
      depthKm: depthOf(hypo),
      magnitude,
      maxRank: rank,
      maxIntensity: labelFromRank(rank),
      serial: String(issue.serial ?? ''),
      comment: '',
    };
  }
  return null;
}

function formatTime(epoch) {
  if (!Number.isFinite(epoch)) return '不明';
  const d = new Date(epoch + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST`;
}

function formatAlert(a) {
  const mag = a.magnitude !== null ? `M${a.magnitude.toFixed(1)}` : null;
  const parts = [];
  if (a.maxRank >= MIN_RANK) parts.push(a.maxIntensity);
  if (mag) parts.push(mag);
  const level = parts.length > 0 ? parts.join(' / ') : a.maxIntensity;
  const kind = `${a.kind}${a.serial ? ` 第${a.serial}報` : ''}${a.source === 'eew' ? '（予測）' : ''}`;
  const origin = a.epicenter
    ? `${a.epicenter}${a.depthKm !== null ? ` / 深さ 約${a.depthKm}km` : ''}`
    : '不明';
  const lines = [
    `🚨 地震アラート — ${level}`,
    `種別: ${kind}`,
    `発生: ${formatTime(a.epoch)}`,
    `震源: ${origin}`,
    `最大震度${a.source === 'eew' ? '（予測）' : '（観測）'}: ${a.maxIntensity.replace(/^震度/, '')}`,
  ];
  if (mag) lines.push(`規模: ${mag}${a.source === 'eew' ? '（推定）' : ''}`);
  if (a.comment) lines.push(`津波: ${a.comment}`);
  lines.push(`イベントID: ${a.eventId}`);
  return lines.join('\n');
}

function sign(secret, timestamp) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

async function notify(text) {
  const webhook = process.env.FEISHU_WEBHOOK;
  if (!webhook) throw new Error('FEISHU_WEBHOOK is not set (add it as a repository secret)');
  const body = { msg_type: 'text', content: { text } };
  if (process.env.FEISHU_SECRET) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = sign(process.env.FEISHU_SECRET, timestamp);
  }
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || (payload.code ?? 0) !== 0) {
    throw new Error(`feishu rejected: ${res.status} ${JSON.stringify(payload).slice(0, 200)}`);
  }
}

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(seen, null, 2), 'utf8');
}

async function main() {
  if (process.env.TEST_NOTIFY === '1') {
    await notify(
      `✅ 地震アラート監視テスト（GitHub Actions）\n${new Date().toISOString()}\n` +
        'Webhook の疎通確認です。実際の地震情報ではありません。',
    );
    console.log('test notification sent');
    return;
  }

  const dryRun = process.argv.includes('--dry-run');
  const res = await fetch(HISTORY_URL);
  if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
  const items = await res.json();
  const now = Date.now();
  const seen = loadSeen();
  const sent = [];

  for (const item of items) {
    const alert = evaluate(item);
    if (!alert) continue;
    if (alert.epoch === null || now - alert.epoch > MAX_AGE_MS) continue;
    if (seen[alert.key]) continue;
    seen[alert.key] = now;
    const text = formatAlert(alert);
    if (dryRun) {
      console.log(`[dry-run] would send:\n${text}\n`);
    } else {
      await notify(text);
      console.log(`[sent] ${alert.key}`);
    }
    sent.push(alert.key);
  }

  for (const [key, at] of Object.entries(seen)) {
    if (now - at > 7 * 24 * 3600 * 1000) delete seen[key];
  }
  if (!dryRun) saveSeen(seen);
  console.log(`messages=${items.length} alerts=${sent.length}${sent.length ? ` keys=${sent.join(',')}` : ''}`);
}

main().catch((err) => {
  console.error(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
