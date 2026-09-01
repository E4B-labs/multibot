// Minimalny QR v4-L w trybie bajtowym. Kod parowania mieści się w 80 bajtach,
// więc nie dokładamy biblioteki tylko do jednego ekranu ustawień.
const SIZE = 33;
const DATA_BYTES = 80;
const ECC_BYTES = 20;
const FORMAT_L_MASK_0 = 0x77c4;

function multiply(a: number, b: number, exp: number[], log: number[]): number {
  return a && b ? exp[log[a] + log[b]] : 0;
}

function errorCorrection(data: number[]): number[] {
  const exp = Array<number>(512).fill(0);
  const log = Array<number>(256).fill(0);
  let value = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = value;
    log[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < exp.length; i++) exp[i] = exp[i - 255];
  let generator = [1];
  for (let i = 0; i < ECC_BYTES; i++) {
    const next = Array<number>(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= multiply(generator[j], exp[i], exp, log);
    }
    generator = next;
  }
  const work = [...data, ...Array<number>(ECC_BYTES).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = work[i];
    if (!factor) continue;
    for (let j = 0; j < generator.length; j++) work[i + j] ^= multiply(generator[j], factor, exp, log);
  }
  return work.slice(data.length);
}

function codewords(payload: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(payload));
  if (bytes.length > 78) throw new Error("pairing QR payload is too long");
  const bits: number[] = [0, 1, 0, 0, ...Array.from({ length: 8 }, (_, i) => (bytes.length >> (7 - i)) & 1)];
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  bits.push(...Array(Math.min(4, DATA_BYTES * 8 - bits.length)).fill(0));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  for (let i = 0xec; data.length < DATA_BYTES; i = i === 0xec ? 0x11 : 0xec) data.push(i);
  return [...data, ...errorCorrection(data)];
}

function qrMatrix(payload: string): boolean[][] {
  const modules = Array.from({ length: SIZE }, () => Array<boolean | null>(SIZE).fill(null));
  const set = (row: number, col: number, value: boolean) => {
    if (row >= 0 && row < SIZE && col >= 0 && col < SIZE) modules[row][col] = value;
  };
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(row + r, col + c, dark);
    }
  };
  finder(0, 0);
  finder(0, SIZE - 7);
  finder(SIZE - 7, 0);
  for (let i = 8; i < SIZE - 8; i++) {
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0;
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0;
  }
  for (const center of [6, 26]) for (const other of [6, 26]) {
    if (modules[center][other] !== null) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) modules[center + r][other + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
  }
  set(SIZE - 8, 8, true);
  for (let i = 0; i < 15; i++) {
    const bit = Boolean((FORMAT_L_MASK_0 >> i) & 1);
    if (i < 6) modules[i][8] = bit;
    else if (i < 8) modules[i + 1][8] = bit;
    else modules[SIZE - 15 + i][8] = bit;
    if (i < 8) modules[8][SIZE - i - 1] = bit;
    else if (i < 9) modules[8][15 - i] = bit;
    else modules[8][15 - i - 1] = bit;
  }
  const bytes = codewords(payload);
  let bit = 0;
  let upward = false;
  for (let col = SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < SIZE; step++) {
      const row = upward ? SIZE - 1 - step : step;
      for (const currentCol of [col, col - 1]) {
        if (modules[row][currentCol] !== null) continue;
        const source = bit < bytes.length * 8 ? ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1) : 0;
        modules[row][currentCol] = Boolean(source ^ ((row + currentCol) % 2 === 0 ? 1 : 0));
        bit++;
      }
    }
    upward = !upward;
  }
  return modules.map((row) => row.map((value) => value === true));
}

export function pairingQrSvg(payload: string): string {
  const matrix = qrMatrix(payload);
  const quiet = 4;
  const cells = matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`] : []));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE + quiet * 2} ${SIZE + quiet * 2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/> <g fill="black">${cells.join("")}</g></svg>`;
}
