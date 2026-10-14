import { EventEmitter } from 'node:events';

/**
 * Изменения журналов внутри процесса: бот и API пишут в одну базу, а открытые миниаппы
 * подписаны на события и перечитывают данные, когда в их журнале что-то поменялось.
 */
const emitter = new EventEmitter();
// каждое открытое приложение — отдельный подписчик
emitter.setMaxListeners(0);

export function notifyRoom(roomId: number): void {
  emitter.emit('change', roomId);
}

export function onRoomChange(roomId: number, listener: () => void): () => void {
  const handler = (changed: number) => {
    if (changed === roomId) listener();
  };
  emitter.on('change', handler);
  return () => emitter.off('change', handler);
}
