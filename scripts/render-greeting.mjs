/**
 * Renders Aime's spoken greeting into `public/splash/greeting-<locale>.wav`.
 *
 *   node scripts/render-greeting.mjs --piper path/to/piper.exe \
 *     --voice-en path/to/en_US-ljspeech-medium.onnx \
 *     --voice-vi path/to/vi_VN-vais1000-medium.onnx
 *
 * The greeting is a shipped asset rather than the webview's own speech
 * synthesiser, and that is the whole point: `speechSynthesis` reads with whatever
 * voices Windows happens to have installed, which is a different voice on every
 * machine and, measured here, no female Vietnamese voice at all. A file sounds
 * the same everywhere Aime is installed.
 *
 * Rendered once, offline, like the portrait - nothing about this runs in the app.
 *
 * ## The voices, and why these two
 *
 * Piper (MIT) with two voices whose datasets allow being shipped in a product:
 *
 * - `en_US-ljspeech-medium` - LJ Speech, **public domain**.
 * - `vi_VN-vais1000-medium` - VAIS-1000, **CC BY 4.0**, which needs the credit
 *   that is in CHARACTER-BRIEF.md. Both are single female speakers.
 *
 * The other Vietnamese voices Piper offers were rejected on licence: `vivos` is
 * CC BY-NC-SA (no commercial use) and `25hours_single` states "Unknown", and a
 * licence nobody can name is not one to ship an asset under.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const OUT_DIR = path.join(PROJECT, "public", "splash");

/**
 * What she says, spelled for the ear.
 *
 * "Aime" is said "eye-mee", and a synthesiser reading the written name says
 * "aim" - so only the spoken form is respelled. Keep these in step with the
 * fallback lines in `splash.html`, which are what a machine without the audio
 * files would say.
 *
 * The wording carries as much of how young she sounds as the pitch does: "nha"
 * and "nhé" are what somebody her age would actually say, and a synthesiser
 * reads them with the rising, lighter ending they are said with. A correctly
 * punctuated sentence read at a high pitch is still a newsreader.
 */
const LINES = {
  en: "Hi! I'm Eye-mee. Have a super day at work!",
  vi: "Xin chào! Mình là Ai Mi nha. Chúc bạn hôm nay làm việc thật vui nhé!",
};

/**
 * How much higher the rendered voice is pitched, and how it is done.
 *
 * Rewriting the sample rate in the WAV header is the whole of what a resample by
 * a constant factor is: the voice comes out this much higher - and this much
 * faster, which is why `LENGTH_SCALE` below is the same number. Synthesised
 * slower, played faster: the pitch moves and the tempo stays. Formants rise with
 * it, which is the part that actually reads as young rather than as a woman on
 * fast-forward.
 *
 * Measured on the two voices at 1.35: 267 Hz for English, 298 Hz for Vietnamese,
 * against 197 and 218 unshifted. This is the ceiling, not a preference: past
 * about 1.35 the consonants start to whistle. Both datasets are adult female
 * readers, and no amount of shifting turns a reader into a teenager - that is
 * the speaker, not the pitch (see CHARACTER-BRIEF.md).
 */
const BRIGHTEN = 1.25;
/**
 * How much slower than the voice's own pace she says it.
 *
 * The two knobs were one for a while - `LENGTH_SCALE = BRIGHTEN`, so the pitch
 * moved and the tempo came back to exactly piper's default. Reported on hearing
 * it: too fast. Piper's default is brisk to begin with, and a high pitch makes
 * brisk sound rushed, so the finished line is deliberately slower than it.
 */
const RELAX = 1.15;
/**
 * Piper's own speed control: it cancels the speed-up that `BRIGHTEN` brings, and
 * then some. Synthesised this much slower, played `BRIGHTEN` faster.
 */
const LENGTH_SCALE = BRIGHTEN * RELAX;

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    options[flag.slice(2)] = argv[i + 1];
  }
  for (const required of ["piper", "voice-en", "voice-vi"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

/** Runs piper over one line and returns nothing - it writes the file itself. */
async function synthesise(piper, voice, text, target) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      piper,
      ["--model", voice, "--output_file", target, "--length_scale", String(LENGTH_SCALE)],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let complaint = "";
    child.stderr.on("data", (chunk) => {
      complaint += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      // Piper reports on stderr even when it succeeds, so the text only matters
      // when the exit code already says something went wrong.
      else reject(new Error(`piper exited ${code}: ${complaint.trim().split("\n").slice(-3).join(" ")}`));
    });
    child.stdin.end(text);
  });
}

/**
 * Raises the pitch by declaring a higher sample rate.
 *
 * A WAV header carries the rate in two places - the format chunk's sample rate
 * and its byte rate - and both have to agree or players disagree with each other
 * about the length.
 */
async function brighten(file) {
  const wav = await fs.readFile(file);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file} is not a WAV file`);
  }
  // Walk the chunks rather than assuming the format chunk is first: piper's
  // output happens to put it there, and code that assumes so breaks silently the
  // day it does not.
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      const rate = wav.readUInt32LE(offset + 12);
      const channels = wav.readUInt16LE(offset + 10);
      const bits = wav.readUInt16LE(offset + 22);
      const raised = Math.round(rate * BRIGHTEN);
      wav.writeUInt32LE(raised, offset + 12);
      wav.writeUInt32LE((raised * channels * bits) / 8, offset + 16);
      await fs.writeFile(file, wav);
      return { rate, raised };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no format chunk`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const [locale, text] of Object.entries(LINES)) {
    const voice = options[`voice-${locale}`];
    const target = path.join(OUT_DIR, `greeting-${locale}.wav`);
    await synthesise(options.piper, voice, text, target);
    const { rate, raised } = await brighten(target);
    const { size } = await fs.stat(target);
    const seconds = (size - 44) / ((raised * 2 * 1) / 1); // 16-bit mono
    console.log(
      `[greeting] ${locale}: ${path.relative(PROJECT, target)} - ${(size / 1024).toFixed(0)} KB, ` +
        `${seconds.toFixed(1)}s, ${rate} Hz played at ${raised} Hz`,
    );
  }
}

main().catch((error) => {
  console.error(`[greeting] ${error.message}`);
  process.exit(1);
});
