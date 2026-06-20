---
name: pocket48-replays
description: Query, inspect, and download Pocket48/口袋48 live & radio recordings, danmaku, and metadata for 48-group members. Defaults to 谭思慧. Supports --dry-run to preview, --info-only for full metadata, --download-danmaku for LRC danmaku files, and --live-type to filter by type (直播/电台/游戏/AI).
---

# Pocket48 Replays

## Overview

This skill provides a script (`scripts/download_pocket48_lives.mjs`) to interact with Pocket48 (口袋48) livestream and radio recordings. It can:

- **Query** available recordings with all API metadata
- **Download** video/audio streams as `.ts` files (default behavior)
- **Download** LRC danmaku (弹幕) files
- **Save** full metadata JSON for each recording
- **Filter** by live type (直播/电台/游戏/AI)

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

### Preview (dry-run) with metadata

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --dry-run
```

### Filter by type: only radio (电台)

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --live-type 2
```

### Filter by type: live + radio

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --live-type 1,2
```

### Output as JSON

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --json
```

### Download with custom time range

```bash
node /Users/cbj/Documents/48/_codex_skills/pocket48-replays/scripts/download_pocket48_lives.mjs \
  --member '谭思慧' \
  --since '2026-06-01 00:00:00' \
  --concurrency 2
```

### Download danmaku only (no video)

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

- Live ID, Type (直播/电台/游戏/AI), Title
- Announcement (公告/计分规则说明)
- Member name, avatar, team
- Start time, end time, creation time
- Watch count (onlineNum), play count (playNum)
- Status, roomId, liveMode
- M3U8 playback URL (playStreamPath)
- LRC danmaku URL (msgFilePath)
- Cover image URL (coverPath)
- In-microphone connection flag

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
