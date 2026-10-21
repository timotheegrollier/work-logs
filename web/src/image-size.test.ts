import { describe, expect, it } from 'vitest';
import { imageSize } from './image-size';

const bytes = (...values: number[]) => new Uint8Array(values);

/** Un PNG minimal : signature, puis un bloc `IHDR` de 24 octets. */
function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

/** Un JPEG minimal : marqueur `SOF0` et ses dimensions. */
function jpeg(width: number, height: number): Uint8Array {
  const out = new Uint8Array(30);
  out.set([0xff, 0xd8], 0);
  out.set([0xff, 0xc0, 0x00, 0x11, 0x08], 2);
  out.set([(height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff], 7);
  return out;
}

describe('dimensions des images', () => {
  it('PNG : la largeur et la hauteur de l’IHDR', () => {
    expect(imageSize(png(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it('JPEG : le segment SOF0', () => {
    expect(imageSize(jpeg(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('GIF : l’en-tête', () => {
    const out = new Uint8Array(13);
    out.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    out.set([320 & 0xff, (320 >> 8) & 0xff, 240 & 0xff, (240 >> 8) & 0xff], 6);
    expect(imageSize(out)).toEqual({ width: 320, height: 240 });
  });

  it('WebP : les trois variantes de flux', () => {
    const lossy = new Uint8Array(30);
    lossy.set([0x52, 0x49, 0x46, 0x46], 0);
    lossy.set([0x57, 0x45, 0x42, 0x50], 8);
    lossy.set([0x56, 0x50, 0x38, 0x20], 12);
    new DataView(lossy.buffer).setUint16(26, 640, true);
    new DataView(lossy.buffer).setUint16(28, 480, true);
    expect(imageSize(lossy)).toEqual({ width: 640, height: 480 });

    const extended = new Uint8Array(30);
    extended.set([0x52, 0x49, 0x46, 0x46], 0);
    extended.set([0x57, 0x45, 0x42, 0x50], 8);
    extended.set([0x56, 0x50, 0x38, 0x58], 12);
    extended.set([0x00, 0x00, 0x00], 24);
    extended.set([0x00, 0x00, 0x00], 27);
    expect(imageSize(extended)).toEqual({ width: 1, height: 1 });
  });

  it('BMP : l’en-tête DIB', () => {
    const out = new Uint8Array(30);
    out.set([0x42, 0x4d], 0);
    new DataView(out.buffer).setInt32(18, 400, true);
    new DataView(out.buffer).setInt32(22, -300, true);
    expect(imageSize(out)).toEqual({ width: 400, height: 300 });
  });

  it('format inconnu ou fichier abîmé : rien plutôt qu’une taille fausse', () => {
    expect(imageSize(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
    expect(imageSize(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
  });
});
