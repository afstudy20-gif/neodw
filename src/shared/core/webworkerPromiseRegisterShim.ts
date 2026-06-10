type Handler = (payload: unknown, emit: (eventName: string, payload: unknown) => void) => unknown;

const MESSAGE_RESULT = 0;
const MESSAGE_EVENT = 1;
const RESULT_ERROR = 0;
const RESULT_SUCCESS = 1;
const DEFAULT_HANDLER = 'main';

export class TransferableResponse {
  constructor(
    public payload: unknown,
    public transferable: Transferable[],
  ) {}
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as Promise<unknown>).then === 'function';
}

function registerWebworker(handler?: Handler) {
  const handlers = new Map<string, Handler>();
  if (handler) handlers.set(DEFAULT_HANDLER, handler);

  const api = {
    operation(name: string, operationHandler: Handler) {
      handlers.set(name, operationHandler);
      return api;
    },
    emit(eventName: string, ...args: unknown[]) {
      self.postMessage({ eventName, args });
      return api;
    },
  };

  const sendResult = (messageId: number, success: number, payload: unknown, transferable: Transferable[] = []) => {
    self.postMessage([MESSAGE_RESULT, messageId, success, payload], transferable);
  };

  const sendEvent = (messageId: number, eventName: string, payload: unknown) => {
    self.postMessage([MESSAGE_EVENT, messageId, eventName, payload]);
  };

  self.addEventListener('message', ({ data }) => {
    if (!Array.isArray(data)) return;
    const [messageId, payload, handlerName = DEFAULT_HANDLER] = data;
    const selectedHandler = handlers.get(handlerName);
    if (!selectedHandler) {
      sendResult(messageId, RESULT_ERROR, { message: `Not found handler for ${handlerName}` });
      return;
    }

    try {
      const result = selectedHandler(payload, (eventName, eventPayload) => sendEvent(messageId, eventName, eventPayload));
      const onSuccess = (value: unknown) => {
        if (value instanceof TransferableResponse) {
          sendResult(messageId, RESULT_SUCCESS, value.payload, value.transferable);
        } else {
          sendResult(messageId, RESULT_SUCCESS, value);
        }
      };
      isPromise(result) ? result.then(onSuccess).catch((error) => sendResult(messageId, RESULT_ERROR, error)) : onSuccess(result);
    } catch (error) {
      sendResult(messageId, RESULT_ERROR, error);
    }
  });

  return api;
}

registerWebworker.TransferableResponse = TransferableResponse;

export default registerWebworker;
