interface HistoryTimestamp {
  id: string;
  pinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

function editTime(record: HistoryTimestamp) {
  const timestamp = record.updatedAt ?? record.createdAt;
  return timestamp ? Date.parse(timestamp) || 0 : Infinity;
}

export function compareHistoryRecency(
  left: HistoryTimestamp,
  right: HistoryTimestamp,
) {
  const pinnedOrder =
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
  if (pinnedOrder) return pinnedOrder;
  const leftTime = editTime(left);
  const rightTime = editTime(right);
  return leftTime === rightTime
    ? left.id.localeCompare(right.id)
    : rightTime - leftTime;
}
