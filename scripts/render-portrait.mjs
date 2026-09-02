/**
 * Renders the splash portrait from a 3D model into `public/splash/aime.webp`.
 *
 *   node scripts/render-portrait.mjs --model path/to/aime.vrm
 *
 * The splash plays a single animated WebP with an alpha channel, and this is
 * what produces it. Rendering happens once, here, rather than in the app: the
 * splash window's whole job is to be on glass within a few milliseconds, and a
 * WebGL library plus a model measured in megabytes would end that.
 *
 * The renderer itself is `scripts/portrait/render.html`, driven headless -
 * a browser is the only 3D renderer this machine has, and the one it has is
 * good. Frames come back as PNG data URLs and leave as one looping WebP.
 *
 * The model's own licence is read out of the file and checked before anything is
 * written. A VRM states whether it may be used commercially; shipping one that
 * says no would be a licence breach hidden inside a binary asset.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { remote } from "webdriverio";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");

/**
 * The same driver the end-to-end suite uses, found the same way - but not
 * necessarily the same version of it.
 *
 * This drives the Edge browser; the suite drives the WebView2 runtime, and
 * Windows updates the two on their own schedules. Measured 2026-09-01: Edge was
 * 152.0.4191.53 while WebView2 was still 151.0.4129.107, and no single driver
 * serves both - each refuses the other with "only supports Microsoft Edge
 * version N". Leave the suite's copy where it is and point `AIME_EDGE_DRIVER`
 * at a driver matching the browser whenever the two have drifted apart.
 */
const DRIVER = process.env.AIME_EDGE_DRIVER ?? path.join(os.homedir(), ".aime-e2e", "msedgedriver.exe");

const DEFAULTS = {
  out: path.join("public", "splash", "aime.webp"),
  // 660 x 714 keeps the aspect that frames her raised arm (see CAMERA_SHIFT in
  // the renderer) while staying a little above the size she is drawn at: the
  // welcome screen gives her 545 physical pixels of width on a 150% display.
  width: 660,
  height: 714,
  frames: 120,
  // Twenty-four rather than eighteen. Eighteen was measured on the card and read
  // as stiff on the one thing that moves fast - the hand at the ends of a wave.
  fps: 24,
  // The frames went up by a sixth when the rate did, so the quality comes down
  // to pay for them: measured, 60 costs 2.3 MB at 96 frames and 50 costs 2.0,
  // and on a flat-shaded figure at the size the splash shows her the two are
  // indistinguishable. The file is decoded at every launch, so the cheaper wins.
  quality: 46,
};

/** What a VRM may say about commercial use and still be shippable. */
const COMMERCIAL_OK = new Set(["allow", "allowed", "personalprofit", "corporation"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".vrm": "model/gltf-binary",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
};

function parseArguments(argv) {
  const options = { ...DEFAULTS, headed: false, allowAnyLicence: false, still: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--model":
      case "--out":
      case "--still":
        options[flag.slice(2)] = value;
        i += 1;
        break;
      case "--width":
      case "--height":
      case "--frames":
      case "--fps":
      case "--quality":
        options[flag.slice(2)] = Number(value);
        i += 1;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--allow-any-licence":
        options.allowAnyLicence = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!options.model) throw new Error("--model <path to .vrm or .glb> is required");
  return options;
}

/**
 * Serves the project read-only, plus the model under one fixed name.
 *
 * The page needs `node_modules` (three and three-vrm are ES modules) and the
 * model, and a module graph cannot be loaded over `file://` at all - hence a
 * server rather than a path.
 */
async function serve(modelPath) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(body);
    };

    const file =
      url.pathname === "/model.vrm" ? path.resolve(modelPath) : path.resolve(PROJECT, `.${url.pathname}`);
    // Nothing outside the project may be read, whatever the path claims.
    if (file !== path.resolve(modelPath) && !file.startsWith(PROJECT + path.sep)) {
      send(403, "outside the project");
      return;
    }

    response.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file)
      .on("error", () => {
        response.destroy();
      })
      .pipe(response);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

