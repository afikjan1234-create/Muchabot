import sharp, { Sharp } from 'sharp';

/**
 * Order screenshots reach the bot in wildly different shapes: a crisp screen
 * grab from the delivery system, or a photo of a phone screen taken in a dim
 * kitchen, at an angle, with glare and motion blur. Both the vision model and
 * Tesseract read the bad ones far better after some conditioning, so every
 * OCR attempt runs over the renditions below instead of the raw upload.
 */

export interface ImageVariant {
  name: string;
  buffer: Buffer;
  mimeType: string;
}

// Small images are the main killer: a 480px-wide photo of a screen leaves each
// digit only a few pixels tall. Upscaling before sharpening gives the OCR
// something to work with. Past ~2400px we'd only be paying for tokens.
const MIN_WIDTH = 1600;
const MAX_WIDTH = 2400;

async function normalizeSize(input: Buffer): Promise<Sharp> {
  // rotate() with no argument applies the EXIF orientation — phone photos are
  // routinely stored sideways, and a rotated image reads as gibberish.
  const img = sharp(input, { failOn: 'none' }).rotate();
  const { width } = await img.metadata();

  if (!width) return img;
  if (width < MIN_WIDTH) return img.resize({ width: MIN_WIDTH, kernel: 'lanczos3' });
  if (width > MAX_WIDTH) return img.resize({ width: MAX_WIDTH, kernel: 'lanczos3' });
  return img;
}

/** Upscaled and lightly sharpened, colour kept — the general-purpose rendition. */
async function upscaled(input: Buffer): Promise<Buffer> {
  return (await normalizeSize(input)).sharpen().png().toBuffer();
}

/**
 * Grayscale with the tonal range stretched back out. This is the one that
 * rescues washed-out photos and screens shot in low light, where the text sits
 * in a narrow band of greys instead of spanning black to white.
 */
async function contrastBoosted(input: Buffer): Promise<Buffer> {
  return (await normalizeSize(input))
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.5 })
    .png()
    .toBuffer();
}

/**
 * Hard black-and-white. Throws away every shade, which is exactly what
 * Tesseract wants from a noisy photo — but it also destroys faint strokes,
 * so it is only ever an additional attempt, never the only one.
 */
async function binarized(input: Buffer): Promise<Buffer> {
  return (await normalizeSize(input))
    .grayscale()
    .normalize()
    .median(1) // knock out sensor speckle before thresholding
    .threshold(140)
    .png()
    .toBuffer();
}

/**
 * Renditions to feed the OCR, cheapest-to-most-aggressive. Each is attempted
 * in order until the details come back complete, so a clean screenshot still
 * costs exactly one pass.
 *
 * Preprocessing is best-effort: a variant that sharp cannot produce (an exotic
 * codec, a truncated download) is skipped rather than failing the upload, and
 * the untouched original is always available as the last resort.
 */
export async function ocrVariants(
  input: Buffer,
  originalMimeType: string
): Promise<ImageVariant[]> {
  const variants: ImageVariant[] = [];

  const builders: [string, (b: Buffer) => Promise<Buffer>][] = [
    ['upscaled', upscaled],
    ['contrast', contrastBoosted],
    ['binarized', binarized],
  ];

  for (const [name, build] of builders) {
    try {
      variants.push({ name, buffer: await build(input), mimeType: 'image/png' });
    } catch (err) {
      console.error(`[image] variant "${name}" failed:`, err);
    }
  }

  variants.push({ name: 'original', buffer: input, mimeType: originalMimeType });
  return variants;
}
