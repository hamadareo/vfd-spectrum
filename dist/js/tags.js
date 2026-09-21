(function (global) {
  'use strict';
  const VFD = (global.VFD = global.VFD || {});

  // Minimal metadata readers (title / artist / album) for MP3 (ID3v1/v2), MP4/M4A (iTunes ilst) and FLAC.
  // Everything is best-effort: any parse problem just yields null and the file name is shown instead.

  const MAX_TAG_BYTES = 8 * 1024 * 1024;

  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const ascii = (b, o, n) => String.fromCharCode.apply(null, Array.from(b.subarray(o, o + n)));
  const stripNul = (s) => s.replace(/\0+$/g, '').replace(/^﻿/, '').trim();

  async function bytes(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  // ---- ID3 -------------------------------------------------------------------------------
  function decodeId3Text(data) {
    if (!data.length) return '';
    const enc = data[0];
    const body = data.subarray(1);
    let text;
    try {
      if (enc === 1) {
        const be = body[0] === 0xfe && body[1] === 0xff;
        text = new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(body);
      } else if (enc === 2) text = new TextDecoder('utf-16be').decode(body);
      else if (enc === 3) text = new TextDecoder('utf-8').decode(body);
      else text = new TextDecoder('windows-1252').decode(body);
    } catch (e) {
      text = '';
    }
    return stripNul(text);
  }

  function readId3v2(buf, ver, flags) {
    const out = {};
    let pos = 0;
    if (flags & 0x40) pos = ver === 4 ? syncsafe(buf, 0) : be32(buf, 0) + 4; // extended header
    const idLen = ver === 2 ? 3 : 4;
    const hdr = ver === 2 ? 6 : 10;
    const want = ver === 2 ? { TT2: 'title', TP1: 'artist', TAL: 'album' } : { TIT2: 'title', TPE1: 'artist', TALB: 'album' };
    while (pos + hdr <= buf.length) {
      if (buf[pos] === 0) break; // padding
      const id = ascii(buf, pos, idLen);
      const size = ver === 2 ? (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5] : ver === 4 ? syncsafe(buf, pos + 4) : be32(buf, pos + 4);
      if (size <= 0 || pos + hdr + size > buf.length) break;
      const key = want[id];
      if (key && !out[key]) out[key] = decodeId3Text(buf.subarray(pos + hdr, pos + hdr + size));
      pos += hdr + size;
    }
    return out;
  }

  async function readMp3(file) {
    const head = await bytes(file, 0, 10);
    if (ascii(head, 0, 3) === 'ID3') {
      const size = syncsafe(head, 6);
      if (size > 0 && size < MAX_TAG_BYTES) {
        const tags = readId3v2(await bytes(file, 10, 10 + size), head[3], head[5]);
        if (tags.title || tags.artist) return tags;
      }
    }
    if (file.size > 128) {
      const t = await bytes(file, file.size - 128, file.size);
      if (ascii(t, 0, 3) === 'TAG') {
        const dec = (o, n) => stripNul(new TextDecoder('windows-1252').decode(t.subarray(o, o + n)));
        return { title: dec(3, 30), artist: dec(33, 30), album: dec(63, 30) };
      }
    }
    return null;
  }

  // ---- MP4 / M4A -------------------------------------------------------------------------
  function* boxes(buf, start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = be32(buf, pos);
      const type = ascii(buf, pos + 4, 4);
      let hdr = 8;
      if (size === 1) {
        size = be32(buf, pos + 12); // low 32 bits of the 64-bit size is enough for tag boxes
        hdr = 16;
      } else if (size === 0) size = end - pos;
      if (size < hdr || pos + size > end) return;
      yield { type, start: pos + hdr, end: pos + size };
      pos += size;
    }
  }

  function readIlst(buf, start, end) {
    const out = {};
    const map = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumArtist' };
    for (const item of boxes(buf, start, end)) {
      const key = map[item.type.replace(/Â/g, '')] || map[item.type];
      if (!key) continue;
      for (const d of boxes(buf, item.start, item.end)) {
        if (d.type === 'data' && d.end - d.start > 8) {
          out[key] = new TextDecoder('utf-8').decode(buf.subarray(d.start + 8, d.end)).trim();
        }
      }
    }
    return out;
  }

  async function readMp4(file) {
    let pos = 0;
    for (let guard = 0; guard < 64 && pos + 8 <= file.size; guard++) {
      const h = await bytes(file, pos, pos + 16);
      let size = be32(h, 0);
      const type = ascii(h, 4, 4);
      if (size === 1) size = be32(h, 12);
      else if (size === 0) size = file.size - pos;
      if (size < 8) return null;
      if (type === 'moov') {
        if (size > MAX_TAG_BYTES) return null;
        const buf = await bytes(file, pos, pos + size);
        for (const udta of boxes(buf, 8, buf.length)) {
          if (udta.type !== 'udta') continue;
          for (const meta of boxes(buf, udta.start, udta.end)) {
            if (meta.type !== 'meta') continue;
            for (const ilst of boxes(buf, meta.start + 4, meta.end)) {
              if (ilst.type === 'ilst') return readIlst(buf, ilst.start, ilst.end);
            }
          }
        }
        return null;
      }
      pos += size;
    }
    return null;
  }

  // ---- FLAC (Vorbis comment block) -------------------------------------------------------
  async function readFlac(file) {
    let pos = 4;
    for (let guard = 0; guard < 64 && pos + 4 <= file.size; guard++) {
      const h = await bytes(file, pos, pos + 4);
      const last = h[0] & 0x80;
      const type = h[0] & 0x7f;
      const len = (h[1] << 16) | (h[2] << 8) | h[3];
      if (type === 4) {
        if (len > MAX_TAG_BYTES) return null;
        const b = await bytes(file, pos + 4, pos + 4 + len);
        const dec = new TextDecoder('utf-8');
        let o = 4 + le32(b, 0);
        const n = le32(b, o);
        o += 4;
        const out = {};
        for (let i = 0; i < n && o + 4 <= b.length; i++) {
          const l = le32(b, o);
          const kv = dec.decode(b.subarray(o + 4, o + 4 + l));
          o += 4 + l;
          const eq = kv.indexOf('=');
          if (eq < 0) continue;
          const k = kv.slice(0, eq).toUpperCase();
          if (k === 'TITLE') out.title = kv.slice(eq + 1);
          else if (k === 'ARTIST') out.artist = kv.slice(eq + 1);
          else if (k === 'ALBUM') out.album = kv.slice(eq + 1);
        }
        return out;
      }
      if (last) break;
      pos += 4 + len;
    }
    return null;
  }

  // Returns { title, artist, album } (any may be empty) or null. Never throws.
  async function readTags(file) {
    try {
      const head = await bytes(file, 0, 12);
      let tags = null;
      if (ascii(head, 4, 4) === 'ftyp') tags = await readMp4(file);
      else if (ascii(head, 0, 4) === 'fLaC') tags = await readFlac(file);
      else if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || /\.mp3$/i.test(file.name)) tags = await readMp3(file);
      if (!tags) return null;
      return { title: tags.title || '', artist: tags.artist || tags.albumArtist || '', album: tags.album || '' };
    } catch (e) {
      return null;
    }
  }

  VFD.readTags = readTags;
})(window);
