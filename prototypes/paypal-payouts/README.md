# PROTOTYPE: PayPal sandbox payouts and subscriptions (throwaway)

Questions:
1. Can a cloud session reach PayPal's sandbox through the environment's network secret?
2. Can a Payouts batch go from the PlayCount business sandbox account to (a) an existing sandbox personal account and (b) an email with no PayPal account? What lifecycle does (b) show?
3. Can a PayPal Subscription (the developer's monthly **Budget**) be created and approved in the sandbox?

`probe.sh` runs each step with curl and saves raw responses to `out/` (git-ignored). Usage is at the top of the script.

## Verdict (2026-10-20): blocked at question 1

The proxy reaches PayPal, but PayPal rejects the stored credentials when the proxy asks for a token:

```
$ ./probe.sh auth
injection failed ("api-m.sandbox.paypal.com"): token endpoint said invalid_client; ask an admin to check this connection's settings
HTTP 502
```

`invalid_client` comes from PayPal's token endpoint, so the network path works and the problem is the credential itself or how it is sent. Likely causes, in order:
1. Client ID and Secret swapped, or copied with whitespace.
2. Keys from the **Live** tab instead of **Sandbox** on developer.paypal.com.
3. Client authentication sent in the request body; PayPal expects HTTP Basic. Switch the secret's client-auth method to Basic if the form offers it.

Fallback if the network secret still fails: store the sandbox keys as environment variables `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`; `probe.sh` then fetches its own token.

Questions 2 and 3 are not yet answered.
