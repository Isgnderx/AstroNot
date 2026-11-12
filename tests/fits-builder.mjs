// Builds small synthetic FITS files for automated tests. These are test fixtures, not archive data.

function card(key, value, comment = "") {
  let text = key.padEnd(8, " ") + "= ";
  if (typeof value === "string") text += ("'" + value.replaceAll("'", "''")).padEnd(9, " ") + "'";
  else if (typeof value === "boolean") text += (value ? "T" : "F").padStart(20, " ");
  else text += String(value).padStart(20, " ");
  if (comment) text += " / " + comment;
  return text.padEnd(80, " ").slice(0, 80);
}

function headerBlocks(cards) {
  const text = [...cards, "END".padEnd(80, " ")].join("");
  return Buffer.from(text.padEnd(Math.ceil(text.length / 2880) * 2880, " "), "ascii");
}

// buildFits({ width, height, bitpix, extra: [[key, value], ...], pixels: (x, y) => number })
// y = 0 is the first (bottom) row of the FITS array. The image is stored in the primary HDU.
export function buildFits({ width, height, bitpix = -32, extra = [], pixels = () => 0, axes }) {
  const axisSizes = axes ?? [width, height];
  const cards = [card("SIMPLE", true), card("BITPIX", bitpix), card("NAXIS", axisSizes.length)];
  axisSizes.forEach((size, index) => cards.push(card("NAXIS" + (index + 1), size)));
  for (const [key, value] of extra) cards.push(card(key, value));
  const header = headerBlocks(cards);
  const count = axisSizes.reduce((product, size) => product * size, 1);
  const bytes = Math.abs(bitpix) / 8;
  const data = Buffer.alloc(Math.ceil((count * bytes) / 2880) * 2880);
  for (let index = 0; index < count; index++) {
    const x = index % axisSizes[0];
    const y = Math.floor(index / axisSizes[0]);
    const value = pixels(x, y);
    if (bitpix === -32) data.writeFloatBE(value, index * 4);
    else if (bitpix === -64) data.writeDoubleBE(value, index * 8);
    else if (bitpix === 16) data.writeInt16BE(value, index * 2);
    else if (bitpix === 32) data.writeInt32BE(value, index * 4);
    else if (bitpix === 8) data.writeUInt8(value, index);
  }
  return Buffer.concat([header, data]);
}
