import { Sinc } from "@tenonhq/dovetail-types";
import * as sass from "sass";
const run: Sinc.PluginFunc = async function(
  context: Sinc.FileContext,
  content: string,
  options: any
): Promise<Sinc.PluginResults> {
  try {
    let res = sass.compile(context.filePath);
    return {
      output: res.css,
      success: true
    };
  } catch (e) {
    throw e;
  }
};

export { run };
