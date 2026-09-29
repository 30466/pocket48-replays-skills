---
name: pocket48-replays
description: Query, inspect, and download Pocket48/口袋48 live & radio recordings, danmaku, and metadata for 48-group members. Defaults to 谭思慧. Supports detached background jobs with compact or disabled logs, --dry-run previews, full metadata, LRC danmaku, live-type filters, and team filters.
---

# Pocket48 Replays

## Overview

This skill provides a script (`scripts/download_pocket48_lives.mjs`) to interact with Pocket48 (口袋48) livestream and radio recordings. It can:

- **Look up any member by name** — fetches a name→userId mapping from `abm48.com` (no auth needed)
- **Query** available recordings for that member with all API metadata
- **Download** video/audio streams as `.ts` files (default behavior)
- **Download** LRC danmaku (弹幕) files
- **Save** full metadata JSON for each recording
- **Filter** by live type (直播/电台/游戏/AI) and team (groupId)

**Defaults:** `--member` defaults to `谭思慧`, `--since` defaults to 7 days ago.

Output root is `/Users/cbj/Documents/48`.

## Prerequisites

- **Node.js 18+** (for native `fetch` support)
- **ffmpeg + ffprobe** (for video download; auto-detected at `/opt/homebrew/bin/`)
- **Network:** The official Pocket48 API requires Pocket48-compatible request headers, including `Referer: https://h5.48.cn/`; missing this header may return HTTP 403 even when the network itself is allowed. The script sends the required headers and falls back to the public `tools.abm48.com` API relay only when the official endpoint is genuinely unavailable. Media, cover, and danmaku files continue to download directly from their CDN URLs.

## Workflow

### Step 0.5: 检查环境

先确认系统环境是否满足运行条件：

**1. Node.js**

```bash
node --version
```

| 结果 | 操作 |
|------|------|
| 输出版本号如 `v18.0.0` | ✅ 继续 |
| `command not found: node` | ❌ 引导安装 |

安装指引：
- **macOS**: `brew install node`
- **Linux**: `apt install nodejs` 或 `dnf install nodejs`
- **Windows**: 从 https://nodejs.org 下载 LTS 版本安装

**2. ffmpeg + ffprobe**

```bash
ffmpeg -version && ffprobe -version
```

| 结果 | 操作 |
|------|------|
| 输出版本号 | ✅ 继续 |
| `command not found` | ❌ 引导安装 |

安装指引：
- **macOS**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg` 或 `sudo dnf install ffmpeg`
- **Windows**: 从 https://ffmpeg.org/download.html 下载 → 解压 → 将 `bin` 目录加入系统 PATH → 重启终端

**3. 网络环境**

脚本会带上 Pocket48 网页端所需的 `Origin` 和 `Referer` 请求头，先直连 Pocket48 官方 API。若官方端点确实不可用，才会回退到 `tools.abm48.com/pocketapi`。两个入口都失败时才需要检查网络或代理配置。

两个环境都确认正常后进入下一步。

## Usage

### Query with full metadata (no download)

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --info-only
```

### Default: download 谭思慧's recent lives/radios

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs
```

### Download video + danmaku

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --download-all
```

### Preview (dry-run)

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --dry-run
```

### Filter by team (CGT48)

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --group-id 21 \
  --info-only
```

### Filter by live type: only radio (电台)

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --live-type 2
```

### Output as JSON

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --json
```

### Download danmaku only

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --download-danmaku
```

### Download a specific day (e.g. June 19 only)

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --since '2026-06-19 00:00:00' \
  --until '2026-06-20 00:00:00'
```

### Download the latest recording only

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --since '2026-06-01 00:00:00' \
  --latest
```

### Download everything (video + danmaku + cover + metadata)

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --download-all
```

## Options

