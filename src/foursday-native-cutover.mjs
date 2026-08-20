import {
  assertHermesShadowAcceptance,
  hermesCutoverConfirmation,
} from "./hermes-cutover.mjs";

export const removeFoursdayProfileConfirmation = "REMOVE-FOURSDAY-PROFILE";

export function authorizeFoursdayNativeGatewayAction(action, {
  apply = false,
  releaseSha = null,
  acceptance = null,
  confirmation = null,
  now = new Date(),
} = {}) {
  if (action === "activate") {
    const verified = assertHermesShadowAcceptance(acceptance, { releaseSha, now });
    const expectedConfirmation = hermesCutoverConfirmation(verified);
    if (apply && confirmation !== expectedConfirmation) {
      throw new Error("Native Hermes activation confirmation does not match shadow evidence");
    }
    return {
      gated: true,
      releaseSha: verified.releaseSha,
      scenarioCount: verified.scenarioCount,
      evidenceDigest: verified.evidenceDigest,
      confirmation: expectedConfirmation,
    };
  }
  if (
    action === "remove-profile" &&
    apply &&
    confirmation !== removeFoursdayProfileConfirmation
  ) {
    throw new Error("Foursday profile removal requires the exact confirmation");
  }
  return {
    gated: action === "remove-profile",
    confirmation: action === "remove-profile"
      ? removeFoursdayProfileConfirmation
      : null,
  };
}
