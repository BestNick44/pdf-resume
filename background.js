import { createPositionUpdateMessageHandler } from "./shared/position-update-messaging.mjs";
import { updatePosition } from "./storage/books.mjs";

const runtime = globalThis.chrome?.runtime;
if (runtime?.onMessage?.addListener && runtime.id) {
  runtime.onMessage.addListener(
    createPositionUpdateMessageHandler({ extensionId: runtime.id, updatePosition }),
  );
}
