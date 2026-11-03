import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import png2icons from "png2icons";

const source = new URL("../../resources/icons/icon.svg", import.meta.url);
const png = await sharp(await readFile(source))
  .resize(1024, 1024)
  .png()
  .toBuffer();
const icns = png2icons.createICNS(png, png2icons.BICUBIC2, 0);
const ico = png2icons.createICO(png, png2icons.BICUBIC2, 0, false, true);
if (!icns || !ico) throw new Error("无法生成应用图标。");
await Promise.all([
  writeFile(new URL("../../resources/icons/icon.png", import.meta.url), png),
  writeFile(new URL("../../resources/icons/icon.icns", import.meta.url), icns),
  writeFile(new URL("../../resources/icons/icon.ico", import.meta.url), ico),
]);
console.log("Generated PNG, ICNS and ICO icons.");
