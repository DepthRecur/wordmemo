// 读取 .data/secrets.bin（Chromium OSCrypt v10 = AES-256-GCM），用本机 DPAPI 解出的主密钥解密。
// 主密钥由 PowerShell 通过 DSH_MASTER_KEY（hex）传入。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const masterHex = process.env.DSH_MASTER_KEY
if (!masterHex) throw new Error('缺少 DSH_MASTER_KEY')
const dataDir = process.env.WORDMEMO_DATA_DIR || path.resolve(import.meta.dirname, '..', '..', '.data')
const raw = fs.readFileSync(path.join(dataDir, 'secrets.bin'), 'utf8').trim()
const buf = Buffer.from(raw, 'base64')

if (buf.subarray(0, 3).toString() === 'v10') {
  const nonce = buf.subarray(3, 15)
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(15, buf.length - 16)
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(masterHex, 'hex'), nonce)
  d.setAuthTag(tag)
  process.stdout.write(Buffer.concat([d.update(ct), d.final()]).toString('utf8'))
} else {
  process.stdout.write(buf.toString('utf8'))
}
