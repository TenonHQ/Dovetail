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
  ]);
}

export async function setupDotEnv(answers: Sinc.LoginAnswers) {
  process.env.SN_USER = answers.username;
  process.env.SN_PASSWORD = answers.password;
  process.env.SN_INSTANCE = answers.instance;

  writeEnvVars({
    vars: [
      { key: "SN_USER", value: answers.username },
      { key: "SN_PASSWORD", value: answers.password },
      { key: "SN_INSTANCE", value: answers.instance },
    ],
  });
}
