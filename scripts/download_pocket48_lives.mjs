#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const OFFICIAL_API = 'https://pocketapi.48.cn/live/api/v1/live';
const MSG48_API = 'https://msg48.org/api/live';
const DEFAULT_OUT_ROOT = '/Users/cbj/Documents/48';
const DEFAULT_MEMBER_SOURCE = '/private/tmp/roomId.json';
const USER_AGENT = 'PocketFans201807/6.0.16 (iPhone; iOS 13.5.1; Scale/2.00)';

const KNOWN_MEMBERS = new Map([
  ['谭思慧', '89653513'],
]);

const LIVE_TYPE_LABELS = {
  1: '直播',
  2: '电台',
  5: '游戏',
  6: 'AI',
};

const GROUP_ID_MAP = {
  0: '全部',
  10: 'SNH48',
  11: 'BEJ48',
  12: 'GNZ48',
  14: 'CKG48',
  21: 'CGT48',
  15: 'IDFT',
  19: '明星殿堂',
  17: 'THE9',
  18: '硬糖少女303',
  20: '丝芭影视',
  16: '海外练习生',
};

const USER_ROLE_LABELS = {
  3: '偶像',
};

function usage() {
  console.error(`Usage: node download_pocket48_lives.mjs [options]

Options:
  --member NAME              Member name, default "谭思慧"
  --since 'YYYY-MM-DD HH:mm:ss'  Start time, default 7 days ago
  --user-id ID               Pocket48 userId; skips member-source lookup
  --group-id N               Filter by team (10=SNH48, 21=CGT48, etc.)
  --proxy URL                Use API proxy (e.g. https://msg48.org/api/live)
  --out-root DIR             Output root, default ${DEFAULT_OUT_ROOT}
  --member-source FILE       roomId.json source, default ${DEFAULT_MEMBER_SOURCE}
  --ffmpeg PATH              ffmpeg binary, default auto-detect
  --ffprobe PATH             ffprobe binary, default auto-detect
  --max-pages N              Max getLiveList pages, default 20
  --concurrency N            Parallel ffmpeg downloads, default 1; recommend 2-3
  --info-only                Show all metadata for selected recordings, no download
  --download-video           Download video/audio stream (default: true)
  --download-danmaku         Download LRC danmaku files
  --download-all             Download video + danmaku + metadata JSON
  --live-type N              Filter by type: 1=直播, 2=电台, 5=游戏, 6=AI (comma-sep)
  --json                     Output metadata as JSON
  --dry-run                  List selected recordings without downloading
`);
}

