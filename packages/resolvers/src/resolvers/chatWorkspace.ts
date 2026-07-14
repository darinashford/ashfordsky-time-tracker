import type { Resolver } from '../types';
import { matchClientsByText, nameMatchResult } from '../match';

// "<channel / DM> - <Workspace> [- N new items] - Slack"
const SLACK_WS = /\s[-–]\s([^-–]+?)(?:\s[-–]\s\d+\s+new\s+items?)?\s[-–]\sSlack\s*$/i;

/**
 * For embedded engagements you live inside the client's Slack, so the workspace
 * name in the title (e.g. "… - Meridian - Slack") is a real client signal. Match
 * it to a client. Your own firm workspace ("Ashford Sky") simply won't match a
 * client and falls through. Runs before the generic name match so the workspace
 * wins over incidental participant names in a DM title.
 */
export const chatWorkspaceResolver: Resolver = {
  type: 'window_title_name',
  resolve(interval, ctx) {
    const app = (interval.app ?? '').toLowerCase();
    if (!app.includes('slack')) return null;
    const workspace = (interval.windowTitle ?? '').match(SLACK_WS)?.[1]?.trim();
    if (!workspace) return null;
    const matches = matchClientsByText(workspace, ctx.graph);
    if (matches.length === 0) return null;
    return nameMatchResult(matches, ctx.graph, Math.min(0.78, matches[0]!.score), 'window_title_name', {
      reason: `Slack workspace "${workspace}" matched to client`,
      sourceField: 'window_title',
    });
  },
};