| Option | Description |
|--------|-------------|
| `--member NAME` | Member name, default "谭思慧" |
| `--since 'YYYY-MM-DD HH:mm:ss'` | Start time, default 7 days ago |
| `--user-id ID` | Pocket48 userId (skip auto-lookup) |
| `--group-id N` | Filter by team (10=SNH48, 21=CGT48, 12=GNZ48, etc.) |
| `--out-root DIR` | Output directory |
| `--member-source URL\|FILE` | Member map source, default `https://abm48.com/api/public/snh48/room-map` |
| `--concurrency N` | Parallel **recordings** (not segments), default 1 |
| `--segment-concurrency N` | Parallel **segments within one recording**, default 64; `1` = serial (range 1-128) |
| `--info-only` | Show all metadata fields, no download |
| `--download-video` | Download video/audio stream (default: true) |
| `--no-video` / `--skip-video` | Skip video download; combine with `--download-danmaku` and/or `--download-cover` |
| `--download-danmaku` / `--dl-danmaku` | Download LRC danmaku files |
| `--download-all` | Download video + danmaku + cover + metadata JSON |
| `--download-cover` | Download cover image (`.jpg`) |
| `--live-type N` | Filter: 1=直播, 2=电台, 5=游戏, 6=AI (comma-sep) |
| `--latest` | Only the most recent recording |
| `--json` | Output metadata as JSON |
| `--dry-run` | List without downloading |
| `--max-pages N` | Max API pages, default 200 |
| `--until 'YYYY-MM-DD HH:mm:ss'` | End time (exclusive), pairs with `--since` for range |
| `--background` | Start a detached job and return immediately; recommended for video/audio downloads |
| `--log-file FILE` | Background log path; default is the job directory |
| `--no-log` | Discard background stdout/stderr while still saving status JSON |
| `--verbose-ffmpeg` | Include ffmpeg's detailed progress; default logs are compact |
| `--timeout-minutes N` | Optional hard download limit; there is no artificial timeout by default |

## Member name → userId lookup

The script resolves member names to Pocket48 userIds automatically in this order:

1. **Fetch `https://abm48.com/api/public/snh48/room-map`** — returns `{name: pocket_id}` for all members
2. **Fuzzy match** — if exact name not found, tries substring match
3. **Fallback: brute-force API search** — paginates through all recordings (userId=0) looking for matching nickname
4. **Error** — if all fail, prompts you to use `--user-id`

> **Note:** Step 1 (abm48.com) works globally. Step 2 automatically uses the same official API → `tools.abm48.com/pocketapi` fallback as normal recording queries.

## Metadata fields shown (--info-only)

- **Live ID** — unique identifier
- **类型** — 直播/电台/游戏/AI
- **时间** — recording start time
- **时长** — formatted duration (from API)
- **标题** — short title set by streamer
- **公告** — full announcement/scoring rules (long text)
- **成员** — member nickname
- **真实姓名** — real name (starName)
- **等级** — user level
- **身份** — roles (明星成员/VIP/偶像)
- **粉丝数** — followers count
- **签名** — personal signature
- **观看人数** — onlineNum (viewers)
- **播放次数** — play count
- **状态** — status code
- **封面尺寸** — cover image dimensions
- **liveMode** — 0=正常, 1=录屏
- **连麦中 / PK连麦** — microphone connection status
- **房间ID** — room ID
- **M3U8** — video stream URL
- **弹幕文件** — LRC danmaku URL
- **封面** — cover image URL

## Notes

- `--since` is inclusive
- The script queries `getLiveList`, then `getLiveOne` for details
- Existing valid `.ts` files are skipped via ffprobe validation
- Existing and newly downloaded `.ts` files are checked against the precise M3U8 duration; merely being playable is not enough
- Incomplete `.part` downloads stay marked as partial and are overwritten on re-run
- Metadata JSON is always saved alongside downloads
- Danmaku files are in standard LRC format, one line per danmaku
- `--concurrency 2-3` practical range when downloading multiple recordings at once
- **Download pipeline (single mode)**: parse m3u8 → fetch all segments in parallel → write a local playlist → ffmpeg remuxes locally. ffmpeg never touches the network for video, so the mux step takes seconds.
- `--segment-concurrency` (default **64**, `1` = serial) controls segment parallelism. Measured against the Pocket48 CDN from a Macau/CTM line:

  | Concurrency | Median | Spread (min→max) |
  |---|---|---|
  | 16 | 43 Mbps | 3.6x |
  | 32 | 63 Mbps | 1.7x |
  | **64** | **74 Mbps** | **1.2x** |

  Higher concurrency is both faster *and* far more stable: with more requests in flight, one slow segment no longer stalls the whole download.
- **Whole-recording benchmarks** — these are the reliable numbers. Per-slice micro-benchmarks are misleading because a slice's wall time is set by its single slowest segment:

  | Recording | Segments | Size | Duration | Concurrency | Time | Speed |
  |---|---|---|---|---|---|---|
  | 09-16 | 836 | 1.86 GB | 83:27 | 64 | **123 s** | **42.9x** |
  | 09-19 | 887 | 1.87 GB | 88:31 | 32 | 174 s | 33.2x |
  | 09-18 | 857 | 1.81 GB | 85:36 | 16 | 359 s | 14.3x |