function parseArgs(argv) {
  const out = {
    member: '谭思慧',
    outRoot: DEFAULT_OUT_ROOT,
    memberSource: DEFAULT_MEMBER_SOURCE,
    maxPages: 20,
    concurrency: 1,
    dryRun: false,
    infoOnly: false,
    downloadVideo: true,
    downloadDanmaku: false,
    json: false,
    groupId: '0',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--info-only') {
      out.infoOnly = true;
    } else if (arg === '--download-video') {
      out.downloadVideo = true;
    } else if (arg === '--download-danmaku' || arg === '--dl-danmaku') {
      out.downloadDanmaku = true;
    } else if (arg === '--download-all') {
      out.downloadVideo = true;
      out.downloadDanmaku = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      out[key] = val;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  out.maxPages = Number(out.maxPages || 20);
  out.concurrency = Math.max(1, Number(out.concurrency || 1));
  if (!Number.isInteger(out.concurrency)) throw new Error('--concurrency must be an integer');
  return out;
}

function parseLocalDate(value) {
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid date: ${value}; expected YYYY-MM-DD HH:mm:ss`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function timeString(ms) {
  const d = new Date(Number(ms));
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}~${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

function displayTime(ms) {
  return timeString(ms).replace('~', ' ').replace(/\.(\d{2})\.(\d{2})$/, ':$1:$2');
}

function sanitizeName(value) {
  return String(value || '').replace(/[\u0000/\\:]/g, '_').replace(/\s+/g, ' ').trim() || 'untitled';
}

function commandExists(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

function defaultFfmpeg() {
  if (commandExists('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
  return 'ffmpeg';
}

function defaultFfprobe() {
  if (commandExists('/opt/homebrew/bin/ffprobe')) return '/opt/homebrew/bin/ffprobe';
  return 'ffprobe';
}

function apiBase(opts) {
  return opts.proxy || OFFICIAL_API;
}

function pocketHeaders() {
  return {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': USER_AGENT,
    'Accept-Language': 'zh-Hans-AW;q=1',
    'Host': 'pocketapi.48.cn',
    'appInfo': JSON.stringify({
      vendor: 'apple',
      deviceId: 'ABCDEFGH-ABCD-ABCD-ABCD-ABCDEFGHIJKL',
      appVersion: '7.0.4',
      appBuild: '23011601',
      osVersion: '16.3.1',
      osType: 'ios',
      deviceName: 'iPhone XR',
      os: 'ios'
    })
  };
}

function proxyHeaders() {
  return { 'Content-Type': 'application/json;charset=utf-8' };
}

async function postJson(url, body, useProxy) {
  const headers = useProxy ? proxyHeaders() : pocketHeaders();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(`${url} API error: ${json.message || JSON.stringify(json)}`);
  return json.content;
}

async function searchMemberViaApi(member, opts, maxPages = 5) {
  const base = apiBase(opts);
  let next = '0';
  for (let page = 1; page <= maxPages; page++) {
    let content;
    try {
      content = await postJson(`${base}/getLiveList`, { userId: '0', next }, !!opts.proxy);
    } catch (e) {
      console.error(`API search page ${page} failed: ${e.message}`);
      return null;
    }
    const lives = content.liveList || [];
    for (const live of lives) {
      const name = live.userInfo?.nickname || '';
      if (name.includes(member)) {
        console.log(`API search hit: ${name} userId=${live.userInfo.userId} (page ${page})`);
        return String(live.userInfo.userId);
      }
    }
    if (!content.next || content.next === next) break;
    next = String(content.next);
  }
  return null;
}

async function resolveUserId(opts) {
  if (opts.userId) return String(opts.userId);

  const knownId = KNOWN_MEMBERS.get(opts.member);
  if (knownId) {
    console.log(`LOOKUP ${opts.member} -> userId=${knownId} (built-in table)`);
    return knownId;
  }

  try {
    const raw = await fsp.readFile(opts.memberSource, 'utf8');
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data.roomId;
    if (Array.isArray(list)) {
      const exact = list.find(x => [x.ownerName, x.starName, x.nickname, x.userName].filter(Boolean).includes(opts.member));
      const hit = exact || list.find(x => [x.ownerName, x.starName, x.nickname, x.userName, x.pinyin].filter(Boolean).some(v => String(v).includes(opts.member)));
      if (hit) {
        const id = String(hit.userId || hit.id);
        console.log(`LOOKUP ${opts.member} -> userId=${id} (${opts.memberSource})`);
        return id;
      }
    }
  } catch {}

  console.log(`SEARCH ${opts.member} via API...`);
  const apiId = await searchMemberViaApi(opts.member, opts);
  if (apiId) {
    console.log(`LOOKUP ${opts.member} -> userId=${apiId} (API search)`);
    return apiId;
  }

  throw new Error(`Cannot resolve member "${opts.member}". Use --user-id to specify the Pocket48 userId directly.`);
}

async function fetchLiveList(userId, sinceMs, opts) {
  const selected = [];
  let next = '0';
  const base = apiBase(opts);
  const typeSet = opts.liveType ? new Set(opts.liveType.split(',').map(Number)) : null;
  for (let page = 1; page <= opts.maxPages; page++) {
    const body = { userId, next };
    if (opts.groupId !== '0') body.groupId = Number(opts.groupId);
    const content = await postJson(`${base}/getLiveList`, body, !!opts.proxy);
    const lives = content.liveList || [];
    if (!lives.length) break;
    for (const live of lives) {
      const ctime = Number(live.ctime);
      if (ctime >= sinceMs) {
        if (typeSet && !typeSet.has(live.liveType)) continue;
        selected.push(live);
      }
    }
    const oldest = Math.min(...lives.map(x => Number(x.ctime)).filter(Number.isFinite));
    if (oldest < sinceMs) break;
    if (!content.next || content.next === next) break;
    next = String(content.next);
  }
  return selected.sort((a, b) => Number(a.ctime) - Number(b.ctime));
}

async function getLiveOne(liveId, opts) {
  const base = apiBase(opts);
  return postJson(`${base}/getLiveOne`, { liveId: String(liveId) }, !!opts.proxy);
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: opts.stdio || 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`)));
  });
}

