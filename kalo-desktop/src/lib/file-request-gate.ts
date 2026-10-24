/** Latest-request ownership across directory/session switches. No IPC or DOM. */
export function createFileRequestGate() {
  let scope = "";
  let generation = 0;
  let sequence = 0;
  const requests = new Map<string, number>();
  return {
    setScope(next: string) {
      if (scope === next) return;
      scope = next;
      generation++;
      requests.clear();
    },
    start(key: string) {
      const id = ++sequence;
      requests.set(key, id);
      return { key, id, generation };
    },
    isCurrent(token: { key: string; id: number; generation: number }) {
      return token.generation === generation && requests.get(token.key) === token.id;
    },
  };
}
