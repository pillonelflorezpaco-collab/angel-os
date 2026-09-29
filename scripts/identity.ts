// Admin CLI for credentials. This is the only way a token or an external
// link comes into existence — no HTTP route can create either, so a client
// can never mint its own access.
//
//   npm run identity -- create-token <principalId> <INTERFACE> <label>
//   npm run identity -- revoke-token <principalId> <tokenId>
//   npm run identity -- link         <principalId> <INTERFACE> <externalId> [label]
//   npm run identity -- unlink       <principalId> <linkId>
//   npm run identity -- list         <principalId>
//
// create-token prints the token ONCE, to this terminal. It is never stored
// in plaintext and cannot be shown again.
import { getApiTokenService, getExternalIdentityService, INTERFACE_SOURCES } from "../identity/index.js";
import { disconnectDb } from "../db/client/index.js";

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "create-token": {
      const [principalId, interfaceSource, ...label] = args;
      if (!principalId || !interfaceSource || !label.length) return usage();
      const { id, token } = await getApiTokenService().create({ principalId, interfaceSource, label: label.join(" ") });
      console.log(`Token id: ${id}\nToken (shown once, store it now):\n${token}`);
      return;
    }
    case "revoke-token": {
      const [principalId, id] = args;
      if (!principalId || !id) return usage();
      console.log((await getApiTokenService().revoke(principalId, id)) ? "Revoked." : "No active token with that id for that principal.");
      return;
    }
    case "link": {
      const [principalId, interfaceSource, externalId, ...label] = args;
      if (!principalId || !interfaceSource || !externalId) return usage();
      const { id } = await getExternalIdentityService().link({ principalId, interfaceSource, externalId, label: label.join(" ") || undefined });
      console.log(`Linked. Link id: ${id}`);
      return;
    }
    case "unlink": {
      const [principalId, id] = args;
      if (!principalId || !id) return usage();
      console.log((await getExternalIdentityService().unlink(principalId, id)) ? "Unlinked." : "No active link with that id for that principal.");
      return;
    }
    case "list": {
      const [principalId] = args;
      if (!principalId) return usage();
      console.log("API tokens:", await getApiTokenService().list(principalId));
      console.log("External identities:", await getExternalIdentityService().list(principalId));
      return;
    }
    default:
      return usage();
  }
}

function usage() {
  console.error(`Usage: identity <create-token|revoke-token|link|unlink|list> ...\nINTERFACE is one of: ${INTERFACE_SOURCES.join(", ")}`);
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : "Failed.");
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
