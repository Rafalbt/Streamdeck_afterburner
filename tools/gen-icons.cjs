// Regenerates the Stream Deck PNG icons in imgs/ (run: `npm run icons`).
// Stream Deck requires PNG for manifest images (SVG is only accepted at runtime
// via setImage), with @2x variants. @napi-rs/canvas is a devDependency only —
// the generated PNGs are what ship, not the library.
const { createCanvas } = require("@napi-rs/canvas");
const fs = require("fs");
const path = require("path");

const OUT = path.resolve(__dirname, "../com.hwinfi.afterburner.sdPlugin/imgs");

const BG = "#101418";
const LINE = "#1d9e75";
const DOT = "#e0e6ea";

// Normalized chart polyline (0..1 in both axes).
const PTS = [
  [0.10, 0.72], [0.28, 0.55], [0.44, 0.62], [0.60, 0.34], [0.78, 0.46], [0.92, 0.24],
];

function drawChart(ctx, size, rounded) {
  ctx.clearRect(0, 0, size, size);
  if (rounded) {
    ctx.fillStyle = BG;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, size * 0.16);
    ctx.fill();
  }
  ctx.strokeStyle = LINE;
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  PTS.forEach(([nx, ny], i) => {
    const x = nx * size;
    const y = ny * size;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  if (size >= 40) {
    const [nx, ny] = PTS[3];
    ctx.fillStyle = DOT;
    ctx.beginPath();
    ctx.arc(nx * size, ny * size, size * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawKey(ctx, size) {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(size * 0.22)}px sans-serif`;
  ctx.fillText("--", size / 2, size * 0.42);
  ctx.fillStyle = "#8a9299";
  ctx.font = `${Math.round(size * 0.14)}px sans-serif`;
  ctx.fillText("sensor", size / 2, size * 0.72);
}

function save(name, size, drawFn) {
  const canvas = createCanvas(size, size);
  drawFn(canvas.getContext("2d"), size);
  fs.writeFileSync(path.join(OUT, name), canvas.toBuffer("image/png"));
  console.log(`  ${name} (${size}x${size})`);
}

console.log("Generating icons into", OUT);
save("plugin-icon.png", 72, (c, s) => drawChart(c, s, true));
save("plugin-icon@2x.png", 144, (c, s) => drawChart(c, s, true));
save("category-icon.png", 28, (c, s) => drawChart(c, s, false));
save("category-icon@2x.png", 56, (c, s) => drawChart(c, s, false));
save("action-icon.png", 20, (c, s) => drawChart(c, s, false));
save("action-icon@2x.png", 40, (c, s) => drawChart(c, s, false));
save("key-icon.png", 72, drawKey);
save("key-icon@2x.png", 144, drawKey);
console.log("Done.");
