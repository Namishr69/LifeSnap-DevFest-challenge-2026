import sharp from 'sharp';
import jsQR from 'jsqr';

function describe(value) {
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '�');
  const payload = text.slice(0, 4000);
  if (/^WIFI:/i.test(text)) return {type: 'Wi-Fi configuration', payload};
  if (/^(MECARD:|BEGIN:VCARD)/i.test(text)) return {type: 'Contact details', payload};
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  const types = {mailto: 'Email address', tel: 'Phone number', sms: 'Text message', geo: 'Location'};
  if (['http', 'https'].includes(scheme)) {
    try {
      const url = new URL(text);
      return {type: 'Web address', host: url.hostname, scheme, payload};
    } catch {
      return {type: 'Malformed web address', payload};
    }
  }
  if (scheme) return {type: types[scheme] || 'App link or other protocol', scheme, payload};
  return {type: 'Plain text', payload};
}

export async function decodeQR(bytes) {
  const {data, info} = await sharp(bytes, {limitInputPixels: 28_000_000, failOn: 'error'})
    .rotate().resize({width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true})
    .flatten({background: '#fff'}).toColourspace('srgb').ensureAlpha().raw()
    .toBuffer({resolveWithObject: true});
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const {width, height} = info;
  const found = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = jsQR(pixels, width, height);
    if (!result) break;
    if (!found.some(value => value.raw === result.data)) found.push({raw: result.data, ...describe(result.data)});
    const corners = [result.location.topLeftCorner, result.location.topRightCorner,
      result.location.bottomLeftCorner, result.location.bottomRightCorner];
    const left = Math.max(0, Math.floor(Math.min(...corners.map(point => point.x))) - 2);
    const right = Math.min(width, Math.ceil(Math.max(...corners.map(point => point.x))) + 3);
    const top = Math.max(0, Math.floor(Math.min(...corners.map(point => point.y))) - 2);
    const bottom = Math.min(height, Math.ceil(Math.max(...corners.map(point => point.y))) + 3);
    for (let y = top; y < bottom; y++) pixels.fill(255, (y * width + left) * 4, (y * width + right) * 4);
  }
  return found.map(({raw, ...details}) => details);
}