- **Resume**: already-downloaded segments are skipped, so an interrupted run only re-fetches what is missing (measured: 359 s → 11 s).
- **Partial failures never abort the download**: each segment gets up to 5 direct-download attempts. Remaining failures get a lower-concurrency second pass, then are dropped from the playlist with a warning so ffmpeg can still concatenate continuously. ffmpeg itself cannot skip a permanently-failed segment — `-seg_max_retry` only retries, so the skip logic has to live in the script.
- Segment cache lives in `.segments_<liveId>/` next to the output and is deleted only after the remux passes the final duration check; it is kept on failure so a re-run can resume.
- `--group-id` overrides the member filter to team-wide scope (useful for browsing)
- `--member-source` accepts a URL or local JSON file; compatible with both `{name: id}` flat dict and `roomId.json` array format
- Each request uses a random `deviceId` to avoid triggering rate limits
- Official API requests include the Pocket48 H5 `Origin` and `Referer`; omitting the `Referer` can cause HTTP 403
- API requests remember the first working endpoint for the rest of the run, so an unavailable official endpoint is not retried for every page or recording detail

## 长下载的执行规则（避免工具超时和上下文膨胀）

实际下载视频或音频时，默认加 `--background`。脚本会启动一个与当前终端分离的子进程，所以调用它的 AI 工具超时、结束等待或用户继续发消息，不会顺带杀掉下载进程。

```bash
node /Users/cbj/Documents/48/skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --latest \
  --download-all \
  --background
```

启动命令会立即返回三行简短信息：

```text
BACKGROUND_STARTED pid=12345
STATUS /Users/cbj/Documents/48/.pocket48-replays/jobs/<job-id>.json
LOG /Users/cbj/Documents/48/.pocket48-replays/jobs/<job-id>.log
```

- 状态 JSON 很小，包含 `starting`、`running`、`done` 或 `failed`、PID、开始/结束时间及错误摘要。
- 默认把**精简日志**写到文件，不要把完整日志读入对话。需要检查时只读取状态 JSON；失败或结束后最多 `tail -n 30` 日志。
- 完全不需要日志时加 `--no-log`。即使没有日志，状态 JSON 仍会更新。
- 需要指定日志位置时用 `--log-file FILE`。
- 只有用户明确要求逐帧进度时才加 `--verbose-ffmpeg`；否则 ffmpeg 的高频进度行会被抑制。
- `--dry-run`、`--info-only` 这类短任务直接前台运行即可。
- 如果用户要求一直等到完成，轮询状态 JSON（建议 30–60 秒一次），不要持续流式读取日志，也不要让一次工具调用挂住整个下载时长。

### 超时与重试策略

默认**不设人工总时限**，也不根据任何速度估算去杀进程。真正起作用的是三层机制：

| 机制 | 值 | 解决什么 |
|---|---|---|
| **空闲超时** | **15s 无新数据** | 连接卡死 → 取消本次尝试、释放并发槽位 |
| 硬上限 | 60s | 安全网（有空闲超时后几乎不会触发） |
| 重试 | 5 次 × 最多 2 遍 | 全部直连 Pocket48 CDN，瞬时超时和 HTTP/2 流错误也会重试 |
| 收尾并发 | 最多 16 | 避免 64+ 个异常分片同时再次压迫同一 HTTP/2 连接 |
| 第二遍预算 | 180s | 失败分片很多时保证总耗时封顶 |

> **为什么用「空闲超时」而不是「总时长超时」**：总时长超时会误杀「慢但在正常传」的分片，
> 然后从头重下，反而更糟。空闲超时只看“多久没收到新数据”，慢分片只要还在动就不会被杀。
>
> **为什么不能只靠重试次数**：Node 的 `fetch` 默认没有任何超时。连接卡死时它既不报错也不返回，
> 根本不会触发重试，只会永久占着并发槽位。超时本身是可重试的瞬时错误。

#### 重试规则

**除了确定无法恢复的 HTTP 4xx（除 429）和本地文件系统错误，分片传输失败默认都会重试。**
每次尝试都有空闲超时和硬上限，所以重试未识别的瞬时链路错误也不会无限卡住。

| 重试 | 不重试 |
|---|---|
| HTTP 5xx（服务端临时故障） | HTTP 4xx（**含 478 资源已删除**）、404、403 |
| HTTP 429（限流，退避后可能就好） | 本地磁盘/权限错误（ENOSPC / EACCES / EROFS 等） |
| 超时、ECONNRESET、socket hang up |  |
| HTTP/2 流错误（ERR_HTTP2_STREAM_ERROR / NGHTTP2_*） |  |
| DNS 失败及其他传输层错误 |  |

