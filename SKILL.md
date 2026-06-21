---
name: pocket48-replays
description: Query, inspect, and download Pocket48/口袋48 live & radio recordings, danmaku, and metadata for 48-group members. Defaults to 谭思慧. Supports --dry-run to preview, --info-only for full metadata, --download-danmaku for LRC danmaku files, --live-type filter, and --group-id team filter.
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
- **Network:** Only **mainland China IPs** can access Pocket48 API directly. Hong Kong, Macau, Taiwan, and overseas IPs will be blocked (HTTP 403). Switch to a mainland China IP if blocked.

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
| `--concurrency N` | Parallel downloads, default 1 |
| `--info-only` | Show all metadata fields, no download |
| `--download-video` | Download video/audio stream (default: true) |
| `--download-danmaku` / `--dl-danmaku` | Download LRC danmaku files |
| `--download-all` | Download video + danmaku + cover + metadata JSON |
| `--download-cover` | Download cover image (`.jpg`) |
| `--live-type N` | Filter: 1=直播, 2=电台, 5=游戏, 6=AI (comma-sep) |
| `--latest` | Only the most recent recording |
| `--json` | Output metadata as JSON |
| `--dry-run` | List without downloading |
| `--max-pages N` | Max API pages, default 200 |
| `--until 'YYYY-MM-DD HH:mm:ss'` | End time (exclusive), pairs with `--since` for range |

## Member name → userId lookup

The script resolves member names to Pocket48 userIds automatically in this order:

1. **Fetch `https://abm48.com/api/public/snh48/room-map`** — returns `{name: pocket_id}` for all members
2. **Fuzzy match** — if exact name not found, tries substring match
3. **Fallback: brute-force API search** — paginates through all recordings (userId=0) looking for matching nickname
4. **Error** — if all fail, prompts you to use `--user-id`

> **Note:** Step 1 (abm48.com) works globally. Step 2 (Pocket48 live API) requires a mainland China IP.

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
- Incomplete `.part` downloads are overwritten on re-run
- Metadata JSON is always saved alongside downloads
- Danmaku files are in standard LRC format, one line per danmaku
- `--concurrency 2-3` practical range for parallel downloads
- `--group-id` overrides the member filter to team-wide scope (useful for browsing)
- `--member-source` accepts a URL or local JSON file; compatible with both `{name: id}` flat dict and `roomId.json` array format
- Each request uses a random `deviceId` to avoid triggering rate limits

## 下载前展示 & 实测测速 & 超时保护

在每次下载前，脚本会：

1. **调用 `getLiveOne`** 获取回放详细信息
2. **解析 M3U8** — 获取精确时长（`#EXTINF` 累加）、精确开始/结束时间（首分片 `startTimestamp` + 推算）和分片总数
3. **实测下载速度** — 下载第一个 TS 分片，计算 `分片时长 / 实际下载耗时 → 倍速`，并显示 Mbps
4. **估算下载时间** — 基于实测倍速：`精确时长 / speedFactor`，给出建议超时时长（`预估时间 × 1.5` 安全余量）
5. **用计算出的超时调用 ffmpeg** — 如果超时则 SIGTERM kill，并检测 `.part` 是否可播放
6. **下载完后** — 输出实际下载速度（如 `实际速度: 14.2x`）

> **分片开销补偿**：每分片追加 0.1s 的 HTTP 往返预估。2651 个分片≈ +4.4 分钟，使整体估算更贴近实际（单分片测速只反映纯带宽，未计请求/响应/对齐开销）。
>
> 如果测速失败（CDN 限制等），回退到保守 8x 估计 + 分片开销。

## 下载后保存的文件

每个录播保存到 `{outRoot}/{member}/{时间戳}/` 目录下：

| 文件 | 说明 |
|------|------|
| `*.ts` | 录播视频文件（TS 格式，可直接播放） |
| `*.json` | 原始 API 元数据（JSON 格式，含 `_preciseDurationSec`, `_startTimestamp`, `_endTimestamp`） |
| `*.lrc` | 弹幕文件（LRC 格式，`--download-danmaku` 时生成） |
| `*.jpg` | 封面图片（`--download-cover` 或 `--download-all` 时下载） |
| `*.info.txt` | **中文标签信息文件**（Human-readable，所有字段含中文说明） |

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
