// 票券模式的序號與簽章（docs/adr/0008-ticket-mode.md）。
// 票券 = `<序號>.<sig>`；sig 是 Ed25519 對序號字串的 detached signature，base64url 86 字。
// 序號就是簽章涵蓋的字串，規則比對與查名單都用它，所以改任何一個字元都會驗章失敗。

import nacl from "tweetnacl";

const SERIAL = /^[A-Za-z0-9_-]{1,32}$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SIG_CHARS = 86;

export const DEFAULT_WIDTH = 5;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function isValidSerial(serial: string): boolean {
  return SERIAL.test(serial);
}

/** 前綴結尾不是數字，流水號才能唯一拆回「前綴＋數字」，不同前綴永遠不會撞號。 */
export function isValidPrefix(prefix: string): boolean {
  return /^[A-Za-z0-9_-]*[A-Za-z_-]$/.test(prefix);
}

/** 切掉結尾的連續數字，剩下的就是前綴。 */
export function splitPrefix(serial: string): { prefix: string; digits: string } {
  const match = /^(.*?)(\d*)$/.exec(serial)!;
  return { prefix: match[1], digits: match[2] };
}

export function formatSerial(prefix: string, n: number, width: number): string {
  return prefix + String(n).padStart(width, "0");
}

export function toBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    out += ALPHABET[bytes[i] >> 2] + ALPHABET[(bytes[i] & 3) << 4];
  } else if (rest === 2) {
    const m = (bytes[i] << 8) | bytes[i + 1];
    out += ALPHABET[m >> 10] + ALPHABET[(m >> 4) & 63] + ALPHABET[(m & 15) << 2];
  }
  return out;
}

export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let k = 0;
  for (const ch of text) {
    acc = ((acc << 6) | ALPHABET.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[k++] = (acc >> bits) & 255;
    }
  }
  return bytes;
}

/** 序號只有 ASCII，逐字取 char code 就是 UTF-8。 */
function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  return nacl.sign.keyPair.fromSeed(seed);
}

export function sign(secretKey: Uint8Array, serial: string): string {
  if (!isValidSerial(serial)) throw new Error(`序號格式不符：${serial}`);
  return `${serial}.${toBase64url(nacl.sign.detached(ascii(serial), secretKey))}`;
}

export function parseToken(token: string): { serial: string; sig: Uint8Array } | null {
  const parts = token.trim().split(".");
  if (parts.length !== 2 || !isValidSerial(parts[0]) || parts[1].length !== SIG_CHARS) return null;
  const sig = fromBase64url(parts[1]);
  return sig && sig.length === nacl.sign.signatureLength ? { serial: parts[0], sig } : null;
}

/** 簽章成立時回傳序號，否則 null。 */
export function verifyToken(publicKey: Uint8Array, token: string): string | null {
  const parsed = parseToken(token);
  if (!parsed) return null;
  return nacl.sign.detached.verify(ascii(parsed.serial), parsed.sig, publicKey) ? parsed.serial : null;
}
