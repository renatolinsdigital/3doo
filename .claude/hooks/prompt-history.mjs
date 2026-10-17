#!/usr/bin/env node
// Copies every prompt the user sends into prompt_history.docx at the project
// root: its text, the images pasted with it, and the date and time it was sent.
// Referenced from .claude/settings.json (UserPromptSubmit, Stop, SessionEnd);
// Claude Code only runs it because that file points at this exact path. The
// rule that explains it to an assistant is .claude/rules/prompt-history.md.
//
// A run reads the session transcript rather than the hook payload, because the
// payload carries the text of a prompt but not its images. It appends every
// human prompt the document lacks, so a run that could not write (Word holding
// the file open) is made good by the next one. Each entry carries a hidden
// bookmark keyed on its timestamp: that is how a run tells what is already
// there, and a bookmark survives the user editing and saving the file in Word.
//
//   node .claude/hooks/prompt-history.mjs --dump [--last N]
//
// prints the history as text and saves its images to a temp folder, since an
// assistant cannot read a .docx directly.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCX = path.join(ROOT, 'prompt_history.docx');
// The lock and the retry list live outside the project, so the document is the
// only thing the hook ever leaves in the root.
const STATE = path.join(
  os.tmpdir(),
  `prompt-history-${crypto.createHash('sha1').update(ROOT.toLowerCase()).digest('hex').slice(0, 12)}`,
);
const LOCK = `${STATE}.lock`;
const PENDING = `${STATE}.pending.json`;