async function validMedia(file, ffprobe) {
  if (!fs.existsSync(file)) return false;
  try {
    await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function mapLimit(items, limit, mapper) {
  let cursor = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatLiveRecord(live, detail) {
  const liveType = live.liveType ?? detail?.liveType;
  const typeLabel = LIVE_TYPE_LABELS[liveType] || `未知(${liveType})`;
  const ui = live.userInfo;
  const du = detail?.user;

  const roles = [];
  if (ui?.isStar || du?.isStar) roles.push('明星成员');
  if (ui?.vip || du?.vip) roles.push('VIP');
  const roleLabel = roles.length ? roles.join(' · ') : (ui?.userRole ? (USER_ROLE_LABELS[ui.userRole] || `角色${ui.userRole}`) : '?');

  const coverPath = live.coverPath || detail?.coverPath || '';
  const coverUrl = coverPath ? `https://source.48.cn${coverPath.startsWith('/') ? '' : '/'}${coverPath}` : '(无)';
  const dims = (live.coverWidth && live.coverHeight) ? `${live.coverWidth}×${live.coverHeight}` : null;

  const lines = [
    `  Live ID:     ${live.liveId}`,
    `  类型:        ${typeLabel}`,
    `  时间:        ${displayTime(live.ctime)}`,
    `  时长:        ${live.duration || '(未知)'}`,
    `  标题:        ${detail?.title || live.title || '(无标题)'}`,
    `  公告:        ${detail?.announcement || live.announcement || '(无)'}`,
    `  成员:        ${ui?.nickname || du?.userName || '?'}`,
    `  真实姓名:    ${ui?.starName || '?'}`,
    `  等级:        ${ui?.level ?? du?.level ?? '?'}`,
    `  身份:        ${roleLabel}`,
    `  粉丝数:      ${ui?.followers ?? '?'}`,
    `  签名:        ${ui?.signature || '(无)'}`,
    `  观看人数:    ${live.onlineNum ?? detail?.onlineNum ?? '?'}`,
    `  播放次数:    ${live.playNum ?? detail?.playNum ?? '?'}`,
    `  状态:        ${live.status ?? detail?.status ?? '?'}`,
    `  封面尺寸:    ${dims || '(未知)'}`,
    `  liveMode:    ${live.liveMode ?? detail?.liveMode ?? '?'}`,
    `  连麦中:      ${live.inMicrophoneConnection ?? detail?.inMicrophoneConnection ?? '?'}`,
    `  PK连麦:      ${live.inMicrophonePkConnection ?? '?'}`,
    `  房间ID:      ${live.roomId ?? detail?.roomId ?? '?'}`,
    `  M3U8:        ${detail?.playStreamPath || '(无)'}`,
    `  弹幕文件:    ${detail?.msgFilePath || '(无)'}`,
    `  封面:        ${coverUrl}`,
  ];
  return lines.join('\n');
}

async function downloadDanmaku(lrcUrl, outPath) {
  console.log(`  DANMAKU ${lrcUrl} -> ${outPath}`);
  const res = await fetch(lrcUrl);
  if (!res.ok) throw new Error(`LRC HTTP ${res.status}`);
  const text = await res.text();
  await fsp.writeFile(outPath, text, 'utf8');
  const lineCount = text.split('\n').filter(l => l.includes(']')).length;
  console.log(`  DANMAKU done: ${lineCount} lines`);
  return { lineCount };
}

async function processOne(live, opts, fetchDetail) {
  if (opts.json || opts.infoOnly) {
    let detail = null;
    if (fetchDetail) {
      try { detail = await getLiveOne(live.liveId, opts); } catch {}
    }
    if (opts.json) {
      const meta = { ...live, _detail: detail };
      console.log(JSON.stringify(meta, null, 2));
    } else {
      console.log(formatLiveRecord(live, detail));
    }
    return { liveId: live.liveId, status: 'info' };
  }

  const detail = await getLiveOne(live.liveId, opts);
  const m3u8 = detail.playStreamPath;
  const nickname = sanitizeName(live.userInfo?.nickname || detail.user?.userName || opts.member);
  const title = sanitizeName(live.title || detail.title || 'live');
  const tsTime = timeString(live.ctime);
  const dir = path.join(opts.outRoot, opts.member, tsTime);
  await fsp.mkdir(dir, { recursive: true });

  let outVideo = null;
  let outDanmaku = null;
  let outMeta = null;

  if (opts.downloadVideo && m3u8) {
    outVideo = path.join(dir, `[口袋48录播]_${nickname}_${title}_${tsTime}_${live.liveId}.ts`);
    const part = `${outVideo}.part`;
    if (await validMedia(outVideo, opts.ffprobe)) {
      console.log(`SKIP VIDEO ${live.liveId} ${outVideo}`);
    } else {
      console.log(`DOWNLOAD VIDEO ${live.liveId} -> ${outVideo}`);
      await run(opts.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-rw_timeout', '300000000', '-user_agent', 'SNH48 ENGINE', '-i', m3u8, '-c', 'copy', '-f', 'mpegts', part]);
      await fsp.rename(part, outVideo);
      if (!(await validMedia(outVideo, opts.ffprobe))) throw new Error(`ffprobe validation failed: ${outVideo}`);
      console.log(`DONE VIDEO ${live.liveId}`);
    }
  }

  if (opts.downloadDanmaku && detail.msgFilePath) {
    outDanmaku = path.join(dir, `${tsTime}.lrc`);
    if (fs.existsSync(outDanmaku)) {
      console.log(`SKIP DANMAKU ${live.liveId} ${outDanmaku}`);
    } else {
      try {
        await downloadDanmaku(detail.msgFilePath, outDanmaku);
      } catch (e) {
        console.error(`  DANMAKU FAILED: ${e.message}`);
      }
    }
  }

  outMeta = path.join(dir, `${tsTime}.json`);
  await fsp.writeFile(outMeta, JSON.stringify({ ...live, _detail: detail }, null, 2), 'utf8');
  console.log(`META ${live.liveId} -> ${outMeta}`);

  return { liveId: live.liveId, status: 'done', outVideo, outDanmaku, outMeta };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.ffmpeg ||= defaultFfmpeg();
  opts.ffprobe ||= defaultFfprobe();

  if (!opts.since) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    opts.since = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgo.getDate()).padStart(2, '0')} 00:00:00`;
  }

  if (opts.json && !opts.downloadDanmaku && opts.downloadVideo === true) {
    opts.infoOnly = true;
  }

  if (opts.proxy) {
    console.log(`PROXY ${opts.proxy}`);
  }

  const sinceMs = parseLocalDate(opts.since);
  const userId = await resolveUserId(opts);
  console.log(`MEMBER ${opts.member} userId=${userId}`);
  if (opts.groupId && opts.groupId !== '0') {
    const label = GROUP_ID_MAP[opts.groupId] || `未知(${opts.groupId})`;
    console.log(`GROUP ${opts.groupId} (${label})`);
  }
  const lives = await fetchLiveList(userId, sinceMs, opts);
  console.log(`SELECTED ${lives.length}`);

  if (opts.json || opts.infoOnly) {
    for (const live of lives) {
      const typeLabel = LIVE_TYPE_LABELS[live.liveType] || `未知(${live.liveType})`;
      console.log(`--- ${displayTime(live.ctime)} [${typeLabel}] ${live.title || ''} ---`);
      await processOne(live, opts, true);
    }
    if (opts.json) return;
  } else {
    for (const live of lives) {
      const typeLabel = LIVE_TYPE_LABELS[live.liveType] || `未知(${live.liveType})`;
      console.log(`${displayTime(live.ctime)} ${live.liveId} [${typeLabel}] ${live.title || ''}`);
    }
  }

  if (opts.dryRun || opts.infoOnly) return;

  console.log(`CONCURRENCY ${opts.concurrency}`);
  const results = await mapLimit(lives, opts.concurrency, live => processOne(live, opts, false));
  console.log(`ALL_DONE ${results.length}/${lives.length}`);
}

main().catch(err => {
  usage();
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
