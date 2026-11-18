import { useState } from 'react'
import { Volume2 } from 'lucide-react'

const cache = new Map<string, string | null>()
let current: HTMLAudioElement | null = null

export function speakFallback(word: string, accent: 'us' | 'uk'): void {
  try {
    const u = new SpeechSynthesisUtterance(word)
    u.lang = accent === 'uk' ? 'en-GB' : 'en-US'
    u.rate = 0.9
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  } catch {
    /* ignore */
  }
}

export async function playWord(word: string, accent: 'us' | 'uk'): Promise<'tts' | 'system' | 'none'> {
  const key = `${word}|${accent}`
  let url: string | null
  if (cache.has(key)) {
    url = cache.get(key) ?? null
  } else {
    try {
      const res = await window.api.tts.get(word, accent)
      url = res.dataUrl
      cache.set(key, url)
    } catch {
      url = null
      cache.set(key, null)
    }
  }
  if (url) {
    try {
      current?.pause()
      current = new Audio(url)
      await current.play()
      return 'tts'
    } catch {
      /* fall through */
    }
  }
  speakFallback(word, accent)
  return 'system'
}

export function AudioButton({
  word,
  accent = 'us',
  small,
  title,
  label
}: {
  word: string
  accent?: 'us' | 'uk'
  small?: boolean
  title?: string
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={small ? 'btn btn-ghost btn-sm' : 'btn btn-sm'}
      title={title ?? '播放读音（不显示音标）'}
      onClick={async (e) => {
        e.stopPropagation()
        if (busy) return
        setBusy(true)
        try {
          await playWord(word, accent)
        } finally {
          setTimeout(() => setBusy(false), 300)
        }
      }}
      style={{ padding: small ? 4 : undefined }}
    >
      <Volume2 size={small ? 15 : 16} />
      {!small && <span>{label ?? '读音'}</span>}
    </button>
  )
}
