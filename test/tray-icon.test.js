const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function alphaRows(file) {
  const png = fs.readFileSync(file);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  let width;
  let height;
  let offset = 8;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8, 'tray PNG must use 8-bit channels');
      assert.equal(chunk[9], 6, 'tray PNG must be transparent RGBA');
    }
    if (type === 'IDAT') compressed.push(chunk);
    offset += length + 12;
  }

  const raw = zlib.inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  let previous = Buffer.alloc(stride);
  let position = 0;
  const rows = [];
  const bounds = { minX: width, maxX: -1, minY: height, maxY: -1 };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position++];
    const row = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 4 ? row[i - 4] : 0;
      const above = previous[i];
      const upperLeft = i >= 4 ? previous[i - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const base = left + above - upperLeft;
        const distances = [left, above, upperLeft].map((value) => Math.abs(base - value));
        predictor = [left, above, upperLeft][distances.indexOf(Math.min(...distances))];
      } else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
      row[i] = (row[i] + predictor) & 0xff;
    }
    let visible = 0;
    for (let x = 0; x < width; x += 1) {
      if (row[x * 4 + 3] <= 2) continue;
      visible += 1;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
    rows.push(visible);
    previous = row;
  }
  return { width, height, rows, bounds };
}

for (const [name, size] of [['trayTemplate.png', 18], ['trayTemplate@2x.png', 36]]) {
  test(`${name} has no detached top rule and retains a centered symbol`, () => {
    const { width, height, rows, bounds } = alphaRows(path.join(__dirname, '..', 'assets', name));
    assert.equal(width, size);
    assert.equal(height, size);
    assert.ok(Math.max(...rows.slice(0, Math.ceil(height / 4))) < width / 2, 'top quarter contains a wide horizontal line');
    assert.ok(rows.slice(Math.floor(height / 4)).reduce((sum, count) => sum + count, 0) > size * 2, 'logo body is missing');
    assert.ok(Math.abs((bounds.minX + bounds.maxX) / 2 - (width - 1) / 2) <= 1, 'logo is off-center horizontally');
    assert.ok(Math.abs((bounds.minY + bounds.maxY) / 2 - (height - 1) / 2) <= 1.5, 'logo is off-center vertically');
  });
}
