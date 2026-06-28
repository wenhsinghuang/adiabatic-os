import { startConnect, handleCallback } from "./connect";
import { metadata } from "./metadata";
import { handleProxy } from "./proxy";

export default {
  metadata,
  connect: {
    start: startConnect,
    callback: handleCallback,
  },
  proxy: handleProxy,
};
