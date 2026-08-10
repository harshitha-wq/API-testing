import * as path from 'path';
import { test, expect } from '@playwright/test';
import { loadSession } from '../session';
import { readExcelSheet } from '../excel';

const HTS_CODES_FILE = path.join(__dirname, '..', 'reports', 'hts-codes.xlsx');

test.describe('HTS', () => {
  test('candidates, calculate and search return correct data for each HTS code from the excel sheet', async ({
    request,
  }) => {
    const session = loadSession();
    const rows = await readExcelSheet(HTS_CODES_FILE, 'HTS Codes');
    expect(rows.length).toBeGreaterThan(0);

    await Promise.all(
      rows.map(async (row) => {
        const code = String(row['HTS Code']);

        // Step 1: Get resolved candidate provisions and required fields for the code
        const candidatesResponse = await request.get(`hts/candidates/${encodeURIComponent(code)}`, {
          headers: { Authorization: `Bearer ${session.token}` },
        });

        expect.soft(candidatesResponse.status(), `candidates status for ${code}`).toBe(200);

        if (candidatesResponse.ok()) {
          const candidatesBody = await candidatesResponse.json();
          expect.soft(typeof candidatesBody.htsCode, `htsCode type for ${code}`).toBe('string');
          expect.soft(typeof candidatesBody.description, `description type for ${code}`).toBe('string');
          expect.soft(Array.isArray(candidatesBody.provisions), `provisions type for ${code}`).toBe(true);
          expect.soft(Array.isArray(candidatesBody.requiredFields), `requiredFields type for ${code}`).toBe(true);
          expect.soft(Array.isArray(candidatesBody.potentialExclusions), `potentialExclusions type for ${code}`).toBe(
            true,
          );
        }

        // Step 2: Calculate landed cost and duty breakdown for the same code
        const calculateResponse = await request.post('hts/calculate', {
          data: {
            htsCode: code,
            countryOfOrigin: 'CN',
            entryDate: '2026-08-06',
            value: 1000,
            quantity: 100,
          },
          headers: { Authorization: `Bearer ${session.token}` },
        });

        expect.soft(calculateResponse.status(), `calculate status for ${code}`).toBe(200);

        if (calculateResponse.ok()) {
          const calculateBody = await calculateResponse.json();
          expect.soft(typeof calculateBody.htsCode, `calculate htsCode type for ${code}`).toBe('string');
          expect.soft(typeof calculateBody.description, `calculate description type for ${code}`).toBe('string');
          expect.soft(typeof calculateBody.baseRate, `baseRate type for ${code}`).toBe('number');
          expect.soft(Array.isArray(calculateBody.lines), `lines type for ${code}`).toBe(true);
          expect.soft(typeof calculateBody.totalDuty, `totalDuty type for ${code}`).toBe('number');
          expect.soft(typeof calculateBody.effectiveRate, `effectiveRate type for ${code}`).toBe('number');
          expect.soft(Array.isArray(calculateBody.fees), `fees type for ${code}`).toBe(true);
          expect.soft(typeof calculateBody.feeTotal, `feeTotal type for ${code}`).toBe('number');
          expect.soft(typeof calculateBody.landedCost, `landedCost type for ${code}`).toBe('number');
          expect.soft(Array.isArray(calculateBody.exemptions), `exemptions type for ${code}`).toBe(true);
          expect.soft(typeof calculateBody.columnTwoCountry, `columnTwoCountry type for ${code}`).toBe('boolean');
          expect.soft(Array.isArray(calculateBody.adCvdOrders), `adCvdOrders type for ${code}`).toBe(true);
        }

        // Step 3: Search HTS codes by number to confirm this code is searchable
        const searchResponse = await request.get('hts/search', {
          params: { q: code, limit: 5 },
          headers: { Authorization: `Bearer ${session.token}` },
        });

        expect.soft(searchResponse.status(), `search status for ${code}`).toBe(200);

        if (searchResponse.ok()) {
          const searchBody = await searchResponse.json();
          expect.soft(Array.isArray(searchBody), `search result type for ${code}`).toBe(true);
          expect.soft(searchBody.length, `search result count for ${code}`).toBeGreaterThan(0);
          for (const result of searchBody) {
            expect.soft(typeof result.htsno, `search item htsno type for ${code}`).toBe('string');
            expect.soft(typeof result.description, `search item description type for ${code}`).toBe('string');
          }
        }
      }),
    );
  });
});
