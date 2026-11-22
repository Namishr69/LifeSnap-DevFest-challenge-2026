import { parentPort, workerData } from 'node:worker_threads';
import convert from 'heic-convert';
import sharp from 'sharp';

const input = Buffer.from(workerData);
const {width, height} = await sharp(input, {limitInputPixels: 30_000_000}).metadata();
if (!width || !height || width * height > 30_000_000) throw new Error('Photo is too large to convert.');
const jpeg = await convert({buffer: input, format: 'JPEG', quality: .9});
const preview = await sharp(jpeg, {limitInputPixels: 30_000_000}).rotate()
  .resize({width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true}).jpeg({quality: 88}).toBuffer();
parentPort.postMessage(preview);
