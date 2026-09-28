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
const DEFAULT_MEMBER_SOURCE = 'https://abm48.com/api/public/snh48/room-map';const USER_AGENT = 'PocketFans201807/6.0.16 (iPhone; iOS 13.5.1; Scale/2.00)';

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
  --concurrency N            Parallel recordings downloaded at once, default 1
  --segment-concurrency N    Parallel segment downloads, default 64 (1 = serial);
                             valid range 1-128
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
    segmentConcurrency: 64,
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
  out.segmentConcurrency = Number(out.segmentConcurrency ?? 64);
  if (!Number.isInteger(out.segmentConcurrency) || out.segmentConcurrency < 1) {
    throw new Error('--segment-concurrency must be an integer >= 1');
  }
  if (out.segmentConcurrency > 128) {
    throw new Error('--segment-concurrency must be <= 128');
  }
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
    // capture=true：把子进程输出收起来。
    // 本地封装这个步骤几乎不会失败，而它刷出的 Non-monotonic DTS /
    // Packet corrupt 之类警告对用户毫无意义（ffmpeg 自己会修正），
    // 所以默认静默；真失败了再把尾部输出抖出来。
    const capture = opts.capture === true;
    const child = spawn(bin, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : (opts.stdio || 'inherit'),
    });
    let captured = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { captured += c; });
      child.stderr.on('data', (c) => { captured += c; });
    }
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
      } else if (code === 0) {
        resolve(captured);
      } else {
        const tail = captured ? `\n${captured.trim().split('\n').slice(-20).join('\n')}` : '';
        reject(new Error(`${bin} exited ${code}${tail}`));
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

// ── 并行分片下载 ─────────────────────────────────────────────────────────────
// ffmpeg 拉 HLS 是严格串行的：一次只请求一个分片，遇到慢分片整个下载就被拖住。
// 实测（澳门直连口袋48 CDN，668MB 整场录播）：
//   ffmpeg 串行          ~4 Mbps   → 约 23 分钟
//   16 路并行分片        ~56 Mbps  → 约 1.6 分钟
//   热缓存（节点已缓存）  ~643 Mbps → 约 9 秒

const SEGMENT_HEADERS = {
  'User-Agent': 'SNH48 ENGINE',
  'Accept': '*/*',
  'Origin': 'https://live.48.cn',
  'Referer': 'https://live.48.cn/',
};

// 单个分片的「空闲超时」：多久收不到新数据就掐掉。
// 注意这不是总时长超时 —— 一个慢但在正常传输的分片不该被误杀。
// 实测正常分片 0.1~2s 内就传完了，冷分片最慢约 10s，15s 无任何数据肯定有问题。
const SEGMENT_IDLE_TIMEOUT_MS = 15_000;

// 单次尝试的硬上限（安全网）。
// 2MB 的分片传 60s 意味着速率低于 35KB/s，与其继续等不如重试。
// 空闲超时生效时这个几乎不会触发。
const SEGMENT_HARD_TIMEOUT_MS = 60_000;

// 单个分片的重试次数（单趟内）
const SEGMENT_RETRIES = 3;

// 第二遍（只重试失败分片）的总时间预算。
// 没有这个预算的话，「连上但不发数据」的坏死分片会拖很久：
//   9 次尝试 × 60s 硬上限 ≈ 9 分钟。
// 加上预算后，最坏情况被钉在「首遍 ≤60s + 重试 ≤180s」≈ 4 分钟。
const RETRY_PASS_BUDGET_MS = 180_000;

function resolveSegmentUrl(m3u8Url, segPath) {
  if (segPath.startsWith('http')) return segPath;
  if (segPath.startsWith('/')) return new URL(m3u8Url).origin + segPath;
  return m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + segPath;
}

// 下载单个分片。已存在且非空的文件直接跳过 → 中断后重跑可断点续传
/**
 * 下载单个分片。
 *
 * 防卡死用「空闲超时」而不是「总时长超时」：
 *   - 总时长超时会误杀「慢但在正常传」的分片，然后从头重下，反而更糟
 *   - 空闲超时只看「多久没收到新数据」，卡死的连接 15s 内就被释放，
 *     而慢速传的分片只要还在动就不会被杀
 *
 * 为什么不能只靠重试次数：Node 的 fetch 默认没有任何超时。
 * 连接卡死时它既不报错也不返回，根本不会触发重试 —— 只会永久占着并发槽位。
 */
async function fetchSegmentWithIdleTimeout(url) {
  const ctrl = new AbortController();
  let idleTimer = setTimeout(() => ctrl.abort(new Error('idle timeout')), SEGMENT_IDLE_TIMEOUT_MS);
  const hardTimer = setTimeout(() => ctrl.abort(new Error('hard timeout')), SEGMENT_HARD_TIMEOUT_MS);
  const bump = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(new Error('idle timeout')), SEGMENT_IDLE_TIMEOUT_MS);
  };
  try {
    const res = await fetch(url, { headers: SEGMENT_HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      total += chunk.length;
      bump();
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  }
}

// 超过这个秒数的失败算「慢失败」（超时 / 连接不通），重试代价高
const SLOW_FAILURE_SEC = 8;

/**
 * 判断一次失败值不值得重试。两条规则：
 *
 * ① 慢失败不重试（tookSec > SLOW_FAILURE_SEC）
 *    连接黑洞 / 连不上：一次要 11~15 秒，重试 6 次就是白等 1.5 分钟。
 *
 * ② 只有白名单里的错误才重试 —— 4xx（含 478）一律跳过。
 *    实测 Pocket48 CDN 对不存在的分片返回 478，响应体恒为 46 字节，
 *    而 30 路并发请求真分片全部 200 —— 所以 478 是「已删除」，不是限流。
 *    而且 478 单次就要 1.0~2.0 秒（CDN 要先回源确认），重试并不便宜。
 */
function isTimeoutFailure(e) {
  const text = `${e?.message || e} ${e?.cause?.message || ''}`;
  return /idle timeout|hard timeout|AbortError|aborted|operation was aborted/i.test(text);
}

/**
 * 只有这些「已知可恢复」的失败才重试；其余一律立刻跳过。
 *
 * 用白名单而不是黑名单的原因：遇到没预料到的错误类型时，
 * 默认行为是「跳过继续」而不是「去重试」，因此绝不会卡在未知情况上。
 */
const RETRYABLE_PATTERNS = [
  /HTTP 5\d\d/,                        // 服务器临时故障
  /HTTP 429/,                          // 被限流，退避后可能就好
  /ECONNRESET|ECONNREFUSED|EPIPE|ERR_STREAM_PREMATURE_CLOSE/i, // 瞬时网络
  /socket hang up|other side closed|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT/i,
  /EAI_AGAIN|getaddrinfo/i,            // DNS 临时失败（ENOTFOUND 是永久的不在列）
];

function shouldRetry(e, tookSec) {
  if (tookSec > SLOW_FAILURE_SEC) return false;   // 慢失败 → 代价高，跳过
  if (isTimeoutFailure(e)) return false;          // 卡死 → 跳过
  const text = `${e?.message || e} ${e?.cause?.message || ''}`;
  return RETRYABLE_PATTERNS.some((re) => re.test(text));
}

async function downloadOneSegment(url, dest, retries = 3) {
  try {
    const st = await fsp.stat(dest);
    if (st.size > 0) return { skipped: true, bytes: 0 };
  } catch {}

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const tmp = `${dest}.tmp`;
    const attemptStart = Date.now();
    try {
      const buf = await fetchSegmentWithIdleTimeout(url);
      if (buf.length === 0) throw new Error('empty body');
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
      return { skipped: false, bytes: buf.length };
    } catch (e) {
      lastErr = e;
      const tookSec = (Date.now() - attemptStart) / 1000;
      await fsp.rm(tmp, { force: true });
      if (!shouldRetry(e, tookSec)) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  const err = new Error(`${url.split('/').pop()}: ${lastErr?.message || 'unknown'}`);
  // undici 把真正的细节（ETIMEDOUT / ECONNRESET 等）藏在 cause 里，
  // 只取 message 会得到无信息的 "fetch failed"，没法归类。
  const cause = lastErr?.cause;
  err.rawMessage = [
    lastErr?.message,
    cause?.code,
    cause?.message,
    typeof cause === 'string' ? cause : null,
  ].filter(Boolean).join(' ') || 'unknown';
  throw err;
}

/**
 * 把底层错误信息归类，便于在看日志时一眼看出「为什么下不下来」。
 */
function classifyFailure(msg) {
  const m = String(msg || '');
  if (/HTTP 478/.test(m)) return '478 资源已删除';
  if (/HTTP 404/.test(m)) return '404 不存在';
  if (/HTTP 403/.test(m)) return '403 无权访问';
  if (/HTTP 412/.test(m)) return '412 请求被拦';
  if (/HTTP 429/.test(m)) return '429 被限流';
  if (/HTTP 4\d\d/.test(m)) return '其他 4xx';
  if (/HTTP 5\d\d/.test(m)) return '5xx 服务端错误';
  if (/idle timeout|hard timeout/i.test(m)) return '超时/卡死（无数据）';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connect timeout/i.test(m)) return '连接超时';
  if (/EHOSTUNREACH|ENETUNREACH|ENETDOWN/i.test(m)) return '网络不可达';
  if (/EAI_AGAIN|getaddrinfo|ENOTFOUND/i.test(m)) return 'DNS 失败';
  if (/ECONNRESET|ECONNREFUSED|socket hang up|other side closed|UND_ERR/i.test(m)) return '连接被重置';
  if (/aborted|AbortError/i.test(m)) return '被中断';
  if (/empty body/i.test(m)) return '空响应';
  return `其他: ${m.slice(0, 50)}`;
}

async function downloadVideoParallel(segments, segDir, concurrency, onProgress) {
  await fsp.mkdir(segDir, { recursive: true });
  const names = segments.map((_, i) => `seg_${String(i).padStart(5, '0')}.ts`);
  let done = 0;
  let bytes = 0;
  let skipped = 0;
  const errors = new Map();   // index -> 底层错误信息

  // 下载单个下标；成功返回 true。任何异常都只记录，不外抛。
  const attempt = async (i, retries) => {
    try {
      const r = await downloadOneSegment(segments[i].url, path.join(segDir, names[i]), retries);
      if (r.skipped) skipped += 1;
      else bytes += r.bytes;
      return true;
    } catch (e) {
      // 记下具体原因，后面按类型汇总 + 写文件，重跑时能知道该不该再试
      const reason = e.rawMessage || e.message || 'unknown';
      errors.set(i, reason);
      return false;
    }
  };

  // ── 第一遍：全部分片并发下载 ──
  const firstPass = new Set();
  await mapLimit(segments.map((_, i) => i), concurrency, async (i) => {
    if (!(await attempt(i, SEGMENT_RETRIES))) firstPass.add(i);
    done += 1;
    if (onProgress) onProgress({ phase: 1, done, total: segments.length, bytes, failed: firstPass.size });
  });

  // ── 第二遍：只重试失败的。此时这些分片大概率已被 CDN 缓存，很快。──
  // 参考 48tools 的做法：绝不因为个别分片失败就中断整个下载。
  // 额外加总时间预算，保证「坏死分片」不会把整个任务拖到无止境。
  const stillFailed = new Set();
  const retryDeadline = Date.now() + RETRY_PASS_BUDGET_MS;
  if (firstPass.size > 0 && onProgress) {
    onProgress({ phase: 2, done: 0, total: firstPass.size, bytes, failed: firstPass.size });
  }
  if (firstPass.size > 0) {
    // 并发度和第一遍一致：坏分片多的时候（比如 25%），
    // 只开 8 路会把重试阶段拖成瓶颈（222 个坏分片需 8 路 × 每片数秒）。
    await mapLimit([...firstPass], concurrency, async (i) => {
      if (Date.now() > retryDeadline) {
        stillFailed.add(i);
        return;
      }
      if (!(await attempt(i, SEGMENT_RETRIES))) stillFailed.add(i);
    });
  }

  // 只把「真正到手」的分片写进清单，保证 ffmpeg 连续拼接不出错
  const usable = [];
  names.forEach((name, i) => {
    if (!stillFailed.has(i)) usable.push({ name, duration: segments[i]?.duration ?? 6 });
  });

  return {
    total: names.length,
    bytes,
    skipped,
    failedIndexes: [...stillFailed].sort((a, b) => a - b),
    failedNames: [...stillFailed].sort((a, b) => a - b).map((i) => names[i]),
    failedReasons: [...stillFailed].sort((a, b) => a - b).map((i) => ({ index: i, name: names[i], reason: errors.get(i) || 'unknown', url: segments[i]?.url })),
    gapDurationSec: [...stillFailed].reduce((a, i) => a + (segments[i]?.duration ?? 0), 0),
    usable,
  };
}

// 生成本地播放列表，让 ffmpeg 只做本地拼接（不走网络，秒级完成）
function writeLocalPlaylist(segDir, entries, playlistPath) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (const e of entries) {
    lines.push(`#EXTINF:${(e.duration ?? 6).toFixed(3)},`);
    lines.push(e.name);
  }
  lines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(playlistPath, `${lines.join('\n')}\n`);
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
  const segments = [];
  let pendingDuration = 6;
  for (const line of text.split('\n')) {
    const extinfMatch = line.match(/^#EXTINF:([\d.]+)/);
    if (extinfMatch) {
      pendingDuration = parseFloat(extinfMatch[1]);
      totalDuration += pendingDuration;
      segmentCount++;
    }
    if (firstStartTs === null) {
      const tsMatch = line.match(/(\d{13})-(\d{13})\.ts/);
      if (tsMatch) firstStartTs = parseInt(tsMatch[1]);
    }
    if (!line.startsWith('#') && line.trim().endsWith('.ts')) {
      const p = line.trim();
      if (!firstSegmentPath) firstSegmentPath = p;
      segments.push({ path: p, duration: pendingDuration });
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
  for (const s of segments) s.url = resolveSegmentUrl(m3u8Url, s.path);
  // 没有 #EXT-X-ENDLIST 说明播放列表还在增长（正在直播）——
  // 这种情况必须交给 ffmpeg 持续跟随，不能把分片列表一次性固定下来。
  const isLive = !/#EXT-X-ENDLIST/.test(text);
  return { totalDurationSec: totalDuration, segmentCount, startTimestamp: firstStartTs, firstSegmentUrl, segments, isLive };
}

function formatDurationShort(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
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
  const recordStartTime = Date.now();
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
  let parsedSegments = null;
  let parsedIsLive = null;
  const timeoutMs = opts.timeoutMinutes ? Math.ceil(opts.timeoutMinutes * 60_000) : null;
  if (m3u8) {
    try {
      const parsed = await parseM3U8(m3u8);
      preciseDurationSec = parsed.totalDurationSec;
      startTimestamp = parsed.startTimestamp;
      parsedSegments = parsed.segments;
      parsedIsLive = parsed.isLive;
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

      // 不再预先探测：探测会白下几十 MB 分片、还要干等几十秒，
      // 而且猜出来的数字不准。真实吞吐在下载开始后 1 秒内就能算出来，
      // 所以直接在下方实时进度里显示「速度 + 剩余时间」。
      console.log(timeoutMs
        ? ` 总时限:      ${opts.timeoutMinutes} 分钟（用户显式设置）`
        : ` 分片策略: 每个分片 ${SEGMENT_IDLE_TIMEOUT_MS / 1000}s 无数据则重试（最多 ${SEGMENT_RETRIES} 次）`
          + `；失败分片第二遍重试，预算 ${RETRY_PASS_BUDGET_MS / 60_000} 分钟，仍失败则剔除并继续`);
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
      if (!Array.isArray(parsedSegments) || parsedSegments.length === 0) {
        throw new Error('M3U8 里没有解析到任何分片，无法下载');
      }
      // 单一模式：并行拉分片 → ffmpeg 本地封装。--segment-concurrency 1 即为串行。
      if (parsedIsLive === true) {
        console.warn('  ⚠ 播放列表没有 #EXT-X-ENDLIST（直播未结束），只能拿到当前已列出的分片');
      }
      console.log(`  分片下载: ${parsedSegments.length} 个分片，并发 ${opts.segmentConcurrency}`);
      let muxSecNum = 0;
      let droppedCount = 0;
      let droppedSec = 0;
      try {
        const segDir = path.join(dir, `.segments_${live.liveId}`);
        const dlStart = Date.now();
        let lastPrint = 0;
        let lastPct = -1;
        const isTTY = process.stdout.isTTY === true;
        const stats = await downloadVideoParallel(
          parsedSegments,
          segDir,
          opts.segmentConcurrency,
          (p) => {
            if (p.phase === 2 && p.done === 0) {
              process.stdout.write('\n  第一遍完成，重试失败分片...\n');
              lastPrint = 0;
              return;
            }
            if (p.phase !== 1) return;
            const now = Date.now();
            const el = (now - dlStart) / 1000;
            const rate = el > 0 ? p.bytes / el : 0;
            const etaSec = p.done > 0 ? (el / p.done) * (p.total - p.done) : null;
            const line = `${p.done}/${p.total} 分片  ${(p.bytes / 1048576).toFixed(1)} MB`
              + `  ${(rate / 1048576).toFixed(1)} MB/s`
              + (etaSec != null ? `  剩余 ~${formatDurationShort(etaSec)}` : '')
              + (p.failed ? `  失败 ${p.failed}` : '');

            if (isTTY) {
              // 终端：原地刷新一行
              if (now - lastPrint < 700 && p.done !== p.total) return;
              lastPrint = now;
              process.stdout.write(`\r  ${line}          `);
            } else {
              // 非终端（后台任务的日志文件）：按 10% 打一行，
              // 否则 \r 会把日志叠成一坨没法看
              const pct = Math.floor((p.done / p.total) * 10) * 10;
              if (pct <= lastPct && p.done !== p.total) return;
              lastPct = pct;
              console.log(`  ${line}`);
            }
          },
        );
        process.stdout.write('\n');
        if (stats.skipped > 0) {
          console.log(`  断点续传: 跳过 ${stats.skipped} 个已下载分片`);
        }
        // 绝不因为个别分片失败就中断：剔除后用剩下的分片继续拼，只告警
        if (stats.failedNames.length > 0) {
          // 按原因分类汇总，并根据原因给建议 —— 不同原因该做的事情完全不同
          const byReason = new Map();
          for (const f of stats.failedReasons) {
            const k = classifyFailure(f.reason);
            byReason.set(k, (byReason.get(k) || 0) + 1);
          }
          const summary = [...byReason.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} × ${v}`)
            .join('  |  ');
          console.warn(
            `  ⚠ ${stats.failedNames.length}/${stats.total} 个分片最终失败`
            + `（约 ${stats.gapDurationSec.toFixed(0)} 秒内容缺失），已从清单剔除以保证连续拼接`,
          );
          console.warn(`    失败原因: ${summary}`);

          // 全量列表写文件，不占屏幕但重跑前能查
          const failFile = path.join(dir, `${tsTime}.failed-segments.txt`);
          const lines = [
            `# ${nickname} / ${title}`,
            `# liveId: ${live.liveId}`,
            `# 失败分片: ${stats.failedNames.length}/${stats.total}，缺失约 ${stats.gapDurationSec.toFixed(0)} 秒`,
            `# 失败原因汇总: ${summary}`,
            '#',
            '# 重跑本场会自动断点续传，只会补下下面这些分片。',
            '# 若原因多为「478 资源已删除」，说明源站确实已没有这段内容，重跑也没用。',
            '',
            ...stats.failedReasons.map((f) =>
              `${f.name}\t${classifyFailure(f.reason)}\t${f.reason.slice(0, 80)}\t${f.url || ''}`),
          ];
          try {
            await fsp.writeFile(failFile, `${lines.join('\n')}\n`, 'utf8');
            console.warn(`    完整列表: ${failFile}`);
          } catch { /* 写不了文件不影响下载 */ }
        }
        if (stats.usable.length === 0) {
          throw new Error('没有任何分片下载成功；分片保留在磁盘，可重跑续传');
        }
        droppedCount = stats.failedNames.length;
        droppedSec = stats.gapDurationSec;
        const playlistPath = path.join(segDir, 'local.m3u8');
        writeLocalPlaylist(segDir, stats.usable, playlistPath);
        const ffmpegArgs = [
          '-hide_banner', '-nostdin', '-y',
          // 注意：流信息（分辨率/编解码）属于 info 级别，warning 级别根本不输出，
          // 所以即使默认模式也用 info 级别 —— 反正输出被 capture 收起来不会刷屏。
          // 用户加了 --verbose-ffmpeg 就不设 loglevel，让它直接流到终端。
          ...(opts.verboseFfmpeg ? [] : ['-loglevel', 'info', '-stats_period', '9999']),
          '-i', playlistPath,
          '-c', 'copy', '-f', 'mpegts', part,
        ];
        const muxStart = Date.now();
        const muxLog = await run(opts.ffmpeg, ffmpegArgs, {
          timeout: timeoutMs,
          capture: !opts.verboseFfmpeg,
        });
        const muxSecNumLocal = (Date.now() - muxStart) / 1000;
        muxSecNum = muxSecNumLocal;
        const muxSec = muxSecNumLocal.toFixed(1);
        console.log(`  本地封装: ${muxSec}s`);
        // ffmpeg 的完整输出里 99% 是「Opening 本地分片」这种噪音（296 行里只有 6 行有用），
        // 所以不在成功时刷屏，但把真正有意义的那几行抽出来：
        //   分辨率 / 编解码器 / 体积构成 / 封装倍速
        if (typeof muxLog === 'string') {
          const vCodec = muxLog.match(/Stream #\d+:\d+.*?Video:\s*(\w+)/);
          const res = muxLog.match(/Stream #\d+:\d+.*?Video:[^\n]*?,\s*(\d{2,5}x\d{2,5})/);
          const aCodec = muxLog.match(/Stream #\d+:\d+.*?Audio:\s*(\w+)/);
          const ov = muxLog.match(/muxing overhead:\s*([\d.]+)%/);
          const sz = muxLog.match(/video:\s*(\d+)KiB audio:\s*(\d+)KiB/);
          const sp = muxLog.match(/speed=\s*([\d.e+]+)x/);
          const bits = [];
          if (vCodec) bits.push(`画面 ${vCodec[1]}${res ? ` ${res[1]}` : ''}`);
          if (aCodec) bits.push(`声音 ${aCodec[1]}`);
          if (sz) bits.push(`视频 ${(Number(sz[1]) / 1024).toFixed(0)}MB + 音频 ${(Number(sz[2]) / 1024).toFixed(0)}MB`);
          if (ov) bits.push(`开销 ${ov[1]}%`);
          if (sp) bits.push(`封装倍速 ${sp[1]}x`);
          if (bits.length > 0) console.log(`  ${bits.join('  |  ')}`);
          if (/Non-monotonic DTS|Packet corrupt|corrupt input/i.test(muxLog)) {
            console.log('  封装提示: 分片边界有少量时间戳重叠 / 损坏包，ffmpeg 已自动修正（不影响播放）');
          }
        }
        await fsp.rm(segDir, { recursive: true, force: true });
      } catch (e) {
        const partSize = fs.existsSync(part) ? fs.statSync(part).size : 0;
        console.error(`  DOWNLOAD FAILED ${live.liveId}: ${e.message}`);
        if (partSize > 0) console.error(`  Incomplete data kept for inspection: ${part} (${partSize} bytes)`);
        throw e;
      }
      const partValidation = await validateMedia(part, preciseDurationSec, opts.ffprobe);
      if (!partValidation.complete) {
        const actual = partValidation.actualDurationSec == null
          ? '无法读取'
          : formatDurationPrecise(partValidation.actualDurationSec);
        const expected = preciseDurationSec > 0 ? formatDurationPrecise(preciseDurationSec) : '未知';
        const missSec = partValidation.actualDurationSec != null && preciseDurationSec > 0
          ? preciseDurationSec - partValidation.actualDurationSec
          : null;
        const hint = droppedCount > 0
          ? `\n   本次有 ${droppedCount} 个分片下载失败被剔除（约 ${Math.round(missSec ?? droppedSec)} 秒内容缺失），`
            + '所以时长对不上。\n   分片已保留在磁盘，重跑可断点续传 —— 只会补下缺失的那几个。'
          : '';
        throw new Error(
          `时长校验失败: 实际 ${actual} vs 预期 ${expected}（容差 ${partValidation.toleranceSec?.toFixed(1) ?? '?'}s）${hint}`,
        );
      }
      // Preserve an older bad file until a complete replacement has been verified.
      await fsp.rm(outVideo, { force: true });
      await fsp.rename(part, outVideo);
      const downloadElapsed = (Date.now() - downloadStartTime) / 1000;
      const speedTag = (preciseDurationSec && preciseDurationSec > 0 && downloadElapsed > 0)
        ? ` (实际速度: ${(preciseDurationSec / downloadElapsed).toFixed(1)}x)`
        : '';
      console.log(`DONE VIDEO ${live.liveId}${speedTag}`);
      // 分阶段耗时。注意 downloadElapsed 是「分片下载 + 本地封装」的总和，
      // 这里把封装单独拆出来，才能真正看出下载有多快。
      const outMB = fs.existsSync(outVideo) ? fs.statSync(outVideo).size / 1048576 : 0;
      console.log(
        `  本场耗时: 下载 ${(downloadElapsed - muxSecNum).toFixed(1)}s`
        + ` + 封装 ${muxSecNum.toFixed(1)}s`
        + `  |  ${outMB.toFixed(0)} MB`
        + (downloadElapsed - muxSecNum > 0 ? `  |  下载速率 ${(outMB / (downloadElapsed - muxSecNum)).toFixed(1)} MB/s` : ''),
      );
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

  const totalSec = (Date.now() - recordStartTime) / 1000;
  const videoBytes = outVideo && fs.existsSync(outVideo) ? fs.statSync(outVideo).size : 0;
  console.log(`  本场合计: ${formatDurationShort(totalSec)}  (含获取元数据 / 弹幕 / 封面)`);

  return {
    liveId: live.liveId,
    status: 'done',
    outVideo,
    outDanmaku,
    outMeta,
    bytes: videoBytes,
    elapsedSec: totalSec,
  };
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
  const runStart = Date.now();
  const results = await mapLimit(lives, opts.concurrency, live => processOne(live, opts, false));
  const runSec = (Date.now() - runStart) / 1000;
  const ok = results.filter(r => r && r.status === 'done');
  const totalBytes = ok.reduce((a, r) => a + (r.bytes || 0), 0);
  console.log(`ALL_DONE ${results.length}/${lives.length}`);
  console.log(
    `  总计: ${(totalBytes / 1073741824).toFixed(2)} GB`
    + `  |  耗时 ${formatDurationShort(runSec)}`
    + (runSec > 0 && totalBytes > 0 ? `  |  平均 ${(totalBytes / 1048576 / runSec).toFixed(1)} MB/s` : ''),
  );
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
    // 只有「参数写错」才值得刷一整屏帮助；运行时错误刷帮助
    // 会把真正的报错淹掉，根本看不清问题在哪
    const msg = String(err?.message || err);
    if (/^(Unknown argument|Missing value|--)/.test(msg)) usage();
    console.error(err.stack || msg);
    process.exitCode = 1;
  }
}

// downloadOneSegment / 超时常量一起导出，方便写测试验证「坏死分片」到底会拖多久
export {
  parseArgs,
  validateMedia,
  downloadOneSegment,
  downloadVideoParallel,
  classifyFailure,
  SEGMENT_IDLE_TIMEOUT_MS,
  SEGMENT_HARD_TIMEOUT_MS,
  SEGMENT_RETRIES,
  RETRY_PASS_BUDGET_MS,
};

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