const EMU_PER_PX = 9525;
const MAX_WIDTH = 6_000_000;
const MAX_HEIGHT = 8_200_000;

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  types: 'http://schemas.openxmlformats.org/package/2006/content-types',
};
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const STYLES =
  `${XML_HEAD}<w:styles xmlns:w="${NS.w}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
  '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/>' +
  '<w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="BFBFBF"/></w:pBdr>' +
  '<w:spacing w:before="360" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr>' +
  '<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>' +
  '</w:styles>';

function runHook() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    // No payload: still flush whatever an earlier run left pending.
  }
  try {
    withLock(() => {
      const transcripts = [...new Set([input.transcript_path, ...readPending()].filter(Boolean))];
      try {
        append(transcripts.filter((file) => fs.existsSync(file)).flatMap(readPrompts));
        savePending([]);
      } catch (err) {
        savePending(transcripts);
        throw err;
      }
    });
  } catch (err) {
    // Exit code 2 from UserPromptSubmit would throw the user's prompt away, so a
    // failure only warns and the next run catches up.
    const busy = err.code === 'EBUSY' || err.code === 'EPERM';
    const why = busy ? 'it is open in another program, probably Word' : err.message;
    process.stdout.write(
      JSON.stringify({
        systemMessage: `prompt_history.docx was not updated: ${why}. The next prompt catches it up.`,
      }),
    );
  }
}

function withLock(fn) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(LOCK, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 30_000) fs.rmSync(LOCK, { force: true });
      else if (Date.now() > deadline) throw new Error('another run kept it locked');
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

function readPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING, 'utf8'));
  } catch {
    return [];
  }
}

function savePending(transcripts) {
  if (transcripts.length) fs.writeFileSync(PENDING, JSON.stringify(transcripts));
  else fs.rmSync(PENDING, { force: true });
}

function readPrompts(transcript) {
  const prompts = [];
  for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.includes('"human"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Tool results, skill bodies, reminders and command output are user turns
    // too; only what a person typed carries origin.kind "human".
    if (entry.type !== 'user' || entry.origin?.kind !== 'human') continue;
    if (entry.isMeta || entry.isSidechain) continue;
    const content = entry.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => cleanText(block.text))
      .filter(Boolean)
      .join('\n\n');
    const images = blocks
      .filter((block) => block.type === 'image' && block.source?.type === 'base64')
      .map((block) => ({
        type: block.source.media_type,
        data: Buffer.from(block.source.data, 'base64'),
      }));
    if (!text && !images.length) continue;
    prompts.push({
      key: crypto.createHash('sha1').update(entry.timestamp).digest('hex').slice(0, 32),
      time: new Date(entry.timestamp),
      session: entry.sessionId ?? '',
      text,
      images,
    });
  }
  return prompts;
}

// The editor wraps the open file and the selection round what the user typed;
// a slash command arrives as tags. Neither is the prompt as the user wrote it.
function cleanText(text) {
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (command) {
    const commandArgs = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '';
    return `${command[1].trim()} ${commandArgs.trim()}`.trim();
  }
  return text
    .replace(/<(ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/\1>/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function append(prompts) {
  const zip = fs.existsSync(DOCX) ? readZip(fs.readFileSync(DOCX)) : blankDocument();
  let doc = readText(zip, 'word/document.xml');
  const have = new Set([...doc.matchAll(/w:name="_p([0-9a-f]{32})"/g)].map((match) => match[1]));
  const fresh = [
    ...new Map(prompts.filter((p) => !have.has(p.key)).map((p) => [p.key, p])).values(),
  ].sort((a, b) => a.time - b.time);
  if (!fresh.length) return;

  const heading = headingStyle(readText(zip, 'word/styles.xml'));
  let rels = readText(zip, 'word/_rels/document.xml.rels');
  let types = readText(zip, '[Content_Types].xml');
  let rel = highest(rels, /\bId="rId(\d+)"/g);
  let drawingId = highest(doc, /<wp:docPr\b[^>]*?\bid="(\d+)"/g);
  // Bookmarks, comments and revisions share one id space in a Word document.
  let mark = highest(doc, /\bw:id="(\d+)"/g);

  let body = '';
  for (const prompt of fresh) {
    mark += 1;
    body +=
      `<w:p><w:pPr><w:pStyle w:val="${heading}"/></w:pPr>` +
      `<w:bookmarkStart w:id="${mark}" w:name="_p${prompt.key}"/>` +
      `<w:r><w:t>${formatTime(prompt.time)}</w:t></w:r><w:bookmarkEnd w:id="${mark}"/></w:p>` +
      '<w:p><w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr>' +
      `<w:t>session ${escapeXml(prompt.session)}</w:t></w:r></w:p>`;
    if (prompt.text) body += `<w:p><w:r>${textRuns(prompt.text)}</w:r></w:p>`;
    prompt.images.forEach((image, i) => {
      const ext = image.type.split('/')[1];
      const name = `p${prompt.key}_${i + 1}.${ext}`;
      rel += 1;
      drawingId += 1;
      putEntry(zip, `word/media/${name}`, image.data, false);
      rels = rels.replace(
        '</Relationships>',
        `<Relationship Id="rId${rel}" Type="${NS.r}/image" Target="media/${name}"/></Relationships>`,
      );
      if (!new RegExp(`Extension="${ext}"`, 'i').test(types)) {
        types = types.replace(
          '</Types>',
          `<Default Extension="${ext}" ContentType="${image.type}"/></Types>`,
        );
      }
      const size = imageSize(image.data) ?? { width: 800, height: 600 };
      body += drawing(`rId${rel}`, drawingId, name, size);
    });
  }

  const sectPr = doc.lastIndexOf('<w:sectPr');
  const at = sectPr === -1 ? doc.lastIndexOf('</w:body>') : sectPr;
  doc = doc.slice(0, at) + body + doc.slice(at);
  putEntry(zip, 'word/document.xml', doc);
  putEntry(zip, 'word/_rels/document.xml.rels', rels);
  putEntry(zip, '[Content_Types].xml', types);

  // Written beside the document and renamed over it, so a run that dies half
  // way never leaves a broken file behind.
  const tmp = `${DOCX}.tmp`;
  try {
    fs.writeFileSync(tmp, writeZip(zip));
    fs.renameSync(tmp, DOCX);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Word saves styles under ids in its own language (Ttulo2 in Portuguese), so
// the heading style is found by its built-in name rather than assumed.
function headingStyle(styles) {
  for (const [, id, inner] of styles.matchAll(
    /<w:style\b[^>]*?\bw:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g,
  )) {
    if (/<w:name w:val="heading 2"\/>/i.test(inner)) return id;
  }
  return 'Heading2';
}

function blankDocument() {
  const zip = new Map();
  putEntry(
    zip,
    '[Content_Types].xml',
    `${XML_HEAD}<Types xmlns="${NS.types}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
  );
  putEntry(
    zip,
    '_rels/.rels',
    `${XML_HEAD}<Relationships xmlns="${NS.rels}">` +
      `<Relationship Id="rId1" Type="${NS.r}/officeDocument" Target="word/document.xml"/>` +
      '</Relationships>',
  );
  putEntry(
    zip,
    'word/document.xml',
    `${XML_HEAD}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:body>` +
      '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Prompt history</w:t></w:r></w:p>' +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
      '</w:sectPr></w:body></w:document>',
  );
  putEntry(
    zip,
    'word/_rels/document.xml.rels',
    `${XML_HEAD}<Relationships xmlns="${NS.rels}">` +
      `<Relationship Id="rId1" Type="${NS.r}/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  putEntry(zip, 'word/styles.xml', STYLES);
  return zip;
}

function drawing(rel, id, name, { width, height }) {
  const scale = Math.min(1, MAX_WIDTH / (width * EMU_PER_PX), MAX_HEIGHT / (height * EMU_PER_PX));
  const cx = Math.round(width * EMU_PER_PX * scale);
  const cy = Math.round(height * EMU_PER_PX * scale);
  // The drawing namespaces are declared inline: a document Word has re-saved
  // is not guaranteed to declare them on its root.
  return (
    `<w:p><w:r><w:drawing><wp:inline xmlns:wp="${NS.wp}" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${name}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${NS.a}"><a:graphicData uri="${NS.pic}"><pic:pic xmlns:pic="${NS.pic}">` +
    `<pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

function imageSize(buf) {
  const size = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  try {
    if (buf.readUInt32BE(0) === 0x89504e47) return size(buf.readUInt32BE(16), buf.readUInt32BE(20));
    if (buf.toString('ascii', 0, 3) === 'GIF') return size(buf.readUInt16LE(6), buf.readUInt16LE(8));
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return size(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      if (chunk === 'VP8 ') {
        return size(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let at = 2; at + 9 < buf.length && buf[at] === 0xff; ) {
        const marker = buf[at + 1];
        if (marker === 0xff) {
          at += 1;
        } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return size(buf.readUInt16BE(at + 7), buf.readUInt16BE(at + 5));
        } else {
          at += 2 + buf.readUInt16BE(at + 2);
        }
      }
    }
  } catch {
    // A truncated header falls through to the default size.
  }
  return null;
}

function dump(last) {
  if (!fs.existsSync(DOCX)) {
    console.log(`No prompt history yet: ${DOCX} does not exist.`);
    return;
  }
  const zip = readZip(fs.readFileSync(DOCX));
  const targets = new Map();
  for (const [tag] of readText(zip, 'word/_rels/document.xml.rels').matchAll(
    /<Relationship\b[^>]*>/g,
  )) {
    targets.set(tag.match(/\bId="([^"]*)"/)?.[1], tag.match(/\bTarget="([^"]*)"/)?.[1]);
  }

  // One entry per bookmarked heading, read back from the XML so edits made in
  // Word show. The bookmark marks an entry; a style id would not survive Word.
  const prompts = [];
  for (const [, inner] of readText(zip, 'word/document.xml').matchAll(
    /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g,
  )) {
    let line = '';
    for (const [, text, mark, embed] of inner.matchAll(
      /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\/>|r:embed="([^"]*)"/g,
    )) {
      if (text !== undefined) line += unescapeXml(text);
      else if (mark) line += mark === 'tab' ? '\t' : '\n';
      else line += `\0${embed}\0`;
    }
    if (/w:name="_p[0-9a-f]{32}"/.test(inner)) prompts.push([`## ${line}`]);
    else prompts.at(-1)?.push(line);
  }

  const folder = `${STATE}-images`;
  fs.mkdirSync(folder, { recursive: true });
  const saveImage = (rel) => {
    const target = targets.get(rel) ?? '';
    const name = target.startsWith('/') ? target.slice(1) : path.posix.join('word', target);
    const entry = zip.get(name);
    if (!entry) return '[image missing]';
    const file = path.join(folder, path.posix.basename(name));
    fs.writeFileSync(file, readEntry(entry));
    return `[image: ${file}]`;
  };
  const shown = Number.isFinite(last) && last > 0 ? prompts.slice(-last) : prompts;
  console.log(
    shown
      .map((lines) => lines.join('\n').replace(/\0([^\0]*)\0/g, (_, rel) => saveImage(rel)))
      .join('\n\n'),
  );
}

