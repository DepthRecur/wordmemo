/**
 * 口令强度与生成（主进程和渲染进程共用；只用 Web Crypto，不依赖 Node）。
 * PLAN-SYNC §3.5：至少 10 个字符、弱口令当场拦、给强度条、「帮我生成」= 5 个词。
 */

export interface PassphraseStrength {
  ok: boolean
  /** 0（太弱）到 4（强）；只用于界面强度条 */
  score: 0 | 1 | 2 | 3 | 4
  length: number
  /** 不合格的原因；ok 时为 null */
  reason: 'too_short' | 'too_common' | null
}

/** 常见弱口令：命中就一定不合格（大小写/首尾空格不敏感） */
const COMMON_PASSPHRASES = new Set([
  'password',
  'password1',
  'passw0rd',
  '1234567890',
  '12345678',
  'qwertyuiop',
  'qwerty123',
  'iloveyou',
  'wordmemo',
  'abc123456',
  'woaini1314',
  'a123456789'
])

/** 好记又够长的词表：只用小写、无歧义、容易拼的单词 */
const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'atlas', 'autumn', 'bamboo', 'beacon', 'berry', 'bison',
  'blossom', 'bramble', 'breeze', 'bronze', 'cabin', 'cactus', 'camera', 'canyon', 'cedar', 'chalk',
  'cherry', 'cobalt', 'comet', 'copper', 'coral', 'cotton', 'crane', 'cricket', 'crystal', 'daisy',
  'dawn', 'delta', 'denim', 'diamond', 'dolphin', 'dragon', 'drift', 'eagle', 'ember', 'falcon',
  'feather', 'fern', 'flint', 'forest', 'fox', 'galaxy', 'garden', 'ginger', 'glacier', 'glider',
  'gold', 'granite', 'harbor', 'hazel', 'heron', 'honey', 'horizon', 'island', 'ivory', 'jade',
  'jasper', 'jungle', 'kettle', 'kiwi', 'lagoon', 'lantern', 'lemon', 'lilac', 'linen', 'lotus',
  'lunar', 'maple', 'marble', 'meadow', 'meteor', 'mint', 'mist', 'moon', 'moss', 'nectar',
  'nickel', 'night', 'oak', 'ocean', 'olive', 'onyx', 'opal', 'orbit', 'otter', 'pearl',
  'pebble', 'pepper', 'pine', 'planet', 'plum', 'prairie', 'quartz', 'raven', 'reef', 'river',
  'robin', 'rocket', 'saffron', 'sage', 'sail', 'silver', 'sky', 'slate', 'snow', 'solar',
  'sparrow', 'spice', 'spring', 'star', 'stone', 'storm', 'summit', 'sunset', 'tiger', 'timber',
  'topaz', 'tulip', 'tundra', 'turquoise', 'valley', 'velvet', 'violet', 'walnut', 'willow', 'winter',
  'wolf', 'zephyr'
]

/** 口令强度检查（至少 10 个字符；常见弱口令直接不合格） */
export function checkPassphrase(passphrase: string): PassphraseStrength {
  const length = [...passphrase].length
  const normalized = passphrase.trim().toLowerCase()
  const tooShort = length < 10
  const tooCommon = COMMON_PASSPHRASES.has(normalized)
  const unique = new Set([...normalized]).size

  let score = 0
  if (length >= 10) score++
  if (length >= 14) score++
  if (length >= 18) score++
  if (length >= 24) score++
  if (unique < Math.max(4, Math.floor(length / 3))) score = Math.max(0, score - 1)

  const reason = tooShort ? 'too_short' : tooCommon ? 'too_common' : null
  return {
    ok: !reason,
    score: Math.min(4, Math.max(0, score)) as 0 | 1 | 2 | 3 | 4,
    length,
    reason
  }
}

/** 生成 N 个单词的口令（默认 5 个，约 130 词表 ≈ 35 bit，再叠加 age 的 scrypt） */
export function generatePassphrase(words = 5): string {
  const bytes = new Uint32Array(words)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((value) => WORDS[value % WORDS.length]).join('-')
}
