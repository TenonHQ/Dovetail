import { Sinc } from "@tenonhq/dovetail-types";
import sanitizePlugin from "./sanitizer";
export default function () {
  return {
    plugins: [sanitizePlugin],
  };
}
