/**
 * Pure functions for upload validation.
 * No I/O — trivially testable.
 */

// Magic byte signatures → MIME type
const MAGIC = [
  // Images
  { bytes: [0xff, 0xd8, 0xff],                              mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
  { bytes: [0x00, 0x00, 0x01, 0x00],                         mime: 'image/x-icon' },
  { bytes: [0x47, 0x49, 0x46, 0x38],                         mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46],                         mime: 'image/webp', offset: 0, extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  // PDF
  { bytes: [0x25, 0x50, 0x44, 0x46],                         mime: 'application/pdf' },
  // ZIP (also docx, xlsx, etc. — we only allow plain zip)
  { bytes: [0x50, 0x4b, 0x03, 0x04],                         mime: 'application/zip' },
  { bytes: [0x50, 0x4b, 0x05, 0x06],                         mime: 'application/zip' },
  // GZip
  { bytes: [0x1f, 0x8b],                                     mime: 'application/gzip' },
  // MP3
  { bytes: [0x49, 0x44, 0x33],                               mime: 'audio/mpeg' },
  { bytes: [0xff, 0xfb],                                     mime: 'audio/mpeg' },
  { bytes: [0xff, 0xf3],                                     mime: 'audio/mpeg' },
  { bytes: [0xff, 0xf2],                                     mime: 'audio/mpeg' },
  // OGG
  { bytes: [0x4f, 0x67, 0x67, 0x53],                         mime: 'audio/ogg' },
  // WAV
  { bytes: [0x52, 0x49, 0x46, 0x46],                         mime: 'audio/wav', extra: { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] } },
  // MP4
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4,              mime: 'video/mp4' },
  // WebM
  { bytes: [0x1a, 0x45, 0xdf, 0xa3],                         mime: 'video/webm' },
]

// Plain-text extensions we serve as text/plain (no magic check needed)
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'js', 'ts', 'jsx', 'tsx',
  'html', 'css', 'yaml', 'yml', 'toml', 'sh', 'bash', 'py', 'rb',
  'go', 'rs', 'java', 'c', 'cpp', 'h', 'xml', 'svg',
])

// MIME types that browsers / OSes can execute — force Content-Disposition: attachment
const FORCED_DOWNLOAD_MIMES = new Set([
  'application/javascript',
  'application/x-sh',
  'application/octet-stream',
  'application/x-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'text/html',
  'application/xhtml+xml',
])

/**
 * Detect MIME type from the first bytes of a file buffer.
 * Returns the MIME string on success, or throws an Error with code 'UNSUPPORTED_TYPE'.
 *
 * @param {Uint8Array|Buffer} buf   First N bytes (at least 16 recommended)
 * @param {string} filename         Original filename (used for text fallback)
 * @returns {string}                Detected MIME type
 */
export function validateMimeType(buf, filename = '') {
  // 1. Try text extension fallback first so .md, .json, etc. always work
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (TEXT_EXTENSIONS.has(ext)) {
    // Quick sanity: must not start with binary-looking bytes
    const isBinary = Array.from(buf.slice(0, 8)).some(b => b < 0x09 && b !== 0x00)
    if (!isBinary) return 'text/plain'
  }

  // 2. Try SVG (XML text)
  if (ext === 'svg') {
    return 'image/svg+xml'
  }

  // 3. Magic byte scan
  for (const sig of MAGIC) {
    const start = sig.offset ?? 0
    const slice = buf.slice(start, start + sig.bytes.length)
    const match = sig.bytes.every((b, i) => slice[i] === b)
    if (!match) continue

    // Optional extra check (e.g., WEBP vs WAV both start with RIFF)
    if (sig.extra) {
      const extra = buf.slice(sig.extra.offset, sig.extra.offset + sig.extra.bytes.length)
      if (!sig.extra.bytes.every((b, i) => extra[i] === b)) continue
    }

    return sig.mime
  }

  const err = new Error(`Unsupported file type: ${filename}`)
  err.code = 'UNSUPPORTED_TYPE'
  throw err
}

/**
 * Returns true if the MIME type should be served with Content-Disposition: attachment
 * to prevent execution in the browser.
 *
 * @param {string} mime
 * @returns {boolean}
 */
export function isForcedDownload(mime) {
  return FORCED_DOWNLOAD_MIMES.has(mime)
}
