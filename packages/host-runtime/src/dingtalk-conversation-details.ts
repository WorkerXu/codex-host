import type { DingTalkConversation } from "@codexhost/shared-contracts";
import type { DingTalkCli } from "./dingtalk-cli.js";

/** Request-scoped labels; no directory or @ result survives this read. */
export async function readDingTalkConversationDetails(
  cli: DingTalkCli,
  conversations: readonly DingTalkConversation[],
): Promise<DingTalkConversation[]> {
  const [groups, mentions] = await Promise.all([
    cli.groupDirectory().catch(() => null),
    cli.atMeHits(2, 50).catch(() => null),
  ]);
  const latestMention = new Map<string, number>();
  if (mentions?.errorCode === null)
    for (const hit of mentions.hits) {
      if (hit.createdAt !== null)
        latestMention.set(
          hit.conversationId,
          Math.max(latestMention.get(hit.conversationId) ?? 0, hit.createdAt),
        );
    }
  const rows = conversations.map((row) => {
    const meta = groups?.directory?.get(row.conversationId);
    return {
      ...row,
      atMe: false,
      ...(meta && !row.singleChat
        ? { groupType: meta.groupType, memberCount: meta.memberCount }
        : {}),
    };
  });
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, rows.length) }, async () => {
      while (index < rows.length) {
        const row = rows[index++];
        if (!row || row.unreadCount <= 0) continue;
        const hitAt = latestMention.get(row.conversationId);
        if (hitAt === undefined) continue;
        const page = await cli
          .messages({ conversationId: row.conversationId, limit: Math.min(row.unreadCount, 100) })
          .catch(() => null);
        if (!page || page.errorCode !== null) continue;
        const unread = page.messages
          .slice()
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(-row.unreadCount);
        const firstUnreadAt = unread[0]?.createdAt;
        row.atMe =
          firstUnreadAt !== undefined &&
          hitAt >= firstUnreadAt &&
          hitAt <= (row.lastMessageAt ?? 0);
      }
    }),
  );
  return rows;
}
