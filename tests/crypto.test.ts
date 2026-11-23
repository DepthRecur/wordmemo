import { Encrypter } from 'age-encryption'
import { describe, expect, it } from 'vitest'
import { SYNC_FORMAT_VERSION } from '../src/shared/sync'
import {
  checkPassphrase,
  decryptEnvelope,
  encryptEnvelope,
  generatePassphrase,
  kdfVerifier,
  makeSalt,
  verifyKdfVerifier
} from '../src/main/sync/crypto'

// S2 的加密边界（PLAN-SYNC §3.5）：age 口令模式 + 密文内的路径绑定 + kdfVerifier。
// 测试里把 scrypt work factor 调到 12，生产默认 18。

const PASS = 'cobalt-tiger-lantern-vivid-otter'
const WORK = 12

function header(path = 'wmsync', kind: 'wmsync' | 'checkpoint' = 'wmsync') {
  return {
    formatVersion: SYNC_FORMAT_VERSION,
    kind,
    path,
    deviceId: '01J00000000000000000000000',
    createdAt: '2026-11-23T19:00:00'
  }
}

describe('age 信封：加解密与路径绑定', () => {
  it('加密后再解密，内容逐字段相等', async () => {
    const payload = { formatVersion: 1, notes: [{ uid: 'n1', title: '第一课' }] }
    const file = await encryptEnvelope(header(), payload, PASS, WORK)
    expect(file.subarray(0, 16).toString('utf8')).toBe('WORDMEMO-SYNC 1\n')

    const envelope = await decryptEnvelope<typeof payload>(file, PASS, {
      kind: 'wmsync',
      path: 'wmsync'
    })
    expect(envelope.header.path).toBe('wmsync')
    expect(envelope.header.deviceId).toBe('01J00000000000000000000000')
    expect(envelope.payload).toEqual(payload)
  })

  it('口令错：明确报「密码不对/文件损坏」，不会解出半个文件', async () => {
    const file = await encryptEnvelope(header(), { ok: true }, PASS, WORK)
    await expect(
      decryptEnvelope(file, 'wrong-passphrase-123', { kind: 'wmsync', path: 'wmsync' })
    ).rejects.toThrow(/密码不对|损坏/)
  })

  it('密文被改一个字节：解不出来', async () => {
    const file = await encryptEnvelope(header(), { ok: true }, PASS, WORK)
    const tampered = Buffer.from(file)
    tampered[tampered.length - 1] ^= 0xff
    await expect(
      decryptEnvelope(tampered, PASS, { kind: 'wmsync', path: 'wmsync' })
    ).rejects.toThrow(/密码不对|损坏/)
  })

  it('路径或类型对不上：拒绝（文件改名/放错位置）', async () => {
    const file = await encryptEnvelope(header('devices/dev1/checkpoint.json.age'), { ok: true }, PASS, WORK)
    await expect(
      decryptEnvelope(file, PASS, { kind: 'wmsync', path: 'wmsync' })
    ).rejects.toThrow(/路径/)
    await expect(
      decryptEnvelope(file, PASS, { kind: 'checkpoint', path: 'devices/dev1/checkpoint.json.age' })
    ).rejects.toThrow(/类型/)
  })

  it('格式版本更大：拒绝并提示升级', async () => {
    const enc = new Encrypter()
    enc.setScryptWorkFactor(WORK)
    enc.setPassphrase(PASS)
    const ciphertext = await enc.encrypt(
      JSON.stringify({
        header: { ...header(), formatVersion: 99 },
        payload: {}
      })
    )
    const file = Buffer.concat([Buffer.from('WORDMEMO-SYNC 1\n', 'utf8'), Buffer.from(ciphertext)])
    await expect(
      decryptEnvelope(file, PASS, { kind: 'wmsync', path: 'wmsync' })
    ).rejects.toThrow(/格式版本/)
  })

  it('不是本应用的文件：直接拒绝', async () => {
    await expect(
      decryptEnvelope(Buffer.from('hello'), PASS, { kind: 'wmsync', path: 'wmsync' })
    ).rejects.toThrow(/不是 WordMemo/)
  })

  it('空口令：加密和解密都拒绝', async () => {
    await expect(encryptEnvelope(header(), {}, '')).rejects.toThrow(/不能为空/)
    const file = await encryptEnvelope(header(), {}, PASS, WORK)
    await expect(
      decryptEnvelope(file, '', { kind: 'wmsync', path: 'wmsync' })
    ).rejects.toThrow(/不能为空/)
  })
})

describe('口令强度与生成', () => {
  it('少于 10 个字符不合格；常见弱口令也不合格', () => {
    expect(checkPassphrase('short')).toMatchObject({ ok: false, reason: 'too_short' })
    expect(checkPassphrase('1234567890')).toMatchObject({ ok: false, reason: 'too_common' })
    expect(checkPassphrase('correct horse battery')).toMatchObject({ ok: true, reason: null })
  })

  it('越长分越高，封顶 4', () => {
    expect(checkPassphrase('abcdefghij').score).toBe(1)
    expect(checkPassphrase('abcdefghijklmn').score).toBe(2)
    expect(checkPassphrase('abcdefghijklmnopqr').score).toBe(3)
    expect(checkPassphrase('abcdefghijklmnopqrstuvwx').score).toBe(4)
  })

  it('生成的口令是 5 个单词、两次不同', () => {
    const first = generatePassphrase()
    expect(first).toMatch(/^[a-z]+(-[a-z]+){4}$/)
    expect(generatePassphrase()).not.toBe(first)
    expect(generatePassphrase(4)).toMatch(/^[a-z]+(-[a-z]+){3}$/)
  })
})

describe('kdfVerifier：输错口令要当场拦住', () => {
  it('同口令同 salt 匹配；换口令/换 salt 都不匹配', () => {
    const salt = makeSalt()
    const verifier = kdfVerifier(PASS, salt)
    expect(verifier).toMatch(/^[0-9a-f]{32}$/)
    expect(verifyKdfVerifier(PASS, salt, verifier)).toBe(true)
    expect(verifyKdfVerifier(PASS + 'x', salt, verifier)).toBe(false)
    expect(verifyKdfVerifier(PASS, makeSalt(), verifier)).toBe(false)
    expect(verifyKdfVerifier(PASS, salt, 'deadbeef')).toBe(false)
  })
})
