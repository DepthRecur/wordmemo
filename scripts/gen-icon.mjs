import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function inRoundedRect(x, y, size, radius) {
  const r = radius
  const cx = Math.max(r, Math.min(size - r, x))
  const cy = Math.max(r, Math.min(size - r, y))
  return Math.hypot(x - cx, y - cy) <= r
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = 4
  const s = size / 256
  const points = [
    [66, 92],
    [96, 168],
    [128, 112],
    [160, 168],
    [190, 92]
  ]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0
      let fg = 0
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples
          const py = y + (sy + 0.5) / samples
          if (inRoundedRect(px, py, size, size * 0.22)) {
            bg++
            const t = (px + py) / (2 * size)
            r += Math.round(91 + (124 - 91) * t)
            g += Math.round(141 + (92 - 141) * t)
            b += Math.round(239 + (252 - 239) * t)
          }
          for (let i = 0; i < points.length - 1; i++) {
            const [x1, y1] = points[i]
            const [x2, y2] = points[i + 1]
            if (distToSegment(px / s, py / s, x1, y1, x2, y2) <= 15) {
              fg++
              break
            }
          }
        }
      }
      const total = samples * samples
      const idx = (y * size + x) * 4
      if (bg === 0) {
        rgba[idx + 3] = 0
        continue
      }
      const alphaBg = bg / total
      const alphaFg = Math.min(1, fg / total)
      const mix = alphaFg
      rgba[idx] = Math.round((r / bg) * (1 - mix) + 255 * mix)
      rgba[idx + 1] = Math.round((g / bg) * (1 - mix) + 255 * mix)
      rgba[idx + 2] = Math.round((b / bg) * (1 - mix) + 255 * mix)
      rgba[idx + 3] = Math.round(255 * alphaBg)
    }
  }
  return encodePng(size, size, rgba)
}

const buildDir = path.resolve('build')
fs.mkdirSync(buildDir, { recursive: true })
const icon = render(256)
const tray = render(32)

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(entry)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

fs.writeFileSync(path.join(buildDir, 'icon.png'), icon)
fs.writeFileSync(path.join(buildDir, 'tray.png'), tray)
fs.writeFileSync(
  path.join(buildDir, 'icon.ico'),
  encodeIco([
    { size: 256, data: icon },
    { size: 32, data: tray }
  ])
)

const ts = `// 由 scripts/gen-icon.mjs 自动生成，请勿手改
export const APP_ICON = 'data:image/png;base64,${icon.toString('base64')}'
export const TRAY_ICON = 'data:image/png;base64,${tray.toString('base64')}'
`
fs.writeFileSync(path.resolve('src/main/icon-data.ts'), ts)
console.log(`icon ${icon.length} bytes, tray ${tray.length} bytes`)
