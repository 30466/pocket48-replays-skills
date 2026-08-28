#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API_ENDPOINTS = [
  {
    name: 'official',
    baseUrl: 'https://pocketapi.48.cn/live/api/v1/live',
    officialHost: true,
  },
  {
    name: 'tools.abm48.com',
    baseUrl: 'https://tools.abm48.com/pocketapi',
    officialHost: false,
  },
];
const DEFAULT_OUT_ROOT = '/Users/cbj/Documents/48';
const DEFAULT_MEMBER_SOURCE = 'https://abm48.com/api/public/snh48/room-map';
const USER_AGENT = 'PocketFans201807/6.0.16 (iPhone; iOS 13.5.1; Scale/2.00)';

const PER_SEGMENT_OVERHEAD_SEC = 0.1; // 每分片 HTTP 往返开销补偿（秒）

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
  --out-root DIR             Output root, default ${DEFAULT_OUT_ROOT}
  --member-source URL|FILE   Member map source (URL or local JSON), default ${DEFAULT_MEMBER_SOURCE}
  --ffmpeg PATH              ffmpeg binary, default auto-detect
  --ffprobe PATH             ffprobe binary, default auto-detect
  --max-pages N              Max getLiveList pages, default 200
  --concurrency N            Parallel ffmpeg downloads, default 1; recommend 2-3
  --info-only                Show all metadata for selected recordings, no download
  --download-video           Download video/audio stream (default: true)
  --no-video                 Skip video download, use with --download-danmaku/cover
  --download-danmaku         Download LRC danmaku files
  --download-all             Download video + danmaku + metadata JSON
  --live-type N              Filter by type: 1=直播, 2=电台, 5=游戏, 6=AI (comma-sep)
  --json                     Output metadata as JSON
  --dry-run                  List selected recordings without downloading
  --until 'YYYY-MM-DD HH:mm:ss'  End time (exclusive), pairs with --since for range
  --latest                   Only download the most recent recording
  --download-cover           Download cover image
  --background               Start a detached download job and return immediately
  --log-file FILE            Background log path (default: job directory)
  --no-log                   Discard background stdout/stderr; status JSON is still saved
  --verbose-ffmpeg           Include ffmpeg progress output (default: compact errors/warnings)
  --timeout-minutes N        Optional total ffmpeg limit; default: no artificial limit
  --help                     Show this help
