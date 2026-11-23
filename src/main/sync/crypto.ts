import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { Decrypter, Encrypter } from 'age-encryption'
import { SYNC_FORMAT_VERSION, type SyncFileKind } from '@shared/sync'

/**
 * 加密边界（PLAN-SYNC §3.5）：age 口令模式，`.wmsync` 与远端分片都走这一层。
 *
 * 文件 = 明文魔数行 + age 密文；真正的内容（含文件头）全在密文里：
 * `{ header: { formatVersion, kind, path, deviceId, createdAt }, payload }`。
 * 解密后必须校验 `path` 与 `kind` 与预期一致——age 没有 AAD，把路径放进密文里
 * 才能防「把 A 的文件改名成 B 再喂给你」。
 */

/** 文件魔数：只用来快速判断「这是不是我们的文件」，不承担任何安全职责 */
const MAGIC = 'WORDMEMO-SYNC 1\n'

/** age 口令模式的 scrypt work factor（默认 18，约 1 秒；测试里用 12 加速） */
export const DEFAULT_SCRYPT_WORK_FACTOR = 18

export interface SyncFileHeader {
  formatVersion: number
  kind: SyncFileKind
  /** 分片在远端仓库里的路径；用户导出/导入的 `.wmsync` 用 `wmsync` */
  path: string
  deviceId: string
  createdAt: string
}

export interface SyncEnvelope<T> {
  header: SyncFileHeader
  payload: T
}

/** 口令加密一个信封；返回值可直接写盘/上传 */
export async function encryptEnvelope<T>(
  header: SyncFileHeader,
  payload: T,
  passphrase: string,
  workFactor: number = DEFAULT_SCRYPT_WORK_FACTOR
): Promise<Buffer> {
  if (!passphrase) throw new Error('同步密码不能为空')
  if (header.formatVersion !== SYNC_FORMAT_VERSION) {
    throw new Error(`同步格式版本 ${header.formatVersion} 与本机（${SYNC_FORMAT_VERSION}）不一致`)
  }
  const enc = new Encrypter()
  enc.setScryptWorkFactor(workFactor)
  enc.setPassphrase(passphrase)
  const plaintext = JSON.stringify({ header, payload })
  const ciphertext = await enc.encrypt(plaintext)
  return Buffer.concat([Buffer.from(MAGIC, 'utf8'), Buffer.from(ciphertext)])
}

/** 解密并校验文件头；口令错、文件损坏、路径/类型不对都会抛错（文案面向用户） */
export async function decryptEnvelope<T>(
  file: Buffer | Uint8Array,
  passphrase: string,
  expected: { kind: SyncFileKind; path: string }
): Promise<SyncEnvelope<T>> {
  if (!passphrase) throw new Error('同步密码不能为空')
  const buf = Buffer.isBuffer(file) ? file : Buffer.from(file)
  const magic = buf.subarray(0, MAGIC.length).toString('utf8')
  if (magic !== MAGIC) throw new Error('这不是 WordMemo 的同步文件')
  const ciphertext = new Uint8Array(buf.subarray(MAGIC.length))
  const dec = new Decrypter()
  dec.addPassphrase(passphrase)
  let text: string
  try {
    text = await dec.decrypt(ciphertext, 'text')
  } catch {
    // age 不区分「口令错」与「密文被改」：都解不出来
    throw new Error('同步密码不对，或者文件已经损坏')
  }
  let envelope: SyncEnvelope<T>
  try {
    envelope = JSON.parse(text) as SyncEnvelope<T>
  } catch {
    throw new Error('同步文件内容损坏')
  }
  const header = envelope?.header
  if (!header || typeof header !== 'object') throw new Error('同步文件内容损坏')
  if (header.formatVersion !== SYNC_FORMAT_VERSION) {
    throw new Error(
      `同步文件格式版本 ${header.formatVersion} 与本机（${SYNC_FORMAT_VERSION}）不一致，请升级 WordMemo 后再试`
    )
  }
  if (header.kind !== expected.kind) {
    throw new Error('同步文件的类型不对（可能放错了文件）')
  }
  if (header.path !== expected.path) {
    throw new Error('同步文件的路径与预期不一致（可能被改过名或来自别的设备）')
  }
  return envelope
}

/* ------------------------------------------------------------------ */
/* 口令强度与 KDF 校验                                                  */
/* ------------------------------------------------------------------ */

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

export interface PassphraseStrength {
  ok: boolean
  /** 0（太弱）到 4（强）；只用于界面强度条 */
  score: 0 | 1 | 2 | 3 | 4
  length: number
  /** 不合格的原因；ok 时为 null */
  reason: 'too_short' | 'too_common' | null
}

/** 口令强度检查（PLAN-SYNC §3.5：至少 10 个字符，弱口令当场拦） */
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

/**
 * 生成 5 个单词的口令（如 `cobalt-tiger-lantern-vivid-...`）。
 * 5 个词 × 约 130 词 ≈ 35 bit，再叠加 age 的 scrypt（work factor 18）足够挡住离线爆破。
 */
export function generatePassphrase(words = 5): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDS[randomInt(0, WORDS.length)])
  return out.join('-')
}

/** `meta.json` 里的 salt（16 字节 hex） */
export function makeSalt(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 口令校验值（PLAN-SYNC §3.5 的 `kdfVerifier`）：scrypt 派生的前 16 字节。
 * 目的是「输错口令时立刻报错」，而不是当成新仓库默默建一个空库。
 */
export function kdfVerifier(passphrase: string, salt: string): string {
  const derived = scryptSync(passphrase, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
  })
  return derived.subarray(0, 16).toString('hex')
}

/** 常量时间比较，避免按字节泄露「前几位对了」 */
export function verifyKdfVerifier(
  passphrase: string,
  salt: string,
  expectedHex: string
): boolean {
  const actual = Buffer.from(kdfVerifier(passphrase, salt), 'hex')
  const expected = Buffer.from(String(expectedHex ?? ''), 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