/** Starts msedgedriver and waits for it to answer. */
async function startDriver() {
  await fs.access(DRIVER).catch(() => {
    throw new Error(`Edge driver not found at ${DRIVER} - set AIME_EDGE_DRIVER`);
  });
  const port = 9600 + (Math.floor(process.uptime() * 10) % 300);
  const driver = spawn(DRIVER, [`--port=${port}`], { stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/status`);
      if (answer.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      driver.kill();
      throw new Error("the Edge driver never came up");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { driver, port };
}

function licenceLine(info) {
  return `${info.title || "untitled"} — licence ${info.licence || "unstated"}, commercial use ${
    info.commercial || "unstated"
  }`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { server, port: httpPort } = await serve(options.model);
  const { driver, port: driverPort } = await startDriver();
  let browser;

  try {
    browser = await remote({
      logLevel: "error",
      hostname: "127.0.0.1",
      port: driverPort,
      capabilities: {
        browserName: "MicrosoftEdge",
        "ms:edgeOptions": {
          args: [
            // Software GL, because a headless browser has no GPU to ask.
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            `--window-size=${options.width + 40},${options.height + 140}`,
            ...(options.headed ? [] : ["--headless=new"]),
          ],
        },
      },
    });

    const query = new URLSearchParams({
      model: "/model.vrm",
      w: String(options.width),
      h: String(options.height),
      frames: String(options.frames),
      fps: String(options.fps),
    });
    await browser.url(`http://127.0.0.1:${httpPort}/scripts/portrait/render.html?${query}`);

    const info = await browser.waitUntil(
      async () =>
        browser.execute(async () => {
          try {
            return await window.__portrait?.ready;
          } catch (error) {
            return { failed: String(error) };
          }
        }),
      { timeout: 120_000, timeoutMsg: "the renderer never loaded the model" },
    );
    if (info.failed) throw new Error(`the renderer failed: ${info.failed}`);
    console.log(`[portrait] ${licenceLine(info)}`);
    if (info.expressions) {
      console.log(`[portrait] expressions: ${info.expressions.join(", ") || "none"}`);
      console.log(`[portrait] lookAt: ${info.hasLookAt}  extra bones: ${info.bones.join(", ")}`);
    }

    const commercial = String(info.commercial).toLowerCase();
    if (!COMMERCIAL_OK.has(commercial) && !options.allowAnyLicence) {
      throw new Error(
        `this model says commercial use is "${info.commercial || "unstated"}" - refusing to ` +
          `write it into the app. Pass --allow-any-licence only for a throwaway test render.`,
      );
    }

    console.log(`[portrait] ${info.frames} frames at ${info.width}x${info.height}, ${info.fps} fps`);
    const frames = [];
    for (let index = 0; index < info.frames; index += 1) {
      const dataUrl = await browser.execute(async (at) => window.__portrait.frame(at), index);
      frames.push(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
    }

    // The still goes out first, so that `--frames 1` - the way a pose or a light
    // is checked - still leaves something to look at.
    if (options.still) {
      const still = path.resolve(PROJECT, options.still);
      await fs.mkdir(path.dirname(still), { recursive: true });
      await fs.writeFile(still, frames[0]);
      console.log(`[portrait] first frame -> ${path.relative(PROJECT, still)}`);
    }

    if (frames.length < 2) {
      console.log("[portrait] one frame is not a loop - no animation written");
      return;
    }

    // Every frame lasts the same time, and sharp wants that said once per frame:
    // a single number is applied to the first frame only (measured, sharp 0.35).
    const delay = Array.from({ length: frames.length }, () => Math.round(1000 / info.fps));
    const out = path.resolve(PROJECT, options.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await sharp(frames, { join: { animated: true } })
      .webp({ loop: 0, delay, quality: options.quality, alphaQuality: 100, effort: 6 })
      .toFile(out);

    const { size } = await fs.stat(out);
    console.log(
      `[portrait] wrote ${path.relative(PROJECT, out)} — ${(size / 1024).toFixed(0)} KB, ` +
        `${(info.frames / info.fps).toFixed(1)}s loop`,
    );
  } finally {
    await browser?.deleteSession().catch(() => undefined);
    driver.kill();
    server.close();
  }
}

main().catch((error) => {
  console.error(`[portrait] ${error.message}`);
  process.exit(1);
});