`);
}

function parseArgs(argv) {
  const out = {
    member: '谭思慧',
    outRoot: DEFAULT_OUT_ROOT,
    memberSource: DEFAULT_MEMBER_SOURCE,
    maxPages: 200,
    concurrency: 1,
    dryRun: false,
    infoOnly: false,
    downloadVideo: true,
    downloadDanmaku: false,
    downloadCover: false,
    latest: false,
    json: false,
    groupId: '0',
    background: false,
    noLog: false,
    verboseFfmpeg: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--info-only') {
      out.infoOnly = true;
    } else if (arg === '--download-video') {
      out.downloadVideo = true;
    } else if (arg === '--no-video' || arg === '--skip-video') {
      out.downloadVideo = false;
    } else if (arg === '--download-danmaku' || arg === '--dl-danmaku') {
      out.downloadDanmaku = true;
    } else if (arg === '--download-all') {
      out.downloadVideo = true;
      out.downloadDanmaku = true;
      out.downloadCover = true;
    } else if (arg === '--download-cover') {
      out.downloadCover = true;
    } else if (arg === '--latest') {
      out.latest = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--background') {
      out.background = true;
    } else if (arg === '--no-log') {
      out.noLog = true;
    } else if (arg === '--verbose-ffmpeg') {
      out.verboseFfmpeg = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      out[key] = val;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  out.maxPages = Number(out.maxPages || 200);
  out.concurrency = Math.max(1, Number(out.concurrency || 1));
  if (!Number.isInteger(out.concurrency)) throw new Error('--concurrency must be an integer');
  if (out.timeoutMinutes != null) {
    out.timeoutMinutes = Number(out.timeoutMinutes);
    if (!Number.isFinite(out.timeoutMinutes) || out.timeoutMinutes <= 0) {
      throw new Error('--timeout-minutes must be a positive number');
    }
  }
  return out;
}

function backgroundChildArgs(argv) {
  const result = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--background' || arg === '--no-log') continue;
    if (arg === '--log-file') {
      i += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

async function mergeJsonFile(file, patch) {
  let current = {};
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {}
  await fsp.writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
}

async function launchBackground(argv, opts) {
  const jobsDir = path.join(path.resolve(opts.outRoot), '.pocket48-replays', 'jobs');
  await fsp.mkdir(jobsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const statusFile = path.join(jobsDir, `${jobId}.json`);
  const logFile = opts.noLog ? null : path.resolve(opts.logFile || path.join(jobsDir, `${jobId}.log`));
  if (logFile) await fsp.mkdir(path.dirname(logFile), { recursive: true });

  await mergeJsonFile(statusFile, {
    jobId,
    state: 'starting',
    pid: null,
    startedAt,
    finishedAt: null,
    logFile,
    statusFile,
    args: backgroundChildArgs(argv),
  });

  let logFd = null;
  try {
    if (logFile) logFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [path.resolve(process.argv[1]), ...backgroundChildArgs(argv)], {
      detached: true,
      stdio: ['ignore', logFile ? logFd : 'ignore', logFile ? logFd : 'ignore'],
      env: {
        ...process.env,
        POCKET48_JOB_STATUS_FILE: statusFile,
        POCKET48_JOB_STARTED_AT: startedAt,
      },
    });
    child.unref();
    // Only patch the PID here. The child owns state transitions, preventing a
    // very fast child from being changed from done/failed back to running.
    await mergeJsonFile(statusFile, { pid: child.pid });
    console.log(`BACKGROUND_STARTED pid=${child.pid}`);
    console.log(`STATUS ${statusFile}`);
    console.log(logFile ? `LOG ${logFile}` : 'LOG disabled');
  } finally {
    if (logFd != null) fs.closeSync(logFd);
  }
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

function pocketHeaders(officialHost = false) {
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': USER_AGENT,
    'Accept-Language': 'zh-Hans-AW;q=1',
    'Origin': 'https://h5.48.cn',
    'Referer': 'https://h5.48.cn/',
    'appInfo': JSON.stringify({
      vendor: 'apple',
      deviceId: crypto.randomUUID(),
      appVersion: '7.0.4',
      appBuild: '23011601',
      osVersion: '16.3.1',
      osType: 'ios',
      deviceName: 'iPhone XR',
      os: 'ios'
    })
  };
  if (officialHost) headers.Host = 'pocketapi.48.cn';
  return headers;
}

let activeApiEndpointIndex = 0;

function conciseApiError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'request timed out';
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 180);
}

async function postJson(endpoint, body) {
  const candidateIndexes = [
    activeApiEndpointIndex,
    ...API_ENDPOINTS.map((_, index) => index).filter(index => index !== activeApiEndpointIndex),
  ];
  const failures = [];

  for (const index of candidateIndexes) {
    const candidate = API_ENDPOINTS[index];
    const url = `${candidate.baseUrl}${endpoint}`;
    try {
      const fetchOptions = {
        method: 'POST',
        headers: pocketHeaders(candidate.officialHost),
        body: JSON.stringify(body),
      };
      if (typeof AbortSignal?.timeout === 'function') {
        fetchOptions.signal = AbortSignal.timeout(20_000);
      }
      const res = await fetch(url, fetchOptions);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      if (!json.success) throw new Error(json.message || `status ${json.status || 'unknown'}`);

      if (index !== activeApiEndpointIndex) {
        console.error(`Pocket48 API fallback: ${candidate.name}`);
        activeApiEndpointIndex = index;
      }
      return json.content;
    } catch (error) {
      failures.push(`${candidate.name}: ${conciseApiError(error)}`);
    }
  }

  throw new Error(`Pocket48 API unavailable after trying all endpoints (${failures.join('; ')})`);
}

async function searchMemberViaApi(member, opts, maxPages = 200) {
  let next = '0';
  for (let page = 1; page <= maxPages; page++) {
    let content;
    try {
      content = await postJson('/getLiveList', { userId: '0', next, debug: true, record: true });
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

  // --- 加载成员映射表（URL 或本地文件）---
  let mapData = {};

  if (/^https?:\/\//.test(opts.memberSource)) {
    const res = await fetch(opts.memberSource);
    if (!res.ok) throw new Error(`Member source HTTP ${res.status}`);
    mapData = await res.json();
  } else {
    try {
      const raw = await fsp.readFile(opts.memberSource, 'utf8');
      mapData = JSON.parse(raw);
    } catch (e) {
      console.log(`Cannot read local member source (${opts.memberSource}), falling back to API...`);
    }
  }

  // --- 归一化为 {name: pocket_id} 字典 ---
  const lookup = {};
  if (mapData && typeof mapData === 'object') {
    if (Array.isArray(mapData)) {
      for (const item of mapData) {
        const name = item.ownerName || item.starName || item.nickname || item.userName;
        if (name) lookup[name] = String(item.userId || item.id);
      }
    } else if (mapData.roomId && Array.isArray(mapData.roomId)) {
      for (const item of mapData.roomId) {
        const name = item.ownerName || item.starName || item.nickname || item.userName;
        if (name) lookup[name] = String(item.userId || item.id);
      }
    } else {
      Object.assign(lookup, Object.fromEntries(Object.entries(mapData).map(([k, v]) => [k, String(v)])));
    }
  }

  // 精确匹配
  if (lookup[opts.member]) {
    console.log(`LOOKUP ${opts.member} -> userId=${lookup[opts.member]} (member map)`);
    return lookup[opts.member];
  }

  // 模糊匹配
  const fuzzy = Object.keys(lookup).find(k => k.includes(opts.member));
  if (fuzzy) {
    console.log(`LOOKUP ${opts.member} -> userId=${lookup[fuzzy]} (fuzzy: ${fuzzy})`);
    return lookup[fuzzy];
  }

  console.log(`SEARCH ${opts.member} via API...`);
  const apiId = await searchMemberViaApi(opts.member, opts);
  if (apiId) {
    console.log(`LOOKUP ${opts.member} -> userId=${apiId} (API search)`);
    return apiId;
  }

  throw new Error(`Cannot resolve member "${opts.member}". Use --user-id to specify the Pocket48 userId directly.`);
}

async function fetchLiveList(userId, sinceMs, untilMs, opts) {
  const selected = [];
  let next = '0';
  const typeSet = opts.liveType ? new Set(opts.liveType.split(',').map(Number)) : null;
  for (let page = 1; page <= opts.maxPages; page++) {
    const body = { userId, next, debug: true, record: true };
    if (opts.groupId !== '0') body.groupId = Number(opts.groupId);
    const content = await postJson('/getLiveList', body);
    const lives = content.liveList || [];
    if (!lives.length) break;
    for (const live of lives) {
      const ctime = Number(live.ctime);
      if (ctime >= sinceMs) {
        if (untilMs && ctime > untilMs) continue;
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
  return postJson('/getLiveOne', { liveId: String(liveId) });
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: opts.stdio || 'inherit' });
    let timer = null;
    let killTimer = null;
    let timedOut = false;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      }, opts.timeout);
    }
    child.on('error', err => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`Timeout: ${bin} exceeded ${opts.timeout}ms`));
      } else {
        code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`));
      }
    });
  });
}

