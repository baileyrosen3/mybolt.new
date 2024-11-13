import { format, isValid } from 'date-fns';

export interface DateItem {
  id: string;
  timestamp: number;
}

export interface DateBin<T> {
  date: string;
  items: T[];
}

export function dateCategory(timestamp: number): string {
  const date = new Date(timestamp);

  if (!isValid(date)) {
    console.warn('Invalid date encountered:', timestamp);
    return 'Invalid Date';
  }

  return format(date, 'MMMM d, yyyy');
}

export function binDates<T extends DateItem>(items: T[]): DateBin<T>[] {
  const binsMap: Record<string, T[]> = {};

  // First group items by date
  items.forEach((item) => {
    const category = dateCategory(item.timestamp);
    if (!binsMap[category]) {
      binsMap[category] = [];
    }
    binsMap[category].push(item);
  });

  // Convert to array format
  return Object.entries(binsMap).map(([date, items]) => ({
    date,
    items,
  }));
}
