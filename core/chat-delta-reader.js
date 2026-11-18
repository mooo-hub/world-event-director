export async function readRecentMessages(adapter, limit = 30) {
  return adapter.readRecentMessages(limit);
}

export async function readDeltaMessages(adapter, lastProcessedMessageId, limit = 30) {
  return adapter.readMessagesAfter(lastProcessedMessageId, limit);
}
