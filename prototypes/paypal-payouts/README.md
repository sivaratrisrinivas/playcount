# PROTOTYPE: PayPal sandbox payouts and subscriptions (throwaway)

Questions:
1. Can a cloud session reach PayPal's sandbox through the environment's network secret?
2. Can a Payouts batch go from the PlayCount business sandbox account to (a) an existing sandbox personal account and (b) an email with no PayPal account? What lifecycle does (b) show?
3. Can a PayPal Subscription (the developer's monthly **Budget**) be created and approved in the sandbox?

`probe.sh` runs each step with curl and saves raw responses to `out/` (git-ignored). Usage is at the top of the script.

## Verdict (2026-10-20 rerun)

### 1. Reaching the sandbox: yes

The `playcount` environment's network secret is type **Basic** (Client ID as username, Secret as password). The proxy adds Basic auth to every request to api-m.sandbox.paypal.com, and PayPal accepts it on API calls directly, with no token fetch. (The earlier OAuth-type secret failed because PayPal's token endpoint rejects client credentials sent in the request body: `invalid_client`.)

```
$ ./probe.sh auth
{"user_id":"https://www.paypal.com/webapps/auth/identity/user/3tNK…","sub":"…"}
HTTP 200
GET /v1/billing/plans?page_size=2  ->  {"plans":[],…}  HTTP 200
```

### 2. Payouts: yes, both cases

Batch `JU7U3Y9VYTYL8` ($3.21 to the sandbox personal account, $1.23 to an unregistered `@example.com` address):

```
POST /v1/payments/payouts  ->  HTTP 201  batch_status PENDING
GET  /v1/payments/payouts/JU7U3Y9VYTYL8 (25 s later)
  batch_status PROCESSING  amount 4.44 USD  fees 0.50 USD
  item sb-…@personal.example.com  transaction_status SUCCESS    payout_item_fee 0.25 USD
  item playcount-unclaimed-…@example.com  transaction_status UNCLAIMED  payout_item_fee 0.25 USD
    errors.name RECEIVER_UNREGISTERED
    "The recipient for this payout does not have an account. A link to sign up for an
     account was sent to the recipient. However, if the recipient does not claim this
     payout within 30 days, the funds will be returned to your account."
```

A one-item batch to an unregistered email (`NKCCB3UVQKM3W`) went PENDING → PROCESSING (item UNCLAIMED within 10 s) → batch SUCCESS with the item still UNCLAIMED.

What this means for PlayCount:
- **Fee is $0.25 per item** in the sandbox (US→US), paid by the sender. That is large next to small royalties, which supports the $1 rollover floor.
- **PayPal holds an UNCLAIMED payout for only 30 days**, then returns it. Our decision is to hold unclaimed royalties *indefinitely*. So PlayCount must keep unclaimed royalties in its own ledger and send a payout only after a maintainer claims (GitHub sign-in, push access) and gives a PayPal email. Never pay out to a guessed maintainer email.

### 3. Subscription: yes

```
POST /v1/catalogs/products   ->  HTTP 201  PROD-72R51407FB483140M
POST /v1/billing/plans       ->  HTTP 201  P-8CB64848S6168323KNLL3P5I  status ACTIVE  ($10/month)
POST /v1/billing/subscriptions -> HTTP 201  I-3LEKCLHWYE52  status APPROVAL_PENDING
     approve link: https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=…
```

Srinivas opened the approve link, logged in as the sandbox personal account, picked the sandbox bank, and subscribed. PayPal redirected to `return_url` with `?subscription_id=I-3LEKCLHWYE52&ba_token=…`. Then:

```
GET /v1/billing/subscriptions/I-3LEKCLHWYE52  ->  HTTP 200
  status ACTIVE  status_update_time 2026-10-20T18:57:36Z
  billing_info.last_payment 10.0 USD at 2026-10-20T18:57:35Z   (first month charged at approval)
  billing_info.next_billing_time 2026-11-20T10:00:00Z  failed_payments_count 0
```

Approval is a buyer step in the browser, so the PlayCount signup page must send the developer to the approve link (or use the JS SDK button) and read `subscription_id` on return. The first cycle is charged right away, so a new developer's Budget is funded at signup.
