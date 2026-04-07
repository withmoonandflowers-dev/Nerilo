/**
 * 智慧時間戳格式化
 * - 今天: "HH:mm"
 * - 昨天: "昨天 HH:mm"
 * - 今年其他天: "MM/DD HH:mm"
 * - 更早: "YYYY/MM/DD HH:mm"
 */
export function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();

  const pad = (n: number) => n.toString().padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  // Check if same day
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) return time;

  // Check if yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) return `昨天 ${time}`;

  // Same year
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`;
  }

  // Older
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`;
}

/**
 * 判斷兩個時間戳之間是否應該插入日期分隔線
 * 規則：日期不同時插入
 */
export function shouldShowDateSeparator(prevTs: number, currentTs: number): boolean {
  const prev = new Date(prevTs);
  const current = new Date(currentTs);
  return (
    prev.getFullYear() !== current.getFullYear() ||
    prev.getMonth() !== current.getMonth() ||
    prev.getDate() !== current.getDate()
  );
}

/**
 * 格式化日期分隔線文字
 */
export function formatDateSeparator(ts: number): string {
  const date = new Date(ts);
  const now = new Date();

  const pad = (n: number) => n.toString().padStart(2, '0');

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) return '今天';

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) return '昨天';

  if (date.getFullYear() === now.getFullYear()) {
    return `${pad(date.getMonth() + 1)} 月 ${pad(date.getDate())} 日`;
  }

  return `${date.getFullYear()} 年 ${pad(date.getMonth() + 1)} 月 ${pad(date.getDate())} 日`;
}
