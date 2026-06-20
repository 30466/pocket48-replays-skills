---
name: pocket48-replays
description: Query, inspect, and download Pocket48/口袋48 live & radio recordings, danmaku, and metadata for 48-group members. Defaults to 谭思慧. Supports --dry-run to preview, --info-only for full metadata, --download-danmaku for LRC danmaku files, --live-type filter, --group-id team filter, and --proxy for API proxy.
---

# Pocket48 Replays

## Overview

This skill provides a script (`scripts/download_pocket48_lives.mjs`) to interact with Pocket48 (口袋48) livestream and radio recordings. It can:

- **Query** available recordings with all API metadata
- **Download** video/audio streams as `.ts` files (default behavior)
- **Download** LRC danmaku (弹幕) files
- **Save** full metadata JSON for each recording
- **Filter** by live type (直播/电台/游戏/AI) and team (groupId)

**Defaults:** `--member` defaults to `谭思慧`, `--since` defaults to 7 days ago.

Output root is `/Users/cbj/Documents/48`.

## Usage

### Query with full metadata (no download)

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --info-only
```

### Default: download 谭思慧's recent lives/radios

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs
```

### Download video + danmaku

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --download-all
```

### Preview (dry-run)

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --dry-run
```

### Filter by team (CGT48)

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --group-id 21 \
  --info-only
```

### Filter by live type: only radio (电台)

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --live-type 2
```

### Output as JSON

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --json
```

### Use msg48.org as proxy

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --proxy https://msg48.org/api/live
```

### Download danmaku only

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --download-danmaku
```

## Options

| Option | Description |
|--------|-------------|
| `--member NAME` | Member name, default "谭思慧" |
| `--since 'YYYY-MM-DD HH:mm:ss'` | Start time, default 7 days ago |
| `--user-id ID` | Pocket48 userId (skip auto-lookup) |
| `--group-id N` | Filter by team (10=SNH48, 21=CGT48, 12=GNZ48, etc.) |
| `--proxy URL` | Use API proxy to avoid rate limiting (e.g. `https://msg48.org/api/live`) |
| `--out-root DIR` | Output directory |
| `--concurrency N` | Parallel downloads, default 1 |
| `--info-only` | Show all metadata fields, no download |
| `--download-video` | Download video/audio stream (default: true) |
| `--download-danmaku` / `--dl-danmaku` | Download LRC danmaku files |
| `--download-all` | Download video + danmaku + metadata JSON |
| `--live-type N` | Filter: 1=直播, 2=电台, 5=游戏, 6=AI (comma-sep) |
| `--json` | Output metadata as JSON |
| `--dry-run` | List without downloading |
| `--max-pages N` | Max API pages, default 20 |

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

## Built-in member lookup

The script has a built-in table (`KNOWN_MEMBERS`). To add members, edit the map in the script.

## Notes

- `--since` is inclusive
- The script queries `getLiveList`, then `getLiveOne` for details
- Existing valid `.ts` files are skipped via ffprobe validation
- Incomplete `.part` downloads are overwritten on re-run
- Metadata JSON is always saved alongside downloads
- Danmaku files are in standard LRC format, one line per danmaku
- `--concurrency 2-3` practical range for parallel downloads
- `--group-id` overrides the member filter to team-wide scope (useful for browsing)
- `--proxy` switches API calls to a proxy endpoint (e.g. msg48.org) to bypass rate limits
