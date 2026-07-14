import type { Resolver } from '../types';
import { extractSignals, matchClientsByText, nameMatchResult } from '../match';

const AI_HOSTS = [
  'chat.openai.com', 'chatgpt.com', 'claude.ai', 'gemini.google.com',
  'bard.google.com', 'perplexity.ai', 'copilot.microsoft.com',
];

/**
 * ChatGPT / Claude / etc. If the conversation title names a client we use it;
 * otherwise we return null so context carry-forward can inherit the current
 * client (e.g. you switch from CCH for Client A straight to Claude).
 */
export const aiChatResolver: Resolver = {
  type: 'ai_chat',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    const isAi =
      AI_HOSTS.some((h) => s.host.includes(h)) ||
      s.appNorm.includes('chatgpt') ||
      s.appNorm.includes('claude') ||
      s.titleNorm.includes('chatgpt') ||
      s.titleNorm.includes('claude');
    if (!isAi) return null;

    const matches = matchClientsByText(s.title, ctx.graph);
    if (matches.length === 0) return null;
    return nameMatchResult(matches, ctx.graph, Math.min(0.66, matches[0]!.score - 0.05), 'ai_chat', {
      reason: 'Client name matched in AI chat conversation title',
      sourceField: 'window_title',
    });
  },
};
