import { describe, expect, it } from 'vitest';

import { headerImageSize } from './assets';

/** The bytes as written: numbers as they are, strings as their character codes. */
const bytes = (...parts: (number | number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((char) => char.charCodeAt(0)) : part,
    ),
  );

const be32 = (value: number) => [
  value >>> 24,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const le32 = (value: number) => [
  value & 255,
  (value >>> 8) & 255,
  (value >>> 16) & 255,
  value >>> 24,
];

describe('headerImageSize', () => {
  it('reads a PNG off its IHDR chunk', () => {
    const png = bytes(0x89, 'PNG\r\n', 0x1a, '\n', ...be32(13), 'IHDR', ...be32(640), ...be32(480));
    expect(headerImageSize(png)).toEqual({ width: 640, height: 480 });
  });

  it('reads a BMP stored either way up', () => {
    const header = (height: number) =>
      bytes('BM', ...new Array(16).fill(0), ...le32(300), ...le32(height));
    expect(headerImageSize(header(200))).toEqual({ width: 300, height: 200 });
    expect(headerImageSize(header(-200 >>> 0))).toEqual({ width: 300, height: 200 });
  });

  it('reads a JPEG off its frame header, past the segments before it', () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0, 0, 6],
      'JFIF',
      [0xff, 0xc4, 0, 3, 0],
      [0xff, 0xc2, 0, 11, 8, 1, 0x2c, 2, 0x58, 3],
    );
    expect(headerImageSize(jpeg)).toEqual({ width: 600, height: 300 });
  });

  it('says nothing for bytes that are no picture it knows', () => {
    expect(headerImageSize(bytes('GIF89a', 0, 0, 0, 0))).toBeNull();
    expect(headerImageSize(bytes(0x89, 'PNG'))).toBeNull();
  });
});
