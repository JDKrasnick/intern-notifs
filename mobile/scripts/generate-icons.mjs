import sharp from "sharp";
import { copyFile } from "node:fs/promises";

// All raster exports come from the editable vector master. iOS applies its
// own corner mask; keep the 1024px source opaque and full bleed.
const asset = (path) => new URL(`../${path}`, import.meta.url);
const source = asset("assets/icon.svg");
for (const [path, size] of [
  ["assets/icon.png", 1024],
  ["public/apple-touch-icon.png", 180],
]) {
  await sharp(source.pathname, { density: 384 })
    .resize(size, size)
    .removeAlpha()
    .png()
    .toFile(asset(path).pathname);
}
// Browser tabs do not apply the system icon mask. Give the favicon transparent
// rounded corners so the white tile blends into light and dark browser chrome.
await sharp(source.pathname, { density: 384 })
  .resize(64, 64)
  .ensureAlpha()
  .composite([{
    input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="white"/></svg>'),
    blend: "dest-in",
  }])
  .png()
  .toFile(asset("assets/favicon.png").pathname);
await copyFile(asset("assets/icon.png"), asset("ios/InternNotifs/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"));
console.log("Generated app, native iOS, favicon, and Apple touch icons.");
