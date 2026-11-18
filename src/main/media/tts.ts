import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getSettings } from '../settings'
import { getDb, localIso } from '../db/connection'
import { normalizeEn } from '@shared/normalize'
import type { TtsResult } from '@shared/types'

const inflight = new Map<string, Promise<TtsResult>>()

function baseDir(): string {
  return process.env.WORDMEMO_DATA_DIR || app.getPath('userData')
}

function ttsDir(): string {
  const dir = path.join(baseDir(), 'media', 'tts')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cacheFile(word: string, accent: string): string {
  const hash = crypto.createHash('sha1').update(`${normalizeEn(word)}|${accent}`).digest('hex')
  return path.join(ttsDir(), `${hash}.mp3`)
}

async function download(url: string, headers: Record<string, string> = {}): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156 Safari/537.36',
        ...headers
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('audio') && !type.includes('mpeg') && !type.includes('octet-stream')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 800) return null
    return buf
  } catch {
    return null
  }
}

async function fromYoudao(word: string, accent: 'us' | 'uk'): Promise<Buffer | null> {
  const type = accent === 'uk' ? 1 : 2
  return download(
    `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`,
    { Referer: 'https://dict.youdao.com/' }
  )
}

async function fromBaidu(word: string): Promise<Buffer | null> {
  return download(
    `https://fanyi.baidu.com/gettts?lan=en&text=${encodeURIComponent(word)}&spd=3&source=web`,
    { Referer: 'https://fanyi.baidu.com/' }
  )
}

async function fromFreeDictionary(word: string, accent: 'us' | 'uk'): Promise<Buffer | null> {
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      { signal: AbortSignal.timeout(12_000) }
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      phonetics?: { audio?: string; text?: string }[]
    }[]
    const audios: string[] = []
    for (const entry of data) {
      for (const ph of entry.phonetics ?? []) {
        if (ph.audio) audios.push(ph.audio)
      }
    }
    if (!audios.length) return null
    const preferred =
      audios.find((a) => (accent === 'uk' ? a.includes('-uk') : a.includes('-us'))) ?? audios[0]
    return download(preferred)
  } catch {
    return null
  }
}

async function fetchFromSource(
  source: string,
  word: string,
  accent: 'us' | 'uk'
): Promise<Buffer | null> {
  if (source === 'youdao') return fromYoudao(word, accent)
  if (source === 'baidu') return fromBaidu(word)
  if (source === 'freedict') return fromFreeDictionary(word, accent)
  return null
}

function toDataUrl(buf: Buffer): string {
  return `data:audio/mpeg;base64,${buf.toString('base64')}`
}

async function doGet(word: string, accent: 'us' | 'uk'): Promise<TtsResult> {
  const clean = word.trim()
  if (!clean) return { dataUrl: null, source: null, cached: false }
  const file = cacheFile(clean, accent)

  if (fs.existsSync(file)) {
    try {
      return { dataUrl: toDataUrl(fs.readFileSync(file)), source: 'cache', cached: true }
    } catch {
      /* ignore */
    }
  }

  const settings = getSettings()
  for (const source of settings.ttsSources) {
    const buf = await fetchFromSource(source, clean, accent)
    if (buf) {
      try {
        fs.writeFileSync(file, buf)
        getDb()
          .prepare(
            `INSERT INTO pronunciations (word_norm, accent, source, rel_path, bytes, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(word_norm, accent, source) DO UPDATE SET fetched_at = excluded.fetched_at`
          )
          .run(normalizeEn(clean), accent, source, path.basename(file), buf.length, localIso())
      } catch {
        /* 缓存写失败不影响播放 */
      }
      return { dataUrl: toDataUrl(buf), source, cached: false }
    }
  }
  return { dataUrl: null, source: null, cached: false }
}

export function getTts(word: string, accent?: 'us' | 'uk'): Promise<TtsResult> {
  const a = accent ?? getSettings().accent
  const key = `${normalizeEn(word)}|${a}`
  const existing = inflight.get(key)
  if (existing) return existing
  const p = doGet(word, a).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

export function ttsCacheSize(): { files: number; bytes: number } {
  try {
    const files = fs.readdirSync(ttsDir()).filter((f) => f.endsWith('.mp3'))
    let bytes = 0
    for (const f of files) {
      try {
        bytes += fs.statSync(path.join(ttsDir(), f)).size
      } catch {
        /* ignore */
      }
    }
    return { files: files.length, bytes }
  } catch {
    return { files: 0, bytes: 0 }
  }
}

export function clearTtsCache(): void {
  try {
    for (const f of fs.readdirSync(ttsDir())) {
      if (f.endsWith('.mp3')) fs.unlinkSync(path.join(ttsDir(), f))
    }
  } catch {
    /* ignore */
  }
}
