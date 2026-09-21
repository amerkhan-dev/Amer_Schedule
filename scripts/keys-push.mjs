/* Prints a VAPID key pair for web push. Put the two lines in .env (and in your
 * host's environment settings), then restart the server. */
import webpush from "web-push";
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
