import { setup } from "./server.mjs";
import { serve } from "../../dist/test-exports.js";
const fixture = await setup();
const app = await serve(43139, fixture.service);
let closed = false;
async function close() {
  if (closed) {
    return;
  }
  closed = true;
  clearTimeout(deadline);
  await app.close();
  await fixture.close();
}
const deadline = setTimeout(() => void close(), 10 * 60_000);
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.stdin.on("data", () => void close());
process.stdin.resume();
console.log(
  "Synthetic UI verification: http://127.0.0.1:43139 ; input any line to stop.",
);
