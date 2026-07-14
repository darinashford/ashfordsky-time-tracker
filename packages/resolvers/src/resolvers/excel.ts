import type { Resolver } from '../types';
import { extractSignals, matchClientsByText, nameMatchResult } from '../match';

/** Excel: client name in the file/window title (e.g. "ACME 2024 Recon - Excel"). */
export const excelResolver: Resolver = {
  type: 'excel_path',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    const isExcel =
      s.appNorm.includes('excel') || / excel$/.test(s.titleNorm) || s.titleNorm.includes('xlsx');
    if (!isExcel) return null;

    const name = s.titleNorm
      .replace(/\s*-?\s*excel.*$/, '')
      .replace(/\s*(xlsx|xls|csv)\b/g, '')
      .trim();
    const matches = matchClientsByText(name || s.title, ctx.graph);
    if (matches.length === 0) return null;
    return nameMatchResult(matches, ctx.graph, Math.min(0.78, matches[0]!.score), 'excel_path', {
      reason: 'Client name matched in Excel file/window title',
      sourceField: 'window_title',
    });
  },
};
