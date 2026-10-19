// 沒有 BarcodeDetector 的瀏覽器（Windows／Linux 的桌機 Chrome、Firefox）用 jsQR 解碼。
// main.ts 以動態 import 載入這個模組，有 BarcodeDetector 的手機不會下載 jsQR。

// jsqr 是 CommonJS 且 module.exports.default === module.exports。在 nodenext 下 TypeScript 把預設匯入
// 視為整個模組，所以再取一次 .default；Node 與 esbuild 執行時拿到的都是同一個函式。
import jsqr from "jsqr";

const jsQR = jsqr.default;

export function decodeRgba(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}