function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (${zone})`
  );
}

function textRuns(text) {
  return text
    .split('\n')
    .map((line) =>
      line
        .split('\t')
        .map((part) => `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`)
        .join('<w:tab/>'),
    )
    .join('<w:br/>');
}

function escapeXml(text) {
  return text
    .replace(/[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXml(text) {
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
    if (named[entity]) return named[entity];
    const hex = entity[1] === 'x' || entity[1] === 'X';
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

function highest(xml, pattern) {
  return [...xml.matchAll(pattern)].reduce((max, match) => Math.max(max, Number(match[1])), 0);
}

// Node has no zip API and the project has no docx dependency, so the archive
// is read and written by hand. Parts the run does not touch (the images, and
// anything Word added) are copied still compressed, never inflated.

function readZip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('it is not a valid .docx');
  const entries = new Map();
  let at = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i -= 1) {
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.set(buf.toString('utf8', at + 46, at + 46 + nameLength), {
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      size: buf.readUInt32LE(at + 24),
      data: buf.subarray(data, data + buf.readUInt32LE(at + 20)),
    });
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

function readEntry(entry) {
  return entry.method === 8 ? zlib.inflateRawSync(entry.data) : entry.data;
}

function readText(zip, name) {
  const entry = zip.get(name);
  if (!entry) throw new Error(`${name} is missing from it`);
  return readEntry(entry).toString('utf8');
}

function putEntry(zip, name, content, compress = true) {
  const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  zip.set(name, {
    method: compress ? 8 : 0,
    crc: zlib.crc32(raw),
    size: raw.length,
    data: compress ? zlib.deflateRawSync(raw) : raw,
  });
}

function writeZip(zip) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, entry] of zip) {
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, entry.data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip.size, 8);
  end.writeUInt16LE(zip.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const args = process.argv.slice(2);
if (args[0] === '--dump') {
  const last = args.indexOf('--last');
  dump(last === -1 ? Infinity : Number(args[last + 1]));
} else {
  runHook();
}
