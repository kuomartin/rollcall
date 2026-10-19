import { test } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { decodeRgba } from "./qr.ts";

/** 把 QR 模組矩陣畫成 RGBA 點陣，每個模組 scale 像素，四周留白 4 個模組。 */
function render(text: string, scale = 4): { data: Uint8ClampedArray; size: number } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const quiet = 4;
  const size = (modules.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (!modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

test("decodes an attendee code", () => {
  const { data, size } = render("T0123");
  assert.equal(decodeRgba(data, size, size), "T0123");
});

test("decodes non-ASCII content", () => {
  const { data, size } = render("學員A001");
  assert.equal(decodeRgba(data, size, size), "學員A001");
});

test("returns null when there is no code", () => {
  const size = 64;
  assert.equal(decodeRgba(new Uint8ClampedArray(size * size * 4).fill(255), size, size), null);
});