> `478` 是这个 CDN 对「资源不存在」的自定义码。实测依据：30 路并发请求真实分片全部返回 200
> （排除限流），假的路径/目录才返回 478，响应体恒为 46 字节；且单次耗时 1.0~2.0s
> （CDN 要先回源确认），所以重试它既不便宜也没意义。

#### 失败一定会报告

单个分片最终失败不会被静默吞掉，三处可见：

1. **控制台/日志按原因分类汇总**：

   ```
   ⚠ 221/887 个分片最终失败（约 1326 秒内容缺失），已从清单剔除以保证连续拼接
      失败原因: 478 资源已删除 × 215  |  连接超时 × 6
      完整列表: .../2026-09-19~23.12.48.failed-segments.txt
   ```

2. **同目录下的 `*.failed-segments.txt`** — 每行是 `分片名 / 原因 / 底层错误 / URL`，重跑前能查。
3. **时长校验失败时**会明确说明「因为 N 个分片缺失，所以时长对不上」，并提示断点续传只需补下缺失的那几个。

只有用户明确希望设置硬上限时才传：

```bash
--timeout-minutes 120
```

触发硬上限或 ffmpeg 出错时，`.part` 文件不会被改名成正式 `.ts`。任务会标记为失败，避免把截断但可播放的文件误报为成功。

## 下载前展示与完整性保护

在每次下载前，脚本会：

1. **调用 `getLiveOne`** 获取回放详细信息
2. **解析 M3U8** — 获取精确时长（`#EXTINF` 累加）、精确开始/结束时间（首分片 `startTimestamp` + 推算）、分片总数，以及全部分片 URL
3. **开始并行下载分片** — 边下边显示实时进度（已下分片数 / 总字节 / 当前速度 / 剩余时间）。**不做预探测**：预探测会白下几十 MB、还要干等几十秒，而且猜出来的数字并不准；真实吞吐在下载启动后 1 秒内就能算出来
4. **本地封装** — 把所有到手的分片写成本地播放列表，交给 ffmpeg 做纯本地拼接（不走网络，实测 0.2~1 秒）
5. **下载后校验完整时长** — 使用 ffprobe 比较文件实际时长与 M3U8 精确时长，通过后才把 `.part` 改为正式 `.ts`
6. **输出实际速度与耗时**，例如：

   ```
   DONE VIDEO 1310392482355023872 (实际速度: 64.2x)
     本场耗时: 下载 27.2s + 封装 0.4s  |  628 MB  |  下载速率 23.1 MB/s
     本场合计: 00:28  (含获取元数据 / 弹幕 / 封面)
   ```

   多场下载全部结束后还会给出总计：

   ```
   ALL_DONE 7/7
     总计: 7.24 GB  |  耗时 03:24  |  平均 35.7 MB/s
   ```

> 并行下载期间屏幕上只有一行实时进度，不会刷屏。ffmpeg 本地封装的输出默认被收起，只在失败时抖出尾部；遇到分片边界的时间戳重叠 / 损坏包会压缩成一行提示（ffmpeg 自动修正，不影响播放）。

## 下载后保存的文件

每个录播保存到 `{outRoot}/{member}/{时间戳}/` 目录下：

| 文件 | 说明 |
|------|------|
| `*.ts` | 录播视频文件（TS 格式，可直接播放） |
| `*.json` | 原始 API 元数据（JSON 格式，含 `_preciseDurationSec`, `_startTimestamp`, `_endTimestamp`） |
| `*.lrc` | 弹幕文件（LRC 格式，`--download-danmaku` 时生成） |
| `*.jpg` | 封面图片（`--download-cover` 或 `--download-all` 时下载） |
| `*.info.txt` | **中文标签信息文件**（Human-readable，所有字段含中文说明） |
| `*.failed-segments.txt` | 分片下载失败清单（仅在有失败时生成，含原因 / 底层错误 / URL） |
| `.segments_<liveId>/` | 分片缓存目录。封装成功后自动删除；失败时保留，重跑可断点续传 |

 `.info.txt` 文件内容示例：
```
========================================
 口袋48 录播信息
========================================
 Live ID:     1275232997965893632
 类型:        直播
 时间:        2026-06-20 23:20:40
 时长(API):   04:19:11
 时长(精确):  04:19:04.848
 开始时间:    2026-06-20 23:20:41
 结束时间:    2026-06-21 03:39:46
 标题:        𓆝 𓆟
 公告:        1分手写id，3分简评id...
 成员:        CGT48-谭思慧
 真实姓名:    谭思慧
 ...
```
