// 建置：gas/central、gas/shim 各打包成一支 Apps Script 檔；web 打包成靜態頁。輸出到 dist/。
//
// Apps Script 只認得頂層函式宣告，而 esbuild 的 IIFE 會把 export 包進一個全域物件。
// 所以每個進入點 export 的函式，都在檔尾補一個同名的頂層轉呼叫函式。

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const GLOBAL = "__rollcall";

async function buildGas(name: string): Promise<void> {
  const outdir = `dist/gas/${name}`;
  mkdirSync(outdir, { recursive: true });
  const common = {
    entryPoints: [`gas/${name}/main.ts`],
    bundle: true,
    target: "es2020",
    charset: "utf8",
    write: false,
  } satisfies esbuild.BuildOptions;
  // metafile 只在 ESM 輸出時列出 exports，所以先用 ESM 取得名單，再輸出 IIFE。
  const esm = await esbuild.build({ ...common, format: "esm", metafile: true });
  const exports = Object.values(esm.metafile!.outputs)[0].exports;
  const result = await esbuild.build({ ...common, format: "iife", globalName: GLOBAL });
  const stubs = exports
    .map((fn) => `function ${fn}() { return ${GLOBAL}.${fn}.apply(this, arguments); }`)
    .join("\n");
  writeFileSync(`${outdir}/Code.js`, `${result.outputFiles![0].text}\n${stubs}\n`);
  copyFileSync(`gas/${name}/appsscript.json`, `${outdir}/appsscript.json`);
}

async function buildWeb(): Promise<void> {
  await esbuild.build({
    entryPoints: ["web/main.ts"],
    bundle: true,
    format: "esm",
    target: "es2020",
    charset: "utf8",
    outfile: "dist/web/main.js",
  });
  copyFileSync("web/index.html", "dist/web/index.html");
}

rmSync("dist", { recursive: true, force: true });
await Promise.all([buildGas("central"), buildGas("shim"), buildWeb()]);
