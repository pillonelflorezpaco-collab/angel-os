// Creates the scrypt hash for the cockpit sign-in passphrase.
//   npm run guidehub:password        (prompts; input is hidden and never appears in argv or shell history)
// Put the printed value in GUIDEHUB_PASSWORD_HASH. Nothing is stored anywhere by this command.
import { createInterface } from "node:readline";
import { hashPassphrase, MIN_PASSPHRASE_CHARS } from "../guidehub/password.js";

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    process.stdout.write(question);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes("\n") || s.includes("\r")) write.call(rl, s); };
    rl.question("", (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const first = await ask(`Passphrase (min ${MIN_PASSPHRASE_CHARS} characters): `);
const second = await ask("Repeat: ");
if (first !== second) { console.error("The passphrases differ."); process.exit(1); }
try {
  console.log(`GUIDEHUB_PASSWORD_HASH='${await hashPassphrase(first)}'`);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Could not hash the passphrase.");
  process.exit(1);
}
