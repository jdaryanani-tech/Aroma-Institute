import {
  META_PAGE_SUBSCRIBE_CONFIRM_ENV,
  META_PAGE_SUBSCRIBE_CONFIRM_VALUE,
  runMetaPageSubscription,
} from "../server/meta/page-subscription";

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--subscribe-page-leadgen";
const invalidArguments = args.length > 0 && !apply;

if (invalidArguments) {
  console.log(JSON.stringify({
    pageIdPresent: false,
    appIdPresent: false,
    pageAccessTokenPresent: false,
    graphApiVersionPresent: false,
    graphApiVersionValid: false,
    configurationReady: false,
    pageIdentityChecked: false,
    pageIdentityMatches: false,
    subscriptionChecked: false,
    appInstalled: false,
    leadgenSubscribed: false,
    postAttempted: false,
    postSucceeded: false,
    verificationChecked: false,
    verified: false,
    errorCategory: "invalid_arguments",
  }));
  process.exitCode = 2;
} else {
  const result = await runMetaPageSubscription(process.env, {
    apply,
    confirmationMatches:
      process.env[META_PAGE_SUBSCRIBE_CONFIRM_ENV] === META_PAGE_SUBSCRIBE_CONFIRM_VALUE,
  });
  console.log(JSON.stringify(result));
  if (result.errorCategory) process.exitCode = 1;
}

