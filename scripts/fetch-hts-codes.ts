import * as fs from 'fs';
import * as path from 'path';
import { writeExcelSheet, readExcelSheet } from '../excel';

const RANGES: [string, string][] = [
  ['0100', '0300'],
  ['2000', '2100'],
  ['3900', '4000'],
  ['6100', '6200'],
  ['8400', '8500'],
  ['8500', '8600'],
  ['8700', '8800'],
  ['9400', '9500'],
];
const CODES_PER_RANGE = 10;

type HtsCode = { htsCode: string; description: string };

function pickEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(items[Math.floor(i * step)]);
  }
  return picked;
}

async function fetchReferenceCodes(): Promise<HtsCode[]> {
  const codes: HtsCode[] = [];
  for (const [from, to] of RANGES) {
    const res = await fetch(`https://hts.usitc.gov/reststop/exportList?from=${from}&to=${to}&format=JSON&styles=false`);
    if (!res.ok) throw new Error(`USITC export failed for ${from}-${to}: ${res.status}`);
    const rows = (await res.json()) as any[];
    const leafCodes: HtsCode[] = rows
      .filter((row: any) => row.htsno && /^\d{4}\.\d{2}\.\d{2}$/.test(row.htsno))
      .map((row: any) => ({ htsCode: row.htsno, description: String(row.description).replace(/:+$/, '').trim() }));
    codes.push(...pickEvenly(leafCodes, CODES_PER_RANGE));
  }
  return codes;
}

export const HTS_CODES_FILE = path.join(__dirname, '..', 'reports', 'hts-codes.xlsx');

export async function ensureHtsCodesFile(filePath: string = HTS_CODES_FILE): Promise<void> {
  if (fs.existsSync(filePath)) return;

  const codes = await fetchReferenceCodes();
  await writeExcelSheet(
    filePath,
    'HTS Codes',
    [
      { header: 'HTS Code', key: 'htsCode', width: 16 },
      { header: 'Description', key: 'description', width: 60 },
    ],
    codes,
  );
}

async function main() {
  console.log('Fetching HTS codes from USITC...');
  const codes = await fetchReferenceCodes();
  console.log(`Fetched ${codes.length} codes.`);

  await writeExcelSheet(
    HTS_CODES_FILE,
    'HTS Codes',
    [
      { header: 'HTS Code', key: 'htsCode', width: 16 },
      { header: 'Description', key: 'description', width: 60 },
    ],
    codes,
  );
  console.log(`Wrote ${codes.length} codes to ${HTS_CODES_FILE}`);

  const readBack = await readExcelSheet(HTS_CODES_FILE, 'HTS Codes');
  console.log(`Read back ${readBack.length} rows. First row:`, readBack[0]);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
