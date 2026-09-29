/**
 * SMS delivery stub. No SMS gateway is connected yet, so messages are only logged.
 * To go live, replace the body with a call to your provider (e.g. SSL Wireless,
 * Twilio, BulkSMSBD) and keep the signature — nothing else needs to change.
 */
export async function sendSms(phone: string, message: string): Promise<void> {
  console.log(`[sms:stub] to ${phone}: ${message}`);
}
