interface HistoryTimestamp {
  id: string;
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
  const leftTime = editTime(left);
  const rightTime = editTime(right);
  return leftTime === rightTime
    ? left.id.localeCompare(right.id)
    : rightTime - leftTime;
}
