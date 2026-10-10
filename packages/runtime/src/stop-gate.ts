/** A bounded stop gate for answers that explicitly leave the current task open.
 * Pi's onYield continuation stays in the same durable run; no tool is replayed. */
export const CONTINUATION_PREFIX = '[Timber internal continuation]';
const MAX_NUDGES = 2;

function unfinishedAnswer(text: string, hasActions: boolean): boolean {
  // Avoid interpreting quoted logs, source snippets or copied user messages as
  // the assistant's own promise. Only the assistant's plain prose is a signal.
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '').trim();
  if (!prose) return false;
  // A direct promise to act must not become a final answer even before tools run.
  if (/(?:^|[.!?]\s+|\n)\s*(?:voy a|ahora voy a|seguir[eé] (?:con|revisando|trabajando)|i(?:'ll| will) (?:check|review|run|fix|deploy|continue|investigate)|let me (?:check|review|run|fix|investigate))\b/i.test(prose)) return true;
  if (!hasActions) return false;
  return /\b(?:falta (?:completar|terminar|validar|verificar|probar|desplegar|publicar|ejecutar|correr)|(?:todav[ií]a|a[uú]n) no (?:est[aá] (?:desplegad[oa]|publicad[oa]|terminad[oa])|(?:he|hemos) (?:terminado|desplegado|publicado|validado))|(?:still need(?:s)? to|not yet (?:deployed|published|finished|verified))|(?:ahora corresponde|el siguiente paso es) (?:cerrar|validar|verificar|probar|desplegar|publicar|ejecutar))\b/i.test(prose);
}

export function createStopGate(storage: Pick<DurableObjectStorage, 'sql'>) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS timber_stop_nudges (
    task_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL
  )`);
  return {
    onYield(operationId: string, taskId: string, answer: string): string | undefined {
      const hasActions = storage.sql.exec<{total:number}>(
        "SELECT COUNT(*) AS total FROM botspace_runtime_budget WHERE operation_id=? AND kind='tool'", operationId,
      ).one().total > 0;
      if (!unfinishedAnswer(answer, hasActions)) return;
      const previous = storage.sql.exec<{operation_id:string}>(
        'SELECT operation_id FROM timber_stop_nudges WHERE task_id=?', taskId,
      ).toArray()[0];
      if (previous) return previous.operation_id === operationId ? this.nudge() : undefined;
      const count = storage.sql.exec<{total:number}>(
        'SELECT COUNT(*) AS total FROM timber_stop_nudges WHERE operation_id=?', operationId,
      ).one().total;
      if (count >= MAX_NUDGES) return;
      storage.sql.exec('INSERT INTO timber_stop_nudges(task_id,operation_id) VALUES(?,?)', taskId, operationId);
      return this.nudge();
    },
    nudge(): string {
      return `${CONTINUATION_PREFIX} Your answer says the user's task still has work pending. Continue it now in this same run; do not wait for another user message. Use recorded tool results, inspect any timed-out command's effects before retrying, and follow the existing authorization and host policy. Do the next concrete step rather than narrating it. If an external blocker truly prevents progress, state exactly what it is and what remains. Only end when the requested work is finished or genuinely blocked.`;
    },
  };
}
