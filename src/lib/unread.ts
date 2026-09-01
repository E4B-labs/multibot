// Taskbar badge: how many conversations currently hold an unread message.
// Hidden bots don't count — they are invisible in the sidebar too.
export function unreadConversationCount(bots: { hidden?: boolean; unread?: boolean }[]): number {
  return bots.filter((bot) => !bot.hidden && bot.unread).length;
}
