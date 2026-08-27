/** Joins class names, dropping the ones a condition left empty. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
