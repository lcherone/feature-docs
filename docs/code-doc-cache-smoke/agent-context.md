# Soho Home CP Feature Docs Agent Context

Generated: 2026-06-28T01:11:50.818Z

Use this file as the handoff for Codex to produce final operator documentation. Read the referenced controller, model, XML, and view files before finalising page purpose, field behaviour, validation, and side effects.

## AIS Webhook Token

- URL: https://dev.soho-home.local/cp/ais-webhooks-tokens-admin
- Documentation route key: https://dev.soho-home.local|cp|ais-webhooks-tokens-admin|index|ais-webhooks-tokens-admin
- Draft doc: pages/001-cp-ais-webhooks-tokens-admin-a0f873de/README.md
- Code analysis doc: .vscode/code-docs/cp-ais-webhooks-tokens-admin.md
- Page screenshots: pages/001-cp-ais-webhooks-tokens-admin-a0f873de/images/page-desktop.png
- Field count: 1
- Controller: D3R\AISWebhooks\Controllers\TokenControllerAdmin (ais-webhooks-tokens-admin)
- Controller file: vendor/d3r/ais-webhooks/src/Controllers/TokenControllerAdmin.php
- Action method: indexAction (inherited or unresolved)
- Model: AIS_Webhooks_Token => D3R\AISWebhooks\Model\Token
- Model file: vendor/d3r/ais-webhooks/src/Model/Token.php
- Model XML: vendor/d3r/ais-webhooks/src/Model/Token.xml
- Model item prefix: token

### DOM Fields

- 1. Keyword search (text)
  - DOM name: `search`
  - Screenshot: pages/001-cp-ais-webhooks-tokens-admin-a0f873de/images/field-001-keyword-search.png

### Source References

- provider: vendor/d3r/ais-webhooks/src/Provider.php
- controller: vendor/d3r/ais-webhooks/src/Controllers/TokenControllerAdmin.php
- referenced-class: vendor/d3r/webhooks/src/Event/EventEmitter.php
- referenced-class: vendor/d3r/ais-webhooks/src/Authentication/Middleware.php
- model: vendor/d3r/ais-webhooks/src/Model/Token.php
- model-xml: vendor/d3r/ais-webhooks/src/Model/Token.xml
