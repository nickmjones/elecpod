const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const SIZE = 1024
const PADDING = 220
const SRC_VIEWBOX = 256

const phosphorSvg = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', '@phosphor-icons/core', 'assets', 'fill', 'microphone-stage-fill.svg'),
  'utf-8'
)

const innerMatch = phosphorSvg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)
const inner = (innerMatch ? innerMatch[1] : '').replace(/currentColor/g, '#ffffff')

const scale = (SIZE - PADDING * 2) / SRC_VIEWBOX
const tx = PADDING
const ty = PADDING
const corner = SIZE * 0.22

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2DD4BF"/>
      <stop offset="100%" stop-color="#0D9488"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${corner}" ry="${corner}" fill="url(#bg)"/>
  <g transform="translate(${tx}, ${ty}) scale(${scale})">
    ${inner}
  </g>
</svg>
`.trim()

;(async () => {
  const outDir = path.join(__dirname, '..', 'build')
  await fs.promises.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, 'icon.png')
  await sharp(Buffer.from(svg)).png().toFile(outPath)
  console.log(`Wrote ${outPath} (${SIZE}x${SIZE})`)
})().catch(err => {
  console.error(err)
  process.exit(1)
})
