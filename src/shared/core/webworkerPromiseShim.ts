type PendingMessage = [
  resolve: (value: unknown) => void,
  reject: (reason?: unknown) => void,
  onEvent?: (eventName: string, data: unknown) => void,
];

const MESSAGE_RESULT = 0;
const MESSAGE_EVENT = 1;
const RESULT_SUCCESS = 1;

export default class WebworkerPromise {
  private messageId = 1;
  private messages = new Map<number, PendingMessage>();
  private worker: Worker;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = this.onMessage;
  }

  terminate() {
    this.worker.terminate();
  }

  isFree() {
    return this.messages.size === 0;
  }

  jobsLength() {
    return this.messages.size;
  }

  exec(operationName: string, data: unknown = null, transferable: Transferable[] = [], onEvent?: PendingMessage[2]) {
    return this.send([this.messageId, data, operationName], transferable, onEvent);
  }

  postMessage(data: unknown = null, transferable: Transferable[] = [], onEvent?: PendingMessage[2]) {
    return this.send([this.messageId, data], transferable, onEvent);
  }

  emit(eventName: string, ...args: unknown[]) {
    this.worker.postMessage({ eventName, args });
  }

  private send(message: [number, unknown, string?], transferable: Transferable[], onEvent?: PendingMessage[2]) {
    const id = this.messageId++;
    message[0] = id;
    return new Promise((resolve, reject) => {
      this.messages.set(id, [resolve, reject, onEvent]);
      this.worker.postMessage(message, transferable);
    });
  }

  private onMessage = (event: MessageEvent) => {
    if (!Array.isArray(event.data)) return;
    const [type, messageId, statusOrEventName, payload] = event.data;
    const pending = this.messages.get(messageId);
    if (!pending) return;

    if (type === MESSAGE_EVENT) {
      pending[2]?.(statusOrEventName, payload);
      return;
    }

    if (type === MESSAGE_RESULT) {
      this.messages.delete(messageId);
      const [resolve, reject] = pending;
      statusOrEventName === RESULT_SUCCESS ? resolve(payload) : reject(payload);
    }
  };
}