function probeMediaDuration(file, ffprobe) {
  return new Promise(resolve => {
    if (!fs.existsSync(file)) {
      resolve(null);
      return;
    }
    const child = spawn(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      const durationSec = Number.parseFloat(stdout.trim());
      resolve(code === 0 && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null);
    });
  });
}

async function validateMedia(file, expectedDurationSec, ffprobe) {
  const actualDurationSec = await probeMediaDuration(file, ffprobe);
  if (actualDurationSec == null) {
    return { complete: false, actualDurationSec: null, toleranceSec: null };
  }
  if (!(expectedDurationSec > 0)) {
    return { complete: true, actualDurationSec, toleranceSec: null };
  }
  // TS timestamps and playlist rounding can differ slightly. Cap tolerance so a
  // genuinely truncated long recording can never pass merely because it plays.
  const toleranceSec = Math.max(2, Math.min(30, expectedDurationSec * 0.002));
  return {
    complete: actualDurationSec >= expectedDurationSec - toleranceSec,
    actualDurationSec,
    toleranceSec,
  };
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

async function parseM3U8(m3u8Url) {
  const res = await fetch(m3u8Url);
  if (!res.ok) throw new Error(`M3U8 HTTP ${res.status}`);
  const text = await res.text();
  let totalDuration = 0;
  let firstStartTs = null;
  let segmentCount = 0;
  let firstSegmentPath = null;
  for (const line of text.split('\n')) {
    const extinfMatch = line.match(/^#EXTINF:([\d.]+)/);
    if (extinfMatch) {
      totalDuration += parseFloat(extinfMatch[1]);
      segmentCount++;
    }
    if (firstStartTs === null) {
      const tsMatch = line.match(/(\d{13})-(\d{13})\.ts/);
      if (tsMatch) firstStartTs = parseInt(tsMatch[1]);
    }
    if (!line.startsWith('#') && line.trim().endsWith('.ts')) {
      if (!firstSegmentPath) firstSegmentPath = line.trim();
    }
  }
  const seg = firstSegmentPath || '';
  let firstSegmentUrl = null;
  if (firstSegmentPath) {
    if (seg.startsWith('http')) {
      firstSegmentUrl = seg;
    } else if (seg.startsWith('/')) {
      const u = new URL(m3u8Url);
      firstSegmentUrl = u.origin + seg;
    } else {
      const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
      firstSegmentUrl = baseUrl + seg;
    }
  }
  return { totalDurationSec: totalDuration, segmentCount, startTimestamp: firstStartTs, firstSegmentUrl };
}

async function measureDownloadSpeed(firstSegmentUrl, firstSegmentDurationSec) {
  if (!firstSegmentUrl || !firstSegmentDurationSec || firstSegmentDurationSec <= 0) {
    return null;
  }
  const start = Date.now();
  const res = await fetch(firstSegmentUrl, {
    headers: {
      'User-Agent': 'SNH48 ENGINE',
      'Accept': '*/*',
      'Origin': 'https://live.48.cn',
      'Referer': 'https://live.48.cn/',
    },
  });
  if (!res.ok) throw new Error(`Speed test HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const elapsed = (Date.now() - start) / 1000;
  if (elapsed <= 0) return null;
  const bytes = buffer.byteLength;
  const speedBps = bytes / elapsed;
  const speedMbps = (speedBps * 8) / (1024 * 1024);
  const speedFactor = firstSegmentDurationSec / elapsed;
  return { speedFactor, speedMbps, bytes, elapsedMs: Math.round(elapsed * 1000) };
}

function formatDurationPrecise(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '(未知)';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const intS = Math.floor(s);
  const ms = Math.round((s - intS) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(intS).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function buildInfoText(live, detail, opts, { preciseDurationSec, startTimestamp, endTimestamp } = {}) {
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
  const preciseStr = preciseDurationSec ? formatDurationPrecise(preciseDurationSec) : null;

  const lines = [
    '========================================',
    ' 口袋48 录播信息',
    '========================================',
    ` Live ID:     ${live.liveId}`,
    ` 类型:        ${typeLabel}`,
    ` 时间:        ${displayTime(live.ctime)}`,
    ` 时长(API):   ${live.duration || '(未知)'}`,
  ];
  if (preciseStr) {
    lines.push(` 时长(精确):  ${preciseStr}`);
  }
  if (startTimestamp) {
    lines.push(` 开始时间:    ${displayTime(startTimestamp)}`);
  }
  if (endTimestamp) {
    lines.push(` 结束时间:    ${displayTime(endTimestamp)}`);
  }
  lines.push(
    ` 标题:        ${detail?.title || live.title || '(无标题)'}`,
    ` 公告:        ${detail?.announcement || live.announcement || '(无)'}`,
    ` 成员:        ${ui?.nickname || du?.userName || '?'}`,
    ` 真实姓名:    ${ui?.starName || '?'}`,
    ` 等级:        ${ui?.level ?? du?.level ?? '?'}`,
    ` 身份:        ${roleLabel}`,
    ` 粉丝数:      ${ui?.followers ?? '?'}`,
    ` 签名:        ${ui?.signature || '(无)'}`,
    ` 观看人数:    ${live.onlineNum ?? detail?.onlineNum ?? '?'}`,
    ` 播放次数:    ${live.playNum ?? detail?.playNum ?? '?'}`,
    ` 封面尺寸:    ${dims || '(未知)'}`,
    ` liveMode:    ${live.liveMode ?? detail?.liveMode ?? '?'}`,
    ` 连麦中:      ${live.inMicrophoneConnection ?? detail?.inMicrophoneConnection ?? '?'}`,
    ` PK连麦:      ${live.inMicrophonePkConnection ?? '?'}`,
    ` 房间ID:      ${live.roomId ?? detail?.roomId ?? '?'}`,
    ` M3U8:        ${detail?.playStreamPath || '(无)'}`,
    ` 弹幕文件:    ${detail?.msgFilePath || '(无)'}`,
    ` 封面:        ${coverUrl}`,
    '',
  );
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

  // --- 解析 M3U8 + 实测速度 + 参考下载时间 ---
  let preciseDurationSec = null;
  let startTimestamp = null;
  let endTimestamp = null;
  let speedFactor = null;
  const timeoutMs = opts.timeoutMinutes ? Math.ceil(opts.timeoutMinutes * 60_000) : null;

  if (m3u8) {
    try {
      const parsed = await parseM3U8(m3u8);
      preciseDurationSec = parsed.totalDurationSec;
      startTimestamp = parsed.startTimestamp;
      if (startTimestamp != null && preciseDurationSec > 0) {
        endTimestamp = startTimestamp + Math.round(preciseDurationSec * 1000);
      }

      console.log('');
      console.log('='.repeat(60));
      console.log(` Live ID:     ${live.liveId}`);
      console.log(` 类型:        ${LIVE_TYPE_LABELS[live.liveType ?? detail?.liveType] || `未知(${live.liveType ?? detail?.liveType})`}`);
      console.log(` 时间:        ${displayTime(live.ctime)}`);
      console.log(` 时长(API):   ${live.duration || '(未知)'}`);
      console.log(` 时长(精确):  ${formatDurationPrecise(preciseDurationSec)} (${parsed.segmentCount} 个分片)`);
      if (startTimestamp) {
        console.log(` 开始时间:    ${displayTime(startTimestamp)}`);
      }
      if (endTimestamp) {
        console.log(` 结束时间:    ${displayTime(endTimestamp)}`);
      }

      // 实测速度
      if (parsed.firstSegmentUrl && parsed.segmentCount > 0) {
        console.log(` 测速中:     ${parsed.firstSegmentUrl}`);
        const speedInfo = await measureDownloadSpeed(parsed.firstSegmentUrl, preciseDurationSec / parsed.segmentCount);
        if (speedInfo) {
          speedFactor = speedInfo.speedFactor;
          const bwSec = preciseDurationSec / speedFactor;
          const overheadSec = parsed.segmentCount * PER_SEGMENT_OVERHEAD_SEC;
          const estimatedSec = bwSec + overheadSec;
          console.log(` 下载速度:    ${speedInfo.speedMbps.toFixed(1)} Mbps`);
          console.log(` 预估倍速:    ${speedFactor.toFixed(1)}x`);
          console.log(` 分片开销:    ~${Math.ceil(overheadSec / 60)} 分钟 (${parsed.segmentCount}×${PER_SEGMENT_OVERHEAD_SEC}s)`);
          console.log(` 参考预估:    ~${Math.ceil(estimatedSec / 60)} 分钟（仅供参考，不会自动终止下载）`);
        }
      }
      if (!speedFactor) {
        speedFactor = 8;
        const bwSec = preciseDurationSec / speedFactor;
        const overheadSec = parsed.segmentCount * PER_SEGMENT_OVERHEAD_SEC;
        const estimatedSec = bwSec + overheadSec;
        console.log(` 下载速度:    实测失败，使用保守估计 ${speedFactor}x`);
        console.log(` 分片开销:    ~${Math.ceil(overheadSec / 60)} 分钟 (${parsed.segmentCount}×${PER_SEGMENT_OVERHEAD_SEC}s)`);
        console.log(` 参考预估:    ~${Math.ceil(estimatedSec / 60)} 分钟（仅供参考，不会自动终止下载）`);
      }
      console.log(timeoutMs
        ? ` 总时限:      ${opts.timeoutMinutes} 分钟（用户显式设置）`
        : ' 总时限:      不限制（网络停滞仍由 ffmpeg rw_timeout 处理）');
      console.log('='.repeat(60));
      console.log('');
    } catch (e) {
      console.log(`  M3U8 解析失败: ${e.message}`);
      console.log('');
    }
  }

  let outVideo = null;
  let outDanmaku = null;
  let outCover = null;
  let outMeta = null;
  let downloadStartTime = null;

  if (opts.downloadVideo && m3u8) {
    outVideo = path.join(dir, `[口袋48录播]_${nickname}_${title}_${tsTime}_${live.liveId}.ts`);
    const part = `${outVideo}.part`;
    const existingValidation = await validateMedia(outVideo, preciseDurationSec, opts.ffprobe);
    if (existingValidation.complete) {
      console.log(`SKIP VIDEO ${live.liveId} ${outVideo}`);
    } else {
      if (fs.existsSync(outVideo)) {
        const actual = existingValidation.actualDurationSec == null
          ? '无法读取'
          : formatDurationPrecise(existingValidation.actualDurationSec);
        const expected = preciseDurationSec > 0 ? formatDurationPrecise(preciseDurationSec) : '未知';
        console.log(`  INCOMPLETE existing video: actual=${actual}, expected=${expected}; redownloading`);
      }
      console.log(`DOWNLOAD VIDEO ${live.liveId} -> ${outVideo}`);
      downloadStartTime = Date.now();
      try {
        const ffmpegArgs = [
          '-hide_banner', '-nostdin', '-y',
          ...(opts.verboseFfmpeg ? [] : ['-nostats', '-loglevel', 'warning']),
          '-rw_timeout', '300000000',
          '-user_agent', 'SNH48 ENGINE',
          '-i', m3u8,
          '-c', 'copy', '-f', 'mpegts', part,
        ];
        await run(opts.ffmpeg, ffmpegArgs, { timeout: timeoutMs });
      } catch (e) {
        const partSize = fs.existsSync(part) ? fs.statSync(part).size : 0;
        console.error(`  DOWNLOAD FAILED ${live.liveId}: ${e.message}`);
        if (partSize > 0) console.error(`  Incomplete data kept for inspection: ${part} (${partSize} bytes)`);
        throw e;
      }
      const partValidation = await validateMedia(part, preciseDurationSec, opts.ffprobe);
      if (!partValidation.complete) {
        const actual = partValidation.actualDurationSec == null
          ? 'unreadable'
          : `${partValidation.actualDurationSec.toFixed(3)}s`;
        throw new Error(`duration validation failed for ${part}: actual=${actual}, expected=${preciseDurationSec ?? 'unknown'}s`);
      }
      // Preserve an older bad file until a complete replacement has been verified.
      await fsp.rm(outVideo, { force: true });
      await fsp.rename(part, outVideo);
      const downloadElapsed = (Date.now() - downloadStartTime) / 1000;
      if (preciseDurationSec && preciseDurationSec > 0 && downloadElapsed > 0) {
        const actualSpeed = preciseDurationSec / downloadElapsed;
        console.log(`DONE VIDEO ${live.liveId} (实际速度: ${actualSpeed.toFixed(1)}x)`);
      } else {
        console.log(`DONE VIDEO ${live.liveId}`);
      }
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

  if (opts.downloadCover) {
    const coverPath = detail.coverPath || live.coverPath;
    if (coverPath) {
      const coverUrl = `https://source.48.cn${coverPath.startsWith('/') ? '' : '/'}${coverPath}`;
      outCover = path.join(dir, `${tsTime}.jpg`);
      if (fs.existsSync(outCover)) {
        console.log(`SKIP COVER ${live.liveId} ${outCover}`);
      } else {
        console.log(`DOWNLOAD COVER ${coverUrl} -> ${outCover}`);
        try {
          const res = await fetch(coverUrl, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://live.48.cn/' },
          });
          if (!res.ok) throw new Error(`Cover HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          await fsp.writeFile(outCover, Buffer.from(buf));
          console.log(`DONE COVER ${live.liveId}`);
        } catch (e) {
          console.error(`  COVER FAILED: ${e.message}`);
        }
      }
    }
  }

  // 保存 JSON 元数据
  outMeta = path.join(dir, `${tsTime}.json`);
  await fsp.writeFile(outMeta, JSON.stringify({ ...live, _detail: detail, _preciseDurationSec: preciseDurationSec, _startTimestamp: startTimestamp, _endTimestamp: endTimestamp }, null, 2), 'utf8');
  console.log(`META ${live.liveId} -> ${outMeta}`);

  // 保存中文标签信息文件
  const infoTxt = path.join(dir, `${tsTime}.info.txt`);
  await fsp.writeFile(infoTxt, buildInfoText(live, detail, opts, { preciseDurationSec, startTimestamp, endTimestamp }), 'utf8');
  console.log(`INFO ${live.liveId} -> ${infoTxt}`);

  return { liveId: live.liveId, status: 'done', outVideo, outDanmaku, outMeta };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const opts = parseArgs(rawArgs);
  if (opts.help) {
    usage();
    return;
  }
  if (opts.background) {
    await launchBackground(rawArgs, opts);
    return;
  }
  opts.ffmpeg ||= defaultFfmpeg();
  opts.ffprobe ||= defaultFfprobe();

  if (!opts.since) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    opts.since = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgo.getDate()).padStart(2, '0')} 00:00:00`;
  }

  if (opts.json && !opts.downloadDanmaku && opts.downloadVideo === true) {
    opts.infoOnly = true;
  }

  const sinceMs = parseLocalDate(opts.since);
  let untilMs;
  if (opts.until) {
    untilMs = parseLocalDate(opts.until);
    console.log(`UNTIL ${displayTime(untilMs)}`);
  }
  const userId = await resolveUserId(opts);
  console.log(`MEMBER ${opts.member} userId=${userId}`);
  if (opts.groupId && opts.groupId !== '0') {
    const label = GROUP_ID_MAP[opts.groupId] || `未知(${opts.groupId})`;
    console.log(`GROUP ${opts.groupId} (${label})`);
  }
  let lives = await fetchLiveList(userId, sinceMs, untilMs, opts);
  if (opts.latest && lives.length > 0) {
    lives = [lives[lives.length - 1]];
  }
  console.log(`SELECTED ${lives.length}`);

  if (opts.json || opts.infoOnly) {
    for (const live of lives) {
      const typeLabel = LIVE_TYPE_LABELS[live.liveType] || `未知(${live.liveType})`;
      console.log(`--- ${displayTime(live.ctime)} [${typeLabel}] ${live.title || ''} ---`);
      await processOne(live, opts, true);
    }
    if (opts.json) return;
  }

  if (opts.dryRun) {
    // dry-run: 打印精简信息
    for (const live of lives) {
      const typeLabel = LIVE_TYPE_LABELS[live.liveType] || `未知(${live.liveType})`;
      console.log(`${displayTime(live.ctime)} ${live.liveId} [${typeLabel}] ${live.title || ''}`);
    }
    return;
  }

  if (opts.infoOnly) return;

  console.log(`CONCURRENCY ${opts.concurrency}`);
  const results = await mapLimit(lives, opts.concurrency, live => processOne(live, opts, false));
  console.log(`ALL_DONE ${results.length}/${lives.length}`);
}

async function runProgram() {
  const statusFile = process.env.POCKET48_JOB_STATUS_FILE;
  try {
    if (statusFile) {
      await mergeJsonFile(statusFile, {
        state: 'running',
        pid: process.pid,
        startedAt: process.env.POCKET48_JOB_STARTED_AT || new Date().toISOString(),
      });
    }
    await main();
    if (statusFile) {
      await mergeJsonFile(statusFile, {
        state: 'done',
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      });
    }
  } catch (err) {
    if (statusFile) {
      await mergeJsonFile(statusFile, {
        state: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        error: String(err?.message || err).slice(0, 1000),
      });
    }
    usage();
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  }
}

export { parseArgs, validateMedia };

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const invokedPath = fs.realpathSync(path.resolve(process.argv[1]));
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return invokedPath === modulePath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runProgram();
}
