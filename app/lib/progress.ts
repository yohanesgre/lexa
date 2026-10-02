export interface SprintProgressCount {
  done: number;
  total: number;
}

export function isSprintReadyToArchive(progress: SprintProgressCount): boolean {
  return progress.total > 0 && progress.done === progress.total;
}
