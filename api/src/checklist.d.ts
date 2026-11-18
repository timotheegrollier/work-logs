export interface ChecklistChange {
  index: number;
  checked: boolean;
}

export interface ChecklistItem extends ChecklistChange {
  text: string;
}

export function getChecklistItems(source: string): ChecklistItem[];
export function checklistProgress(source: string): number | null;
export function updateChecklistItems(source: string, changes: readonly ChecklistChange[]): string;
