# Webhook Tokens

[Home](../../index.md) / Webhook Tokens

URL: [https://sohohome.com/cp/ais-webhooks-tokens-admin](https://sohohome.com/cp/ais-webhooks-tokens-admin)

Webhook Tokens are bearer tokens used to authorise incoming AIS webhook requests before the site accepts the data they send.

![Webhook Tokens overview](images/page-desktop.png)

*Webhook Tokens page overview*

## Related Pages

- [Edit Webhook Token](../014-cp-ais-webhooks-tokens-admin-edit-1-17da0623/README.md): Open an existing webhook token when you need to check the setup or make a change.

## How It Works

- Incoming webhook calls must send the token as a bearer token. The request is rejected unless the token is active and belongs to the current environment.
- Each token can be limited to selected webhook services, so access can be granted for only the AIS feeds that need it.
- Refreshing a token generates a replacement value. Any external system using the old value must be updated afterwards.
- Revoking a token marks it inactive, which stops future webhook requests from authenticating with it.
- Last Accessed is updated after a successful request, which helps confirm whether a webhook integration is still using the token.

## Using This Page

1. Open Webhook Tokens from the CP navigation.
2. Search or filter until you find the webhook token you need.

## What You Can Do

### Review webhook tokens

Search or filter the visible fields to find the webhook token you need.

- Field: Name
- Field: Environment
- Field: Status
- Field: Last Accessed
- Field: Created
- Field: Updated

Example rows:

| Name | Environment | Status | Last Accessed | Created | Updated |
| --- | --- | --- | --- | --- | --- |
| The Nav People - Production | Production | Active | 1:01am - 26 Jun 26 | 12:31pm - 25 Jul 24 | 4:06pm - 25 Jul 24 |
| Postman - Local | Local | Inactive |  | 3:34pm - 29 Jul 24 | 3:35pm - 29 Jul 24 |
| The Nav People - Staging | Staging | Active |  | 4:40pm - 19 May 25 | 4:40pm - 19 May 25 |
