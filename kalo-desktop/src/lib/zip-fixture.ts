/**
 * Test helper: build a ZIP archive in memory, store-only (method 0).
 *
 * The preview's reader supports both store and deflate; store is what the
 * tests use so they do not depend on `CompressionStream("deflate-raw")`, which
 * is not available on every Node version this suite runs under. The deflate
 * path is exercised by the app itself, where Word and Excel always deflate.
 */

/** CRC-32 (IEEE 802.3), needed because real readers may check it. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, content]) => ({
    nameBytes: encoder.encode(name),
    data: encoder.encode(content),
  }));

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const header = new Uint8Array(30 + entry.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x800, true); // flags: UTF-8 names
    view.setUint16(8, 0, true); // method: store
    view.setUint32(14, crc32(entry.data), true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, entry.nameBytes.length, true);
    header.set(entry.nameBytes, 30);
    localParts.push(header, entry.data);

    const central = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc32(entry.data), true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(entry.nameBytes, 46);
    centralParts.push(central);

    offset += header.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...localParts, ...centralParts, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
