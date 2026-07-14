import type { Resolver } from '../types';
import { buildResult, extractSignals } from '../match';
import { safeDecode } from '../ruleMatching';

/** SharePoint / Google Drive client folder match on the activity URL. */
export const folderResolver: Resolver = {
  type: 'sharepoint_folder',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    const hay = safeDecode(s.urlNorm);
    if (!hay && !s.driveFolderId) return null;

    const hitClients: string[] = [];
    let matchedPath = '';
    let sourceSystem = 'sharepoint';
    for (const f of ctx.graph.folders) {
      const idHit =
        !!f.externalId &&
        (s.urlNorm.includes(f.externalId.toLowerCase()) ||
          (!!s.driveFolderId && f.externalId.toLowerCase().includes(s.driveFolderId.toLowerCase())));
      const pathHit = !!f.path && hay.includes(f.path);
      if (idHit || pathHit) {
        hitClients.push(f.clientId);
        matchedPath = f.path ?? f.externalId ?? '';
        sourceSystem = f.sourceSystem;
      }
    }
    if (hitClients.length === 0) return null;
    const resolverType = sourceSystem === 'google_drive' ? 'google_drive_folder' : 'sharepoint_folder';
    return buildResult(hitClients, ctx.graph, 0.92, resolverType, {
      reason: `Activity URL is under a mapped ${sourceSystem} client folder`,
      matchedOn: 'folder',
      matchedValue: matchedPath,
      sourceField: 'url',
      sourceSystem,
    });
  },
};
