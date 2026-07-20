// ============================================================
// Open Peeps 风格头像批量生成器
//
// 用 DiceBear 的 open-peeps 风格（Pablo Stanley 原作，CC0）以固定种子
// 确定性生成 24 个头像：SVG + 512×512 透明底 PNG，外加一张 6×4 预览图。
//
// 用法：npm run generate（或 node generate.mjs）
// ============================================================

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAvatar } from "@dicebear/core";
import * as openPeeps from "@dicebear/open-peeps";
import { Resvg } from "@resvg/resvg-js";

const COUNT = 24;
const COLS = 6;
const CELL = 256;
const GAP = 24;

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "output");
await mkdir(outDir, { recursive: true });

function svgToPng(svg, width) {
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: width },
		background: "rgba(255, 255, 255, 0)",
	});
	return resvg.render().asPng();
}

const svgs = [];
for (let i = 1; i <= COUNT; i++) {
	const id = String(i).padStart(2, "0");
	const svg = createAvatar(openPeeps, { seed: `peep-${id}` }).toString();
	svgs.push(svg);
	await writeFile(path.join(outDir, `avatar-${id}.svg`), svg);
	await writeFile(path.join(outDir, `avatar-${id}.png`), svgToPng(svg, 512));
}

// 6×4 预览图：把每个 SVG 以 data-URI <image> 嵌入网格
const rows = Math.ceil(COUNT / COLS);
const sheetWidth = COLS * CELL + (COLS + 1) * GAP;
const sheetHeight = rows * CELL + (rows + 1) * GAP;
const images = svgs
	.map((svg, i) => {
		const x = GAP + (i % COLS) * (CELL + GAP);
		const y = GAP + Math.floor(i / COLS) * (CELL + GAP);
		const b64 = Buffer.from(svg).toString("base64");
		return `<image x="${x}" y="${y}" width="${CELL}" height="${CELL}" href="data:image/svg+xml;base64,${b64}"/>`;
	})
	.join("");
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${sheetHeight}" viewBox="0 0 ${sheetWidth} ${sheetHeight}"><rect width="100%" height="100%" fill="#f5f5f4"/>${images}</svg>`;
await writeFile(path.join(outDir, "contact-sheet.svg"), sheet);
await writeFile(path.join(outDir, "contact-sheet.png"), svgToPng(sheet, 1680));

console.log(`Generated ${COUNT} avatars (SVG + PNG) and contact-sheet -> ${outDir}`);
