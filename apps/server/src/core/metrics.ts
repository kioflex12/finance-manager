import type { ExpenseParser } from './llm.js';
import type { Transcriber } from './stt.js';

/** Счётчики обращений к внешним сервисам с момента запуска — для админки. Живут в памяти процесса. */
export interface ServiceMetrics {
  calls: number;
  failures: number;
  totalMs: number;
}

export const metrics = {
  startedAt: new Date(),
  llm: { calls: 0, failures: 0, totalMs: 0 } as ServiceMetrics,
  stt: { calls: 0, failures: 0, totalMs: 0 } as ServiceMetrics,
};

async function measure<T>(target: ServiceMetrics, call: () => Promise<T>): Promise<T> {
  const started = Date.now();
  target.calls++;
  try {
    return await call();
  } catch (err) {
    target.failures++;
    throw err;
  } finally {
    target.totalMs += Date.now() - started;
  }
}

export function measuredParser(parser: ExpenseParser): ExpenseParser {
  return {
    parse: (input) => measure(metrics.llm, () => parser.parse(input)),
    categorize: (input) => measure(metrics.llm, () => parser.categorize(input)),
    groupItems: (items, categories) => measure(metrics.llm, () => parser.groupItems(items, categories)),
  };
}

export function measuredTranscriber(transcribe: Transcriber): Transcriber {
  return (audio, filename) => measure(metrics.stt, () => transcribe(audio, filename));
}
