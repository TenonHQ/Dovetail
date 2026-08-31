import { Sinc } from "@tenonhq/dovetail-types";
import inquirer from "inquirer";
import { writeEnvVars } from "./FileUtils";

export async function getLoginInfo(): Promise<Sinc.LoginAnswers> {
  return await inquirer.prompt([
    {
      type: "input",
      name: "instance",
      message:
        "What instance would you like to connect to?(ex. test123.service-now.com)",
    },
    {
      type: "input",
      name: "username",
      message: "What is your username on that instance?",
    },
    {
      type: "password",
      name: "password",
      message: "What is your password on that instance?",
    },
    {
      type: "password",
      name: "apiKey",
      message:
        "Inbound API key (optional, Enter to skip — becomes the default auth when set)?",
    },
  ]);
}

export async function setupDotEnv(answers: Sinc.LoginAnswers) {
  process.env.SN_USER = answers.username;
  process.env.SN_PASSWORD = answers.password;
  process.env.SN_INSTANCE = answers.instance;

  var vars = [
    { key: "SN_USER", value: answers.username },
    { key: "SN_PASSWORD", value: answers.password },
    { key: "SN_INSTANCE", value: answers.instance },
  ];
  if (answers.apiKey) {
    process.env.SN_API_KEY = answers.apiKey;
    vars.push({ key: "SN_API_KEY", value: answers.apiKey });
  }

  writeEnvVars({ vars: vars });
}
